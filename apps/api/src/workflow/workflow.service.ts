import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import type {
  DelegationDto,
  WorkflowDefinitionDto,
  WorkflowInstanceDto,
  WorkflowTaskDto,
} from '@hrms/shared';
import type { z } from 'zod';
import type { delegationInput, workflowStepsInput } from '@hrms/shared';
import { DATABASE } from '../common/tokens.js';
import type { Database, Tx } from '../db/database.js';
import {
  employee,
  roleAssignment,
  userAccount,
  workflowDefinition,
  workflowDelegation,
  workflowInstance,
  workflowStep,
  workflowTask,
} from '../db/schema.js';
import { ApiError } from '../common/errors.js';
import { uuidv7 } from '../common/ids.js';
import type { Principal } from '../access/principal.js';
import { AuditService } from '../audit/audit.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';

type InstanceRow = typeof workflowInstance.$inferSelect;
type StepRow = typeof workflowStep.$inferSelect;

/** Implemented by modules whose records go through approval (leave, corrections, …). */
export interface WorkflowSubjectHandler {
  /** Called inside the deciding transaction when the instance reaches a final state. */
  onCompleted(tx: Tx, instance: InstanceRow, outcome: 'approved' | 'rejected' | 'cancelled'): Promise<void>;
  /** In-app link to the subject, for notifications. */
  link(instance: InstanceRow): string;
}

export interface StartInput {
  definitionKey: string;
  companyId: string;
  subjectType: string;
  subjectId: string;
  subjectEmployeeId?: string | null;
  summary?: Record<string, unknown>;
  /** Further users who may not approve (e.g. everyone who prepared a payroll). */
  excludeUserIds?: string[];
}

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Generic approval engine (D-17). Approvers are resolved per step by relationship (direct
 * manager), role within the subject's company, or a specific user; active delegations are
 * honoured; nobody approves their own request.
 */
@Injectable()
export class WorkflowService {
  private readonly handlers = new Map<string, WorkflowSubjectHandler>();

  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
  ) {}

  registerHandler(subjectType: string, handler: WorkflowSubjectHandler): void {
    this.handlers.set(subjectType, handler);
  }

  // --- engine --------------------------------------------------------------------------

  /** Start an approval inside the caller's transaction (the subject is created in the same tx). */
  async start(tx: Tx, principal: Principal, input: StartInput): Promise<InstanceRow> {
    const [def] = await tx.select().from(workflowDefinition).where(eq(workflowDefinition.key, input.definitionKey));
    if (!def) throw new Error(`Unknown workflow ${input.definitionKey}`);
    const steps = await this.steps(tx, def.id);
    const excluded = await this.excludedUsers(tx, principal.userId, input.subjectEmployeeId ?? null, input.excludeUserIds ?? [], null);

    // Refuse requests that could never be approved by anyone (prevents silent auto-approval).
    let resolvable = 0;
    for (const s of steps) {
      const users = await this.resolve(tx, s, input.companyId, input.subjectEmployeeId ?? null, excluded);
      if (users.length) resolvable++;
      else if (!s.skipIfUnresolved) {
        throw new ApiError(409, 'CONFLICT', `No approver is available for the step "${s.nameEn}"`, {
          meta: { step: s.seq },
        });
      }
    }
    if (!resolvable) throw new ApiError(409, 'CONFLICT', 'No approver is available for this request');

    const [inst] = await tx
      .insert(workflowInstance)
      .values({
        id: uuidv7(),
        definitionId: def.id,
        companyId: input.companyId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        subjectEmployeeId: input.subjectEmployeeId ?? null,
        requesterUserId: principal.userId,
        excludedUserIds: [...new Set(input.excludeUserIds ?? [])],
        summary: input.summary ?? {},
      })
      .returning();
    await this.audit.record(tx, {
      action: 'workflow.started',
      entityType: 'workflow_instance',
      entityId: inst!.id,
      companyId: input.companyId,
      details: { definition: def.key, subjectType: input.subjectType, subjectId: input.subjectId },
    });
    return this.advance(tx, inst!, 1, def.nameAr, def.nameEn);
  }

  private async steps(tx: Tx, definitionId: string): Promise<StepRow[]> {
    return tx.select().from(workflowStep).where(eq(workflowStep.definitionId, definitionId)).orderBy(asc(workflowStep.seq));
  }

  /** Requester and the subject employee's own account can never approve. */
  /**
   * Who may not approve: the requester, the subject employee's own account, users listed on the
   * request, and anyone who already decided a step of it (one decision per person).
   */
  private async excludedUsers(tx: Tx, requesterUserId: string, subjectEmployeeId: string | null, extra: string[], instanceId: string | null): Promise<Set<string>> {
    const ex = new Set([requesterUserId, ...extra]);
    if (instanceId) {
      const decided = await tx.select({ by: workflowTask.decidedBy }).from(workflowTask).where(eq(workflowTask.instanceId, instanceId));
      for (const d of decided) if (d.by) ex.add(d.by);
    }
    if (subjectEmployeeId) {
      const [u] = await tx.select({ id: userAccount.id }).from(userAccount).where(eq(userAccount.employeeId, subjectEmployeeId));
      if (u) ex.add(u.id);
    }
    return ex;
  }

  private async resolve(
    tx: Tx,
    step: StepRow,
    companyId: string,
    subjectEmployeeId: string | null,
    excluded: Set<string>,
  ): Promise<{ assignee: string; delegatedFrom: string | null }[]> {
    const result = await tx.execute<{ id: string }>(
      sql`select workflow_resolve_approvers(${step.approverRule}, ${step.roleKey}, ${step.userId}, ${companyId}, ${subjectEmployeeId}) as id`,
    );
    const ids = (result as unknown as { rows: { id: string }[] }).rows.map((r) => r.id);
    const out: { assignee: string; delegatedFrom: string | null }[] = [];
    for (const id of ids) {
      const [d] = await tx
        .select({ to: workflowDelegation.toUserId })
        .from(workflowDelegation)
        .innerJoin(userAccount, eq(userAccount.id, workflowDelegation.toUserId))
        .where(
          and(
            eq(workflowDelegation.fromUserId, id),
            isNull(workflowDelegation.revokedAt),
            lte(workflowDelegation.validFrom, today()),
            gte(workflowDelegation.validTo, today()),
            eq(userAccount.status, 'active'),
          ),
        )
        .limit(1);
      const assignee = d?.to ?? id;
      if (excluded.has(assignee)) continue;
      if (!out.some((o) => o.assignee === assignee)) out.push({ assignee, delegatedFrom: d ? id : null });
    }
    return out;
  }

  /** Create tasks for the next resolvable step at or after `fromSeq`, or complete. */
  private async advance(tx: Tx, inst: InstanceRow, fromSeq: number, nameAr: string, nameEn: string): Promise<InstanceRow> {
    const steps = (await this.steps(tx, inst.definitionId)).filter((s) => s.seq >= fromSeq);
    const excluded = await this.excludedUsers(tx, inst.requesterUserId, inst.subjectEmployeeId, inst.excludedUserIds, inst.id);
    for (const s of steps) {
      const users = await this.resolve(tx, s, inst.companyId, inst.subjectEmployeeId, excluded);
      if (!users.length) {
        await tx.insert(workflowTask).values({
          id: uuidv7(),
          instanceId: inst.id,
          seq: s.seq,
          status: s.skipIfUnresolved ? 'skipped' : 'pending',
          comment: s.skipIfUnresolved ? 'No approver available; step skipped' : 'No approver available',
        });
        if (s.skipIfUnresolved) continue;
        // Unresolvable mandatory step: the request waits (visible to the company's HR).
        const [u] = await tx.update(workflowInstance).set({ currentSeq: s.seq }).where(eq(workflowInstance.id, inst.id)).returning();
        return u!;
      }
      await tx.insert(workflowTask).values(
        users.map((u) => ({
          id: uuidv7(),
          instanceId: inst.id,
          seq: s.seq,
          assigneeUserId: u.assignee,
          delegatedFromUserId: u.delegatedFrom,
        })),
      );
      const [u] = await tx.update(workflowInstance).set({ currentSeq: s.seq }).where(eq(workflowInstance.id, inst.id)).returning();
      await this.notifications.notify(tx, {
        userIds: users.map((x) => x.assignee),
        companyId: inst.companyId,
        eventType: 'workflow.task_assigned',
        title: { ar: `طلب بانتظار موافقتك: ${nameAr}`, en: `Awaiting your approval: ${nameEn}` },
        link: '/tasks',
        entityType: 'workflow_instance',
        entityId: inst.id,
      });
      return u!;
    }
    return this.complete(tx, inst, 'approved', nameAr, nameEn);
  }

  private async complete(
    tx: Tx,
    inst: InstanceRow,
    outcome: 'approved' | 'rejected' | 'cancelled',
    nameAr: string,
    nameEn: string,
  ): Promise<InstanceRow> {
    await tx
      .update(workflowTask)
      .set({ status: 'cancelled' })
      .where(and(eq(workflowTask.instanceId, inst.id), eq(workflowTask.status, 'pending')));
    const [done] = await tx
      .update(workflowInstance)
      .set({ status: outcome, completedAt: new Date() })
      .where(eq(workflowInstance.id, inst.id))
      .returning();
    const handler = this.handlers.get(inst.subjectType);
    if (handler) await handler.onCompleted(tx, done!, outcome);
    if (outcome !== 'cancelled') {
      const labels = outcome === 'approved' ? { ar: 'تمت الموافقة', en: 'Approved' } : { ar: 'تم الرفض', en: 'Rejected' };
      await this.notifications.notify(tx, {
        userIds: [inst.requesterUserId],
        companyId: inst.companyId,
        eventType: `workflow.${outcome}`,
        title: { ar: `${labels.ar}: ${nameAr}`, en: `${labels.en}: ${nameEn}` },
        link: handler ? handler.link(done!) : '/tasks?tab=mine',
        entityType: 'workflow_instance',
        entityId: inst.id,
      });
    }
    await this.audit.record(tx, {
      action: `workflow.${outcome}`,
      entityType: 'workflow_instance',
      entityId: inst.id,
      companyId: inst.companyId,
    });
    return done!;
  }

  async decide(principal: Principal, taskId: string, decision: 'approve' | 'reject', comment?: string): Promise<WorkflowInstanceDto> {
    const instanceId = await this.database.tx(principal.rls(), async (tx) => {
      const [task] = await tx.select().from(workflowTask).where(eq(workflowTask.id, taskId)).for('update');
      if (!task || task.assigneeUserId !== principal.userId) throw ApiError.notFound('Task');
      if (task.status !== 'pending') throw ApiError.conflict('This task has already been decided');
      const [inst] = await tx.select().from(workflowInstance).where(eq(workflowInstance.id, task.instanceId)).for('update');
      if (!inst || inst.status !== 'pending' || inst.currentSeq !== task.seq) {
        throw ApiError.conflict('This request is no longer awaiting this step');
      }
      if (inst.requesterUserId === principal.userId || inst.excludedUserIds.includes(principal.userId)) {
        throw ApiError.forbidden('You cannot approve this request');
      }
      const earlier = await tx
        .select({ id: workflowTask.id })
        .from(workflowTask)
        .where(and(eq(workflowTask.instanceId, inst.id), eq(workflowTask.decidedBy, principal.userId)));
      if (earlier.length) throw ApiError.forbidden('You already decided another step of this request');
      if (decision === 'reject' && !comment?.trim()) {
        throw ApiError.validation([{ path: 'comment', message: 'A reason is required when rejecting' }]);
      }
      const [def] = await tx.select().from(workflowDefinition).where(eq(workflowDefinition.id, inst.definitionId));
      await tx
        .update(workflowTask)
        .set({
          status: decision === 'approve' ? 'approved' : 'rejected',
          decidedAt: new Date(),
          decidedBy: principal.userId,
          comment: comment?.trim() || null,
        })
        .where(eq(workflowTask.id, taskId));
      // Parallel assignees of the same step: the first decision wins.
      await tx
        .update(workflowTask)
        .set({ status: 'cancelled' })
        .where(and(eq(workflowTask.instanceId, inst.id), eq(workflowTask.seq, task.seq), eq(workflowTask.status, 'pending')));
      await this.audit.record(tx, {
        action: `workflow.task_${decision === 'approve' ? 'approved' : 'rejected'}`,
        entityType: 'workflow_instance',
        entityId: inst.id,
        companyId: inst.companyId,
        details: { step: task.seq, comment: comment ?? null, delegatedFrom: task.delegatedFromUserId },
      });
      if (decision === 'reject') await this.complete(tx, inst, 'rejected', def!.nameAr, def!.nameEn);
      else await this.advance(tx, inst, task.seq + 1, def!.nameAr, def!.nameEn);
      return inst.id;
    });
    return this.getInstance(principal, instanceId);
  }

  async cancel(principal: Principal, instanceId: string): Promise<WorkflowInstanceDto> {
    await this.database.tx(principal.rls(), async (tx) => {
      const [inst] = await tx.select().from(workflowInstance).where(eq(workflowInstance.id, instanceId)).for('update');
      if (!inst || inst.requesterUserId !== principal.userId) throw ApiError.notFound('Request');
      if (inst.status !== 'pending') throw ApiError.conflict('Only pending requests can be cancelled');
      const [def] = await tx.select().from(workflowDefinition).where(eq(workflowDefinition.id, inst.definitionId));
      await this.complete(tx, inst, 'cancelled', def!.nameAr, def!.nameEn);
    });
    return this.getInstance(principal, instanceId);
  }

  /** Cancels a pending instance inside the caller's transaction; the caller has authorised it. */
  async cancelWithin(tx: Tx, instanceId: string): Promise<void> {
    const [inst] = await tx.select().from(workflowInstance).where(eq(workflowInstance.id, instanceId)).for('update');
    if (!inst) throw ApiError.notFound('Request');
    if (inst.status !== 'pending') throw ApiError.conflict('Only pending requests can be cancelled');
    const [def] = await tx.select().from(workflowDefinition).where(eq(workflowDefinition.id, inst.definitionId));
    await this.complete(tx, inst, 'cancelled', def!.nameAr, def!.nameEn);
  }

  // --- queries ---------------------------------------------------------------------------

  async myTasks(principal: Principal, status: 'pending' | 'decided'): Promise<WorkflowInstanceDto[]> {
    const ids = await this.database.tx(principal.rls(), async (tx) => {
      const rows = await tx
        .selectDistinct({ id: workflowTask.instanceId, created: workflowTask.createdAt })
        .from(workflowTask)
        .where(
          and(
            status === 'pending'
              ? and(eq(workflowTask.assigneeUserId, principal.userId), eq(workflowTask.status, 'pending'))
              : eq(workflowTask.decidedBy, principal.userId),
          ),
        )
        .orderBy(desc(workflowTask.createdAt))
        .limit(100);
      return [...new Set(rows.map((r) => r.id))];
    });
    return this.instancesByIds(principal, ids);
  }

  async myRequests(principal: Principal): Promise<WorkflowInstanceDto[]> {
    const ids = await this.database.tx(principal.rls(), async (tx) =>
      (
        await tx
          .select({ id: workflowInstance.id })
          .from(workflowInstance)
          .where(eq(workflowInstance.requesterUserId, principal.userId))
          .orderBy(desc(workflowInstance.createdAt))
          .limit(100)
      ).map((r) => r.id),
    );
    return this.instancesByIds(principal, ids);
  }

  async companyInstances(principal: Principal, opts: { status?: string | undefined }): Promise<WorkflowInstanceDto[]> {
    const scope = principal.scope('workflow.instances.view');
    if (!scope.all && !scope.companyIds.length) return [];
    const ids = await this.database.tx(principal.rls(), async (tx) =>
      (
        await tx
          .select({ id: workflowInstance.id })
          .from(workflowInstance)
          .where(
            and(
              scope.all ? undefined : inArray(workflowInstance.companyId, scope.companyIds),
              opts.status ? eq(workflowInstance.status, opts.status as InstanceRow['status']) : undefined,
            ),
          )
          .orderBy(desc(workflowInstance.createdAt))
          .limit(200)
      ).map((r) => r.id),
    );
    return this.instancesByIds(principal, ids);
  }

  async getInstance(principal: Principal, id: string): Promise<WorkflowInstanceDto> {
    const [dto] = await this.instancesByIds(principal, [id]);
    if (!dto) throw ApiError.notFound('Request');
    return dto;
  }

  private async instancesByIds(principal: Principal, ids: string[]): Promise<WorkflowInstanceDto[]> {
    if (!ids.length) return [];
    return this.database.tx(principal.rls(), async (tx) => {
      const insts = await tx
        .select({ i: workflowInstance, d: workflowDefinition })
        .from(workflowInstance)
        .innerJoin(workflowDefinition, eq(workflowDefinition.id, workflowInstance.definitionId))
        .where(inArray(workflowInstance.id, ids));
      if (!insts.length) return [];
      const tasks = await tx
        .select()
        .from(workflowTask)
        .where(inArray(workflowTask.instanceId, insts.map((x) => x.i.id)))
        .orderBy(asc(workflowTask.seq), asc(workflowTask.createdAt));
      const steps = await tx
        .select()
        .from(workflowStep)
        .where(inArray(workflowStep.definitionId, [...new Set(insts.map((x) => x.d.id))]));
      const userIds = [...new Set([...insts.map((x) => x.i.requesterUserId), ...tasks.map((t) => t.assigneeUserId).filter((x): x is string => !!x)])];
      const users = userIds.length
        ? await tx.select({ id: userAccount.id, name: userAccount.displayName }).from(userAccount).where(inArray(userAccount.id, userIds))
        : [];
      const empIds = insts.map((x) => x.i.subjectEmployeeId).filter((x): x is string => !!x);
      const emps = empIds.length
        ? await tx.select({ id: employee.id, ar: employee.fullNameAr, en: employee.fullNameEn }).from(employee).where(inArray(employee.id, empIds))
        : [];
      const name = (id: string | null) => users.find((u) => u.id === id)?.name ?? null;
      const byOrder = new Map(ids.map((id, n) => [id, n]));
      return insts
        .sort((a, b) => (byOrder.get(a.i.id) ?? 0) - (byOrder.get(b.i.id) ?? 0))
        .map(({ i, d }) => {
          const e = emps.find((x) => x.id === i.subjectEmployeeId);
          return {
            id: i.id,
            definitionKey: d.key,
            definitionNameAr: d.nameAr,
            definitionNameEn: d.nameEn,
            companyId: i.companyId,
            subjectType: i.subjectType,
            subjectId: i.subjectId,
            subjectEmployeeId: i.subjectEmployeeId,
            subjectEmployeeName: e ? { ar: e.ar, en: e.en } : null,
            summary: i.summary,
            requesterUserId: i.requesterUserId,
            requesterName: name(i.requesterUserId) ?? '',
            status: i.status,
            currentSeq: i.currentSeq,
            createdAt: i.createdAt.toISOString(),
            completedAt: i.completedAt?.toISOString() ?? null,
            tasks: tasks
              .filter((t) => t.instanceId === i.id)
              .map((t): WorkflowTaskDto => {
                const st = steps.find((s) => s.definitionId === d.id && s.seq === t.seq);
                return {
                  id: t.id,
                  instanceId: t.instanceId,
                  seq: t.seq,
                  stepNameAr: st?.nameAr ?? '',
                  stepNameEn: st?.nameEn ?? '',
                  status: t.status,
                  assigneeUserId: t.assigneeUserId,
                  assigneeName: name(t.assigneeUserId),
                  delegatedFromUserId: t.delegatedFromUserId,
                  decidedAt: t.decidedAt?.toISOString() ?? null,
                  comment: t.comment,
                  createdAt: t.createdAt.toISOString(),
                };
              }),
          };
        });
    });
  }

  // --- definitions ---------------------------------------------------------------------------

  async definitions(principal: Principal): Promise<WorkflowDefinitionDto[]> {
    return this.database.tx(principal.rls(), async (tx) => {
      const defs = await tx.select().from(workflowDefinition).orderBy(asc(workflowDefinition.key));
      const steps = await tx.select().from(workflowStep).orderBy(asc(workflowStep.seq));
      return defs.map((d) => ({
        id: d.id,
        key: d.key,
        subjectType: d.subjectType,
        nameAr: d.nameAr,
        nameEn: d.nameEn,
        locked: d.locked,
        version: d.version,
        steps: steps
          .filter((s) => s.definitionId === d.id)
          .map((s) => ({
            seq: s.seq,
            approverRule: s.approverRule,
            roleKey: s.roleKey,
            userId: s.userId,
            skipIfUnresolved: s.skipIfUnresolved,
            nameAr: s.nameAr,
            nameEn: s.nameEn,
          })),
      }));
    });
  }

  async updateSteps(principal: Principal, id: string, input: z.infer<typeof workflowStepsInput>): Promise<void> {
    await this.database.tx(principal.rls(), async (tx) => {
      const [def] = await tx.select().from(workflowDefinition).where(eq(workflowDefinition.id, id));
      if (!def) throw ApiError.notFound('Workflow');
      if (def.locked) throw ApiError.conflict('This approval route is fixed by the specification and cannot be changed here');
      if (!input.steps.some((s) => !s.skipIfUnresolved)) {
        throw ApiError.validation([{ path: 'steps', message: 'At least one step must be mandatory (not skippable)' }]);
      }
      const [updated] = await tx
        .update(workflowDefinition)
        .set({ updatedBy: principal.userId })
        .where(and(eq(workflowDefinition.id, id), eq(workflowDefinition.version, input.version)))
        .returning();
      if (!updated) throw ApiError.versionConflict();
      const before = await this.steps(tx, id);
      await tx.delete(workflowStep).where(eq(workflowStep.definitionId, id));
      await tx.insert(workflowStep).values(
        input.steps.map((s, n) => ({
          id: uuidv7(),
          definitionId: id,
          seq: n + 1,
          approverRule: s.approverRule,
          roleKey: s.approverRule === 'role_in_company' ? (s.roleKey ?? null) : null,
          userId: s.approverRule === 'specific_user' ? (s.userId ?? null) : null,
          skipIfUnresolved: s.skipIfUnresolved,
          nameAr: s.nameAr,
          nameEn: s.nameEn,
        })),
      );
      await this.audit.record(tx, {
        action: 'workflow.definition_updated',
        entityType: 'workflow_definition',
        entityId: id,
        before: before.map((s) => ({ seq: s.seq, rule: s.approverRule, role: s.roleKey })),
        after: input.steps.map((s, n) => ({ seq: n + 1, rule: s.approverRule, role: s.roleKey ?? null })),
      });
    });
  }

  // --- delegation ----------------------------------------------------------------------------

  /** Possible delegates: active colleagues in the user's companies (names only). */
  async delegateCandidates(principal: Principal): Promise<{ id: string; displayName: string }[]> {
    const scope = principal.rls();
    return this.database.tx(scope, async (tx) => {
      const rows = await tx
        .selectDistinct({ id: userAccount.id, displayName: userAccount.displayName })
        .from(userAccount)
        .innerJoin(roleAssignment, eq(roleAssignment.userId, userAccount.id))
        .where(
          and(
            eq(userAccount.status, 'active'),
            isNull(roleAssignment.endedAt),
            scope.group ? undefined : inArray(roleAssignment.companyId, scope.companyIds.length ? [...scope.companyIds] : ['00000000-0000-0000-0000-000000000000']),
          ),
        )
        .orderBy(asc(userAccount.displayName))
        .limit(300);
      return rows.filter((r) => r.id !== principal.userId);
    });
  }

  async myDelegations(principal: Principal): Promise<DelegationDto[]> {
    return this.database.tx(principal.rls(), async (tx) => {
      const rows = await tx
        .select({ d: workflowDelegation, name: userAccount.displayName })
        .from(workflowDelegation)
        .innerJoin(userAccount, eq(userAccount.id, workflowDelegation.toUserId))
        .where(eq(workflowDelegation.fromUserId, principal.userId))
        .orderBy(desc(workflowDelegation.createdAt));
      return rows.map(({ d, name }) => ({
        id: d.id,
        fromUserId: d.fromUserId,
        toUserId: d.toUserId,
        toUserName: name,
        validFrom: d.validFrom,
        validTo: d.validTo,
        revokedAt: d.revokedAt?.toISOString() ?? null,
      }));
    });
  }

  async delegate(principal: Principal, input: z.infer<typeof delegationInput>): Promise<void> {
    if (input.toUserId === principal.userId) throw ApiError.validation([{ path: 'toUserId', message: 'Choose another person' }]);
    if (input.validTo < input.validFrom) throw ApiError.validation([{ path: 'validTo', message: 'Must not be before the start' }]);
    await this.database.tx(principal.rls(), async (tx) => {
      const [u] = await tx.select().from(userAccount).where(eq(userAccount.id, input.toUserId));
      if (!u || u.status !== 'active') throw ApiError.validation([{ path: 'toUserId', message: 'Unknown or inactive user' }]);
      const overlapping = await tx
        .select({ id: workflowDelegation.id })
        .from(workflowDelegation)
        .where(
          and(
            eq(workflowDelegation.fromUserId, principal.userId),
            isNull(workflowDelegation.revokedAt),
            lte(workflowDelegation.validFrom, input.validTo),
            gte(workflowDelegation.validTo, input.validFrom),
          ),
        );
      if (overlapping.length) throw ApiError.conflict('You already have a delegation in this period');
      const id = uuidv7();
      await tx.insert(workflowDelegation).values({ id, fromUserId: principal.userId, ...input });
      await this.audit.record(tx, { action: 'workflow.delegation_created', entityType: 'workflow_delegation', entityId: id, after: input });
      await this.notifications.notify(tx, {
        userIds: [input.toUserId],
        eventType: 'workflow.delegation',
        title: { ar: 'تم تفويضك بالموافقات', en: 'Approvals have been delegated to you' },
        body: { ar: `${input.validFrom} – ${input.validTo}`, en: `${input.validFrom} – ${input.validTo}` },
        link: '/tasks',
      });
    });
  }

  async revokeDelegation(principal: Principal, id: string): Promise<void> {
    await this.database.tx(principal.rls(), async (tx) => {
      const rows = await tx
        .update(workflowDelegation)
        .set({ revokedAt: new Date() })
        .where(and(eq(workflowDelegation.id, id), eq(workflowDelegation.fromUserId, principal.userId), isNull(workflowDelegation.revokedAt)))
        .returning({ id: workflowDelegation.id });
      if (!rows.length) throw ApiError.notFound('Delegation');
      await this.audit.record(tx, { action: 'workflow.delegation_revoked', entityType: 'workflow_delegation', entityId: id });
    });
  }
}

