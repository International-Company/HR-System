import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { and, desc, eq, gt, gte, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { SeparationDto, SeparationPolicy, separationInput } from '@hrms/shared';
import { DATABASE } from '../common/tokens.js';
import type { Database, Tx } from '../db/database.js';
import {
  compensation,
  contract,
  contractVersion,
  employee,
  employmentAssignment,
  leaveLedger,
  leaveRequest,
  lifecycleEvent,
  separation,
} from '../db/schema.js';
import { ApiError } from '../common/errors.js';
import { uuidv7 } from '../common/ids.js';
import type { Principal } from '../access/principal.js';
import { AuditService } from '../audit/audit.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { ModulesService } from '../settings/modules.service.js';
import { EmployeesService } from '../employees/employees.service.js';
import { WorkflowService } from '../workflow/workflow.service.js';
import { localDate } from '../attendance/time.js';
import { endOfService } from '../payroll/calc.js';

type SepRow = typeof separation.$inferSelect;

/**
 * Separation (TRM-01..07): resignation, termination, end of contract, retirement and other
 * types through their own approval routes. On the last working day the exit policy is applied
 * (TRM-05). Nothing is deleted (TRM-06); rehire keeps the employee number (TRM-07).
 */
@Injectable()
export class SeparationService implements OnModuleInit {
  private readonly logger = new Logger('Separation');

  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(ModulesService) private readonly modules: ModulesService,
    @Inject(EmployeesService) private readonly employees: EmployeesService,
    @Inject(WorkflowService) private readonly workflow: WorkflowService,
  ) {}

  onModuleInit() {
    this.workflow.registerHandler('separation', {
      onCompleted: async (tx, inst, outcome) => {
        const [s] = await tx.select().from(separation).where(eq(separation.id, inst.subjectId));
        if (!s) return;
        if (outcome !== 'approved') {
          await tx.update(separation).set({ status: outcome, decidedAt: new Date() }).where(eq(separation.id, s.id));
          return;
        }
        await this.approve(tx, s, inst.requesterUserId);
      },
      link: (inst) => `/separations/${inst.subjectId}`,
    });
  }

  private async todayIn(tx: Tx): Promise<string> {
    return localDate(new Date(), await this.settings.getWith(tx, 'general.timezone', null));
  }

  // --- request (TRM-01, TRM-02, TRM-04) ----------------------------------------------------------

  async request(principal: Principal, input: z.infer<typeof separationInput>): Promise<SeparationDto> {
    const employeeId = input.employeeId ?? principal.employeeId;
    if (!employeeId) throw ApiError.forbidden('Your account is not linked to an employee record');
    const { row, current } = await this.employees.loadVisible(principal, employeeId);
    if (!current) throw ApiError.conflict('The employee has no employment');
    const self = employeeId === principal.employeeId;
    if ((await this.modules.access('separation', current.companyId)) !== 'enabled') {
      throw new ApiError(403, 'MODULE_DISABLED', 'Separation is disabled for this company');
    }
    const policy = await this.settings.get('separation.policy', current.companyId);
    const today = localDate(new Date(), await this.settings.get('general.timezone'));
    const fail = (path: string, message: string) => ApiError.validation([{ path, message }]);
    if (self) {
      if (!principal.canSelf('separation.request', employeeId)) throw ApiError.forbidden();
      if (input.type !== 'resignation' || !policy.selfResignation) throw ApiError.forbidden('Employees can only submit their own resignation');
      const earliest = new Date(Date.parse(`${today}T00:00:00Z`) + policy.resignationNoticeDays * 86_400_000).toISOString().slice(0, 10);
      if (input.lastWorkingDay < earliest) throw fail('lastWorkingDay', `The notice period is ${policy.resignationNoticeDays} days`);
    } else if (!principal.canCompany('separation.request', current.companyId)) {
      throw ApiError.forbidden();
    }
    if (row.status === 'terminated') throw ApiError.conflict('The employee has already left');
    if (input.lastWorkingDay < current.validFrom) throw fail('lastWorkingDay', 'Before the start of the current assignment');
    const id = uuidv7();
    await this.database.tx(principal.rls(), async (tx) => {
      const later = await tx
        .select({ id: employmentAssignment.id })
        .from(employmentAssignment)
        .where(and(eq(employmentAssignment.employeeId, employeeId), gt(employmentAssignment.validFrom, input.lastWorkingDay)));
      if (later.length) throw ApiError.conflict('A change is scheduled after this date; cancel it first');
      const open = await tx.select({ id: separation.id }).from(separation).where(and(eq(separation.employeeId, employeeId), inArray(separation.status, ['pending', 'approved'])));
      if (open.length) throw ApiError.conflict('A separation is already in progress for this employee');
      await tx.insert(separation).values({
        id,
        employeeId,
        companyId: current.companyId,
        type: input.type,
        lastWorkingDay: input.lastWorkingDay,
        reason: input.reason,
        rehireEligible: input.rehireEligible,
        initiatedBy: principal.userId,
        initiatedBySelf: self,
      });
      await this.audit.record(tx, {
        action: 'separation.requested',
        entityType: 'separation',
        entityId: id,
        companyId: current.companyId,
        after: { employeeId, type: input.type, lastWorkingDay: input.lastWorkingDay, self },
      });
      const inst = await this.workflow.start(tx, principal, {
        definitionKey: `separation.${input.type}`,
        companyId: current.companyId,
        subjectType: 'separation',
        subjectId: id,
        subjectEmployeeId: employeeId,
        summary: { type: input.type, lastWorkingDay: input.lastWorkingDay },
      });
      await tx.update(separation).set({ workflowInstanceId: inst.id }).where(eq(separation.id, id));
    });
    return this.get(principal, id);
  }

  /** On approval: settlement snapshot and the assignment ends on the last working day. */
  private async approve(tx: Tx, s: SepRow, actorUserId: string): Promise<void> {
    const policy = await this.settings.getWith(tx, 'separation.policy', s.companyId);
    const today = await this.todayIn(tx);
    const [a] = await tx
      .select()
      .from(employmentAssignment)
      .where(
        and(
          eq(employmentAssignment.employeeId, s.employeeId),
          lte(employmentAssignment.validFrom, s.lastWorkingDay),
          or(isNull(employmentAssignment.validTo), gte(employmentAssignment.validTo, s.lastWorkingDay)),
        ),
      );
    if (a) await tx.update(employmentAssignment).set({ validTo: s.lastWorkingDay }).where(eq(employmentAssignment.id, a.id));
    let settlement: SepRow['settlement'] = null;
    if (policy.settlement) {
      const eos = await this.settings.getWith(tx, 'payroll.endOfService', s.companyId);
      const [e] = await tx.select({ hireDate: employee.hireDate }).from(employee).where(eq(employee.id, s.employeeId));
      const [pay] = await tx
        .select()
        .from(compensation)
        .where(and(eq(compensation.employeeId, s.employeeId), eq(compensation.companyId, s.companyId), lte(compensation.validFrom, s.lastWorkingDay)))
        .orderBy(desc(compensation.validFrom));
      if (e && pay) {
        const r = endOfService(eos, e.hireDate, s.lastWorkingDay, Number(pay.baseSalary));
        settlement = { amount: r.amount, currency: pay.currency, serviceYears: r.years, explanation: r.explanation };
      }
    }
    const [done] = await tx
      .update(separation)
      .set({ status: 'approved', decidedAt: new Date(), assignmentId: a?.id ?? null, previousValidTo: a?.validTo ?? null, settlement })
      .where(eq(separation.id, s.id))
      .returning();
    await tx.insert(lifecycleEvent).values({
      id: uuidv7(),
      employeeId: s.employeeId,
      companyId: s.companyId,
      type: 'separation_approved',
      effectiveDate: s.lastWorkingDay,
      details: { separationType: s.type, reason: s.reason },
      createdBy: actorUserId,
    });
    await this.audit.record(tx, { action: 'separation.approved', entityType: 'separation', entityId: s.id, companyId: s.companyId, details: { lastWorkingDay: s.lastWorkingDay, settlement } });
    // A last working day already in the past completes right away.
    if (s.lastWorkingDay < today) await this.complete(tx, done!, policy, actorUserId);
  }

  /** After the last working day (TRM-05): terminated status, exit access, contract, salary, leave. */
  private async complete(tx: Tx, s: SepRow, policy: SeparationPolicy, actorUserId: string | null): Promise<void> {
    await tx.update(employee).set({ status: 'terminated', updatedBy: actorUserId }).where(eq(employee.id, s.employeeId));
    await tx
      .update(compensation)
      .set({ validTo: s.lastWorkingDay })
      .where(
        and(
          eq(compensation.employeeId, s.employeeId),
          lte(compensation.validFrom, s.lastWorkingDay),
          or(isNull(compensation.validTo), gt(compensation.validTo, s.lastWorkingDay)),
        ),
      );
    if (policy.endContract) {
      const reason = `Separation (${s.type}): ${s.reason}`.slice(0, 500);
      await tx
        .update(contract)
        .set({ status: 'ended', endDate: s.lastWorkingDay, endReason: reason, endedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(contract.employeeId, s.employeeId), eq(contract.status, 'active'), or(isNull(contract.endDate), gt(contract.endDate, s.lastWorkingDay))));
      const open = await tx.select({ id: contract.id }).from(contract).where(and(eq(contract.employeeId, s.employeeId), inArray(contract.status, ['draft', 'awaiting_signature'])));
      if (open.length) {
        await tx.update(contractVersion).set({ status: 'cancelled' }).where(and(inArray(contractVersion.contractId, open.map((c) => c.id)), inArray(contractVersion.status, ['draft', 'awaiting_signature'])));
        await tx.update(contract).set({ status: 'cancelled', updatedAt: new Date() }).where(inArray(contract.id, open.map((c) => c.id)));
      }
    }
    if (policy.cancelFutureLeave) {
      const future = await tx
        .select()
        .from(leaveRequest)
        .where(and(eq(leaveRequest.employeeId, s.employeeId), inArray(leaveRequest.status, ['pending', 'approved']), gt(leaveRequest.startDate, s.lastWorkingDay)));
      for (const r of future) {
        if (r.status === 'pending' && r.workflowInstanceId) {
          await this.workflow.cancelWithin(tx, r.workflowInstanceId);
        } else {
          if (r.deducted) {
            await tx.insert(leaveLedger).values({
              id: uuidv7(),
              employeeId: r.employeeId,
              companyId: r.companyId,
              leaveTypeId: r.leaveTypeId,
              effectiveDate: s.lastWorkingDay,
              kind: 'refund',
              amount: Number(r.days).toFixed(2),
              sourceId: r.id,
              note: 'Cancelled: employee left',
              createdBy: actorUserId,
            });
          }
          await tx.update(leaveRequest).set({ status: 'cancelled', deducted: false, cancelledAt: new Date(), cancelReason: 'Employee left' }).where(eq(leaveRequest.id, r.id));
        }
      }
    }
    // Account, sessions, roles and devices are handled by an owner-run function (TRM-05).
    await tx.execute(sql`select separation_apply_exit(${s.id}::uuid, ${policy.accountOnExit === 'self_service_only'}, ${policy.revokeDevices})`);
    await tx.update(separation).set({ status: 'completed', completedAt: new Date() }).where(eq(separation.id, s.id));
    await tx.insert(lifecycleEvent).values({
      id: uuidv7(),
      employeeId: s.employeeId,
      companyId: s.companyId,
      type: 'separation',
      effectiveDate: s.lastWorkingDay,
      details: { separationType: s.type, reason: s.reason, rehireEligible: s.rehireEligible },
      createdBy: actorUserId,
    });
    await this.audit.record(tx, {
      action: 'separation.completed',
      entityType: 'separation',
      entityId: s.id,
      companyId: s.companyId,
      details: { employeeId: s.employeeId, lastWorkingDay: s.lastWorkingDay, accountOnExit: policy.accountOnExit, revokeDevices: policy.revokeDevices },
      ...(actorUserId ? {} : { actor: { userId: null, username: 'system' } }),
    });
  }

  /** Daily: complete approved separations whose last working day has passed. */
  async daily(): Promise<number> {
    const today = localDate(new Date(), await this.settings.get('general.timezone'));
    const due = await this.database.system((tx) => tx.select().from(separation).where(and(eq(separation.status, 'approved'), lt(separation.lastWorkingDay, today))));
    for (const s of due) {
      const policy = await this.settings.get('separation.policy', s.companyId);
      await this.database.system((tx) => this.complete(tx, s, policy, null));
    }
    if (due.length) this.logger.log(`Completed ${due.length} separation(s)`);
    return due.length;
  }

  // --- cancel & eligibility ----------------------------------------------------------------------

  async cancel(principal: Principal, id: string, reason: string): Promise<SeparationDto> {
    await this.database.tx(principal.rls(), async (tx) => {
      const [s] = await tx.select().from(separation).where(eq(separation.id, id)).for('update');
      if (!s) throw ApiError.notFound('Separation');
      const manage = principal.canCompany('separation.manage', s.companyId);
      const own = s.initiatedBy === principal.userId || (s.initiatedBySelf && s.employeeId === principal.employeeId);
      if (s.status === 'pending') {
        if (!own && !manage) throw ApiError.forbidden();
        await tx.update(separation).set({ cancelledAt: new Date(), cancelledBy: principal.userId, cancelReason: reason }).where(eq(separation.id, id));
        await this.workflow.cancelWithin(tx, s.workflowInstanceId!);
      } else if (s.status === 'approved') {
        // Before the last working day has passed: the employment continues as before.
        if (!manage) throw ApiError.forbidden('Approved separations can only be cancelled by HR');
        if (s.assignmentId) await tx.update(employmentAssignment).set({ validTo: s.previousValidTo }).where(eq(employmentAssignment.id, s.assignmentId));
        await tx.update(separation).set({ status: 'cancelled', cancelledAt: new Date(), cancelledBy: principal.userId, cancelReason: reason }).where(eq(separation.id, id));
        await tx.insert(lifecycleEvent).values({
          id: uuidv7(),
          employeeId: s.employeeId,
          companyId: s.companyId,
          type: 'separation_cancelled',
          effectiveDate: s.lastWorkingDay,
          details: { separationType: s.type, reason },
          createdBy: principal.userId,
        });
      } else {
        throw ApiError.conflict(s.status === 'completed' ? 'The employee has left; use rehire' : 'This separation is closed');
      }
      await this.audit.record(tx, { action: 'separation.cancelled', entityType: 'separation', entityId: id, companyId: s.companyId, before: { status: s.status }, after: { reason } });
    });
    return this.get(principal, id);
  }

  async setEligibility(principal: Principal, id: string, eligible: boolean): Promise<SeparationDto> {
    await this.database.tx(principal.rls(), async (tx) => {
      const [s] = await tx.select().from(separation).where(eq(separation.id, id));
      if (!s || !principal.canCompany('separation.manage', s.companyId)) throw ApiError.notFound('Separation');
      await tx.update(separation).set({ rehireEligible: eligible }).where(eq(separation.id, id));
      await this.audit.record(tx, { action: 'separation.rehire_eligibility', entityType: 'separation', entityId: id, companyId: s.companyId, before: { eligible: s.rehireEligible }, after: { eligible } });
    });
    return this.get(principal, id);
  }

  // --- reading ---------------------------------------------------------------------------------------

  private canView(principal: Principal, s: SepRow): boolean {
    return (
      principal.canCompany('separation.view', s.companyId) ||
      principal.canCompany('separation.request', s.companyId) ||
      principal.touchesCompany('separation.view', s.companyId) ||
      (s.employeeId === principal.employeeId && principal.canSelf('separation.view', s.employeeId))
    );
  }

  private async toDtos(tx: Tx, rows: SepRow[]): Promise<SeparationDto[]> {
    if (!rows.length) return [];
    const emps = await tx
      .select({ id: employee.id, no: employee.employeeNo, ar: employee.fullNameAr, en: employee.fullNameEn })
      .from(employee)
      .where(inArray(employee.id, [...new Set(rows.map((r) => r.employeeId))]));
    return rows.map((s) => {
      const e = emps.find((x) => x.id === s.employeeId);
      return {
        id: s.id,
        employeeId: s.employeeId,
        employeeNo: e?.no ?? '',
        employeeName: { ar: e?.ar ?? '', en: e?.en ?? '' },
        companyId: s.companyId,
        type: s.type,
        status: s.status,
        lastWorkingDay: s.lastWorkingDay,
        reason: s.reason,
        rehireEligible: s.rehireEligible,
        settlement: s.settlement ?? null,
        workflowInstanceId: s.workflowInstanceId,
        initiatedBySelf: s.initiatedBySelf,
        createdAt: s.createdAt.toISOString(),
        decidedAt: s.decidedAt?.toISOString() ?? null,
        completedAt: s.completedAt?.toISOString() ?? null,
        cancelReason: s.cancelReason,
      };
    });
  }

  async get(principal: Principal, id: string): Promise<SeparationDto> {
    return this.database.tx(principal.rls(), async (tx) => {
      const [s] = await tx.select().from(separation).where(eq(separation.id, id));
      // Approvers in the workflow see it through the row policy.
      if (!s) throw ApiError.notFound('Separation');
      const dto = (await this.toDtos(tx, [s]))[0]!;
      // Settlement amounts are financial: only for staff with the financial permission or the employee.
      if (!principal.canCompany('employee.financial.view', s.companyId) && s.employeeId !== principal.employeeId) dto.settlement = null;
      return dto;
    });
  }

  async list(principal: Principal, companyId: string, status?: string): Promise<SeparationDto[]> {
    if (!principal.canCompany('separation.view', companyId) && !principal.touchesCompany('separation.view', companyId)) throw ApiError.notFound('Company');
    return this.database.tx(principal.rls(), async (tx) => {
      const rows = await tx
        .select()
        .from(separation)
        .where(and(eq(separation.companyId, companyId), status ? eq(separation.status, status as SepRow['status']) : undefined))
        .orderBy(desc(separation.lastWorkingDay))
        .limit(500);
      const dtos = await this.toDtos(tx, rows.filter((s) => this.canView(principal, s)));
      if (!principal.canCompany('employee.financial.view', companyId)) for (const d of dtos) d.settlement = null;
      return dtos;
    });
  }

  async employeeSeparations(principal: Principal, employeeId: string): Promise<SeparationDto[]> {
    await this.employees.loadVisible(principal, employeeId);
    return this.database.tx(principal.rls(), async (tx) => {
      const rows = (await tx.select().from(separation).where(eq(separation.employeeId, employeeId)).orderBy(desc(separation.createdAt))).filter((s) => this.canView(principal, s));
      const dtos = await this.toDtos(tx, rows);
      for (const d of dtos) if (!principal.canCompany('employee.financial.view', d.companyId) && d.employeeId !== principal.employeeId) d.settlement = null;
      return dtos;
    });
  }
}
