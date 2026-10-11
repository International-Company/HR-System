import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type { z } from 'zod';
import {
  leaveRulesSchema,
  type LeaveBalanceDto,
  type LeaveRequestDto,
  type LeaveTypeDto,
  type LedgerEntryDto,
  type PermissionRequestDto,
  type balanceAdjustInput,
  type leaveRequestInput,
  type leaveTypeInput,
  type leaveTypeUpdateInput,
  type permissionRequestInput,
} from '@hrms/shared';
import { DATABASE } from '../common/tokens.js';
import type { Database, Tx } from '../db/database.js';
import {
  documentCategory,
  employee,
  employeeCurrentAssignment,
  leaveLedger,
  leavePermission,
  leaveRequest,
  leaveType,
} from '../db/schema.js';
import { ApiError } from '../common/errors.js';
import { uuidv7 } from '../common/ids.js';
import type { Principal } from '../access/principal.js';
import { AuditService } from '../audit/audit.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { ModulesService } from '../settings/modules.service.js';
import { CalendarService, eachDay } from '../calendar/calendar.service.js';
import { EmployeesService } from '../employees/employees.service.js';
import { WorkflowService } from '../workflow/workflow.service.js';
import { DocumentsService, type UploadedFile } from '../documents/documents.service.js';
import { AttendanceService } from '../attendance/attendance.service.js';
import { localDate } from '../attendance/time.js';
import { addDays, balanceOn, plannedEntries, type LedgerRow } from './rules.js';

type TypeRow = typeof leaveType.$inferSelect;
type RequestRow = typeof leaveRequest.$inferSelect;
type PermissionRow = typeof leavePermission.$inferSelect;
type Assignment = { companyId: string; departmentId: string | null; contractTypeId: string | null; employmentCategoryId: string | null };

const num = (v: string | number) => Math.round(Number(v) * 100) / 100;
const toMinutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

const toTypeDto = (t: TypeRow): LeaveTypeDto => ({
  id: t.id,
  companyId: t.companyId,
  code: t.code,
  nameAr: t.nameAr,
  nameEn: t.nameEn,
  paid: t.paid,
  status: t.status,
  rules: leaveRulesSchema.parse(t.rules),
});

/**
 * Leave and in-day permissions (LEV-01..08). Balances are an append-only ledger; requests go
 * through the locked Employee → Direct Manager → HR chain (C-05); approved leave and
 * permissions feed attendance (LEV-07).
 */
@Injectable()
export class LeaveService implements OnModuleInit {
  private readonly logger = new Logger('Leave');

  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(ModulesService) private readonly modules: ModulesService,
    @Inject(CalendarService) private readonly calendar: CalendarService,
    @Inject(EmployeesService) private readonly employees: EmployeesService,
    @Inject(WorkflowService) private readonly workflow: WorkflowService,
    @Inject(DocumentsService) private readonly documents: DocumentsService,
    @Inject(AttendanceService) private readonly attendance: AttendanceService,
  ) {}

  onModuleInit() {
    this.workflow.registerHandler('leave_request', {
      onCompleted: async (tx, inst, outcome) => {
        const [r] = await tx.select().from(leaveRequest).where(eq(leaveRequest.id, inst.subjectId));
        if (!r) return;
        const today = await this.todayIn(tx);
        const [t] = await tx.select().from(leaveType).where(eq(leaveType.id, r.leaveTypeId));
        const tracked = leaveRulesSchema.parse(t!.rules).accrual !== 'none';
        if (outcome === 'approved') {
          if (tracked && !r.deducted) await this.ledgerUsage(tx, r, today, inst.requesterUserId);
          await tx
            .update(leaveRequest)
            .set({ status: 'approved', decidedAt: new Date(), deducted: tracked || r.deducted })
            .where(eq(leaveRequest.id, r.id));
          await this.attendance.recomputeRange(tx, r.employeeId, r.companyId, r.startDate, r.endDate);
        } else {
          if (r.deducted) await this.ledgerRefund(tx, r, today, null, outcome === 'rejected' ? 'Request rejected' : 'Request cancelled');
          await tx
            .update(leaveRequest)
            .set({ status: outcome, decidedAt: new Date(), deducted: false })
            .where(eq(leaveRequest.id, r.id));
        }
      },
      link: (inst) => `/leave?request=${inst.subjectId}`,
    });
    this.workflow.registerHandler('leave_permission', {
      onCompleted: async (tx, inst, outcome) => {
        const [p] = await tx.select().from(leavePermission).where(eq(leavePermission.id, inst.subjectId));
        if (!p) return;
        await tx.update(leavePermission).set({ status: outcome, decidedAt: new Date() }).where(eq(leavePermission.id, p.id));
        if (outcome === 'approved') await this.attendance.recomputeRange(tx, p.employeeId, p.companyId, p.workDate, p.workDate);
      },
      link: (inst) => `/leave?permission=${inst.subjectId}`,
    });
  }

  private async todayIn(tx: Tx): Promise<string> {
    return localDate(new Date(), await this.settings.getWith(tx, 'general.timezone', null));
  }

  private async today(): Promise<string> {
    return localDate(new Date(), await this.settings.get('general.timezone'));
  }

  // --- types (LEV-01) ---------------------------------------------------------------------------

  async listTypes(principal: Principal): Promise<LeaveTypeDto[]> {
    return this.database.tx(principal.rls(), async (tx) => {
      const rows = await tx.select().from(leaveType).orderBy(asc(leaveType.companyId), asc(leaveType.code));
      return rows.map(toTypeDto);
    });
  }

  private async checkRules(tx: Tx, rules: z.infer<typeof leaveTypeInput>['rules']) {
    if (rules.attachmentCategoryId) {
      const [c] = await tx.select({ id: documentCategory.id }).from(documentCategory).where(eq(documentCategory.id, rules.attachmentCategoryId));
      if (!c) throw ApiError.validation([{ path: 'rules.attachmentCategoryId', message: 'Unknown document category' }]);
    }
  }

  async createType(principal: Principal, input: z.infer<typeof leaveTypeInput>): Promise<LeaveTypeDto> {
    return this.database.tx(principal.rls(), async (tx) => {
      await this.checkRules(tx, input.rules);
      const dup = await tx
        .select({ id: leaveType.id })
        .from(leaveType)
        .where(
          and(
            sql`coalesce(${leaveType.companyId}, '00000000-0000-0000-0000-000000000000'::uuid) = coalesce(${input.companyId}::uuid, '00000000-0000-0000-0000-000000000000'::uuid)`,
            eq(leaveType.code, input.code),
          ),
        );
      if (dup.length) throw ApiError.validation([{ path: 'code', message: 'This code is already used' }]);
      const [row] = await tx
        .insert(leaveType)
        .values({ id: uuidv7(), ...input, createdBy: principal.userId, updatedBy: principal.userId })
        .returning();
      await this.audit.record(tx, { action: 'leave.type_created', entityType: 'leave_type', entityId: row!.id, companyId: input.companyId, after: input });
      return toTypeDto(row!);
    });
  }

  async updateType(principal: Principal, id: string, input: z.infer<typeof leaveTypeUpdateInput>): Promise<LeaveTypeDto> {
    return this.database.tx(principal.rls(), async (tx) => {
      const [before] = await tx.select().from(leaveType).where(eq(leaveType.id, id));
      if (!before) throw ApiError.notFound('Leave type');
      await this.checkRules(tx, input.rules);
      const [row] = await tx
        .update(leaveType)
        .set({ ...input, updatedBy: principal.userId, version: before.version + 1 })
        .where(eq(leaveType.id, id))
        .returning();
      await this.audit.record(tx, {
        action: 'leave.type_updated',
        entityType: 'leave_type',
        entityId: id,
        companyId: before.companyId,
        before: { nameEn: before.nameEn, paid: before.paid, status: before.status, rules: before.rules },
        after: input,
      });
      return toTypeDto(row!);
    });
  }

  /**
   * Types that apply to an employee: group types, replaced by a company type with the same
   * code (an inactive company type switches the group type off for that company), filtered
   * by eligibility.
   */
  private applicable(types: TypeRow[], a: Assignment): TypeRow[] {
    const own = types.filter((t) => t.companyId === a.companyId);
    const overridden = new Set(own.map((t) => t.code.toLowerCase()));
    return [...own, ...types.filter((t) => t.companyId === null && !overridden.has(t.code.toLowerCase()))]
      .filter((t) => t.status === 'active')
      .filter((t) => {
        const r = leaveRulesSchema.parse(t.rules);
        return (
          (!r.eligibleContractTypeIds.length || (!!a.contractTypeId && r.eligibleContractTypeIds.includes(a.contractTypeId))) &&
          (!r.eligibleCategoryIds.length || (!!a.employmentCategoryId && r.eligibleCategoryIds.includes(a.employmentCategoryId)))
        );
      })
      .sort((x, y) => x.code.localeCompare(y.code));
  }

  // --- balances (LEV-02) ------------------------------------------------------------------------

  private async ledgerRows(tx: Tx, employeeId: string, typeId: string): Promise<LedgerRow[]> {
    const rows = await tx
      .select()
      .from(leaveLedger)
      .where(and(eq(leaveLedger.employeeId, employeeId), eq(leaveLedger.leaveTypeId, typeId)))
      .orderBy(asc(leaveLedger.effectiveDate), asc(leaveLedger.createdAt));
    return rows.map((r) => ({ kind: r.kind, amount: num(r.amount), effectiveDate: r.effectiveDate, periodKey: r.periodKey }));
  }

  /** Write the accrual / year-end entries that are due (idempotent; also run by the daily job). */
  private async ensureAccruals(tx: Tx, employeeId: string, hireDate: string, a: Assignment, t: TypeRow, today: string): Promise<LedgerRow[]> {
    const rules = leaveRulesSchema.parse(t.rules);
    const rows = await this.ledgerRows(tx, employeeId, t.id);
    if (rules.accrual === 'none') return rows;
    // Tracking starts with the hiring date, or on 1 January of the year the type was introduced.
    const introduced = `${t.createdAt.toISOString().slice(0, 4)}-01-01`;
    const start = hireDate > introduced ? hireDate : introduced;
    const planned = plannedEntries(rules, hireDate, start, today, rows);
    if (planned.length) {
      await tx
        .insert(leaveLedger)
        .values(
          planned.map((p) => ({
            id: uuidv7(),
            employeeId,
            companyId: a.companyId,
            leaveTypeId: t.id,
            effectiveDate: p.effectiveDate,
            kind: p.kind,
            amount: p.amount.toFixed(2),
            periodKey: p.periodKey,
            note: p.note,
          })),
        )
        .onConflictDoNothing();
    }
    return [...rows, ...planned];
  }

  private async balancesIn(tx: Tx, employeeId: string, hireDate: string, a: Assignment, today: string): Promise<LeaveBalanceDto[]> {
    const types = this.applicable(await tx.select().from(leaveType), a);
    const requests = await tx
      .select()
      .from(leaveRequest)
      .where(and(eq(leaveRequest.employeeId, employeeId), inArray(leaveRequest.status, ['pending', 'approved'])));
    const year = today.slice(0, 4);
    const out: LeaveBalanceDto[] = [];
    for (const t of types) {
      const rules = leaveRulesSchema.parse(t.rules);
      const tracked = rules.accrual !== 'none';
      const rows = await this.ensureAccruals(tx, employeeId, hireDate, a, t, today);
      const mine = requests.filter((r) => r.leaveTypeId === t.id);
      const pending = mine.filter((r) => r.status === 'pending' && !r.deducted).reduce((s, r) => s + num(r.days), 0);
      const usedThisYear = mine
        .filter((r) => r.status === 'approved' && r.startDate.slice(0, 4) === year)
        .reduce((s, r) => s + num(r.days), 0);
      const balance = tracked ? balanceOn(rows, today) : 0;
      const available = tracked
        ? num(balance - pending)
        : rules.maxDaysPerYear !== null
          ? num(rules.maxDaysPerYear - usedThisYear - pending)
          : 0;
      out.push({
        leaveTypeId: t.id,
        code: t.code,
        nameAr: t.nameAr,
        nameEn: t.nameEn,
        tracked,
        balance,
        pending: num(pending),
        available,
        usedThisYear: num(usedThisYear),
        maxDaysPerYear: rules.maxDaysPerYear,
      });
    }
    return out;
  }

  private canView(principal: Principal, employeeId: string, a: Assignment | null): boolean {
    if (principal.canSelf('leave.request.view', employeeId)) return true;
    return !!a && principal.canDepartment('leave.request.view', a.companyId, a.departmentId ?? '');
  }

  private async visibleEmployee(principal: Principal, employeeId: string) {
    const { row, current } = await this.employees.loadVisible(principal, employeeId);
    if (!this.canView(principal, employeeId, current)) throw ApiError.notFound('Employee');
    return { row, current };
  }

  async balances(principal: Principal, employeeId: string): Promise<LeaveBalanceDto[]> {
    const { row, current } = await this.visibleEmployee(principal, employeeId);
    if (!current) return [];
    const today = await this.today();
    // Former employees: balances as of their last working day (no accrual afterwards).
    const asOf = current.validTo && current.validTo < today ? current.validTo : today;
    return this.database.tx(principal.rls(), (tx) => this.balancesIn(tx, employeeId, row.hireDate, current, asOf));
  }

  async ledger(principal: Principal, employeeId: string, leaveTypeId: string): Promise<LedgerEntryDto[]> {
    await this.visibleEmployee(principal, employeeId);
    return this.database.tx(principal.rls(), async (tx) => {
      const rows = await tx
        .select()
        .from(leaveLedger)
        .where(and(eq(leaveLedger.employeeId, employeeId), eq(leaveLedger.leaveTypeId, leaveTypeId)))
        .orderBy(desc(leaveLedger.effectiveDate), desc(leaveLedger.createdAt));
      return rows.map((r) => ({
        id: r.id,
        leaveTypeId: r.leaveTypeId,
        effectiveDate: r.effectiveDate,
        kind: r.kind,
        amount: num(r.amount),
        note: r.note,
        sourceId: r.sourceId,
        createdAt: r.createdAt.toISOString(),
      }));
    });
  }

  async adjust(principal: Principal, input: z.infer<typeof balanceAdjustInput>): Promise<void> {
    const { current } = await this.employees.loadVisible(principal, input.employeeId);
    if (!current || !principal.canCompany('leave.balance.adjust', current.companyId)) throw ApiError.forbidden();
    if (principal.employeeId === input.employeeId) throw ApiError.forbidden('You cannot adjust your own balance');
    const today = await this.today();
    if (input.effectiveDate > today) throw ApiError.validation([{ path: 'effectiveDate', message: 'Must not be in the future' }]);
    await this.database.tx(principal.rls(), async (tx) => {
      const [t] = await tx.select().from(leaveType).where(eq(leaveType.id, input.leaveTypeId));
      if (!t || !this.applicable([t], current).length) throw ApiError.validation([{ path: 'leaveTypeId', message: 'This leave type does not apply to the employee' }]);
      if (leaveRulesSchema.parse(t.rules).accrual === 'none') {
        throw ApiError.validation([{ path: 'leaveTypeId', message: 'This leave type has no balance' }]);
      }
      const id = uuidv7();
      await tx.insert(leaveLedger).values({
        id,
        employeeId: input.employeeId,
        companyId: current.companyId,
        leaveTypeId: t.id,
        effectiveDate: input.effectiveDate,
        kind: input.kind,
        amount: input.amount.toFixed(2),
        note: input.note,
        createdBy: principal.userId,
      });
      await this.audit.record(tx, {
        action: `leave.balance_${input.kind}`,
        entityType: 'leave_ledger',
        entityId: id,
        companyId: current.companyId,
        after: { employeeId: input.employeeId, leaveType: t.code, amount: input.amount, effectiveDate: input.effectiveDate, note: input.note },
      });
    });
  }

  private async ledgerUsage(tx: Tx, r: RequestRow, today: string, by: string) {
    await tx.insert(leaveLedger).values({
      id: uuidv7(),
      employeeId: r.employeeId,
      companyId: r.companyId,
      leaveTypeId: r.leaveTypeId,
      effectiveDate: today,
      kind: 'usage',
      amount: (-num(r.days)).toFixed(2),
      sourceId: r.id,
      note: `${r.startDate} – ${r.endDate}`,
      createdBy: by,
    });
  }

  private async ledgerRefund(tx: Tx, r: RequestRow, today: string, by: string | null, note: string) {
    await tx.insert(leaveLedger).values({
      id: uuidv7(),
      employeeId: r.employeeId,
      companyId: r.companyId,
      leaveTypeId: r.leaveTypeId,
      effectiveDate: today,
      kind: 'refund',
      amount: num(r.days).toFixed(2),
      sourceId: r.id,
      note,
      createdBy: by,
    });
  }

  // --- requests (LEV-03..LEV-08) -------------------------------------------------------------------

  /** Who is submitting: the employee themself, or staff recording on their behalf. */
  private async submitter(principal: Principal, employeeId: string | undefined) {
    const id = employeeId ?? principal.employeeId;
    if (!id) throw ApiError.forbidden('Your account is not linked to an employee record');
    const { row, current } = await this.employees.loadVisible(principal, id);
    if (!current) throw ApiError.conflict('The employee has no current employment');
    const self = id === principal.employeeId;
    if (self ? !principal.canSelf('leave.request.create', id) : !principal.canCompany('leave.request.manage', current.companyId)) {
      throw ApiError.forbidden();
    }
    if ((await this.modules.access('leave', current.companyId)) !== 'enabled') {
      throw new ApiError(403, 'MODULE_DISABLED', 'Leave is disabled for this company');
    }
    return { employeeId: id, row, current, self };
  }

  /** Validation shared by the dry run and the insert; returns the counted days. */
  private async validateRequest(
    tx: Tx,
    input: z.infer<typeof leaveRequestInput>,
    who: Awaited<ReturnType<LeaveService['submitter']>>,
    today: string,
    hasFile: boolean,
  ): Promise<{ type: TypeRow; days: number }> {
    const fail = (path: string, message: string) => ApiError.validation([{ path, message }]);
    if (input.endDate < input.startDate) throw fail('endDate', 'The end date is before the start date');
    if (eachDay(input.startDate, input.endDate).length > 366) throw fail('endDate', 'At most one year per request');
    const [t] = await tx.select().from(leaveType).where(eq(leaveType.id, input.leaveTypeId));
    if (!t || !this.applicable(await tx.select().from(leaveType), who.current).some((x) => x.id === t.id)) {
      throw fail('leaveTypeId', 'This leave type does not apply to the employee');
    }
    const rules = leaveRulesSchema.parse(t.rules);
    if (who.self) {
      if (input.startDate < addDays(today, -rules.retroactiveDays)) throw fail('startDate', `Requests are possible up to ${rules.retroactiveDays} days back`);
      if (input.startDate >= today && input.startDate < addDays(today, rules.minNoticeDays)) {
        throw fail('startDate', `This leave needs ${rules.minNoticeDays} days of notice`);
      }
    }
    if (input.startDate < who.row.hireDate) throw fail('startDate', 'Before the hiring date');
    const range = eachDay(input.startDate, input.endDate);
    const workdays = await this.calendar.resolveWorkdays(tx, who.employeeId, range);
    const days = rules.countDays === 'calendar' ? range.length : workdays.filter((w) => w.isWorkday && !w.holiday).length;
    if (days <= 0) throw fail('endDate', 'The period contains no working days');
    if (rules.maxDaysPerRequest !== null && days > rules.maxDaysPerRequest) throw fail('endDate', `At most ${rules.maxDaysPerRequest} days per request`);
    if (rules.attachment === 'required' && !hasFile) throw fail('file', 'An attachment is required for this leave type');
    if (rules.attachment === 'none' && hasFile) throw fail('file', 'This leave type takes no attachment');

    const overlap = await tx
      .select({ id: leaveRequest.id })
      .from(leaveRequest)
      .where(
        and(
          eq(leaveRequest.employeeId, who.employeeId),
          inArray(leaveRequest.status, ['pending', 'approved']),
          lte(leaveRequest.startDate, input.endDate),
          gte(leaveRequest.endDate, input.startDate),
        ),
      );
    if (overlap.length) throw ApiError.conflict('Another leave request covers part of this period');

    const balance = (await this.balancesIn(tx, who.employeeId, who.row.hireDate, who.current, today)).find((b) => b.leaveTypeId === t.id)!;
    if (balance.tracked && balance.available - days < -rules.allowNegativeDays) {
      throw new ApiError(409, 'INSUFFICIENT_BALANCE', `Not enough balance: ${balance.available} day(s) available`, {
        meta: { available: balance.available, requested: days },
      });
    }
    if (!balance.tracked && rules.maxDaysPerYear !== null && balance.available - days < 0) {
      throw new ApiError(409, 'INSUFFICIENT_BALANCE', `At most ${rules.maxDaysPerYear} days per year`, { meta: { available: balance.available, requested: days } });
    }
    return { type: t, days };
  }

  async request(principal: Principal, input: z.infer<typeof leaveRequestInput>, file: UploadedFile | undefined): Promise<LeaveRequestDto> {
    const who = await this.submitter(principal, input.employeeId);
    const today = await this.today();
    const { type } = await this.database.tx(principal.rls(), (tx) => this.validateRequest(tx, input, who, today, !!file));
    const rules = leaveRulesSchema.parse(type.rules);

    // Attachment first (own transaction), then the request (C-12: restricted category).
    let documentId: string | null = null;
    if (file) {
      const doc = await this.documents.upload(
        principal,
        who.employeeId,
        { categoryId: rules.attachmentCategoryId ?? '', title: `${type.nameEn} ${input.startDate}` },
        file,
        rules.attachmentCategoryId ? { forLeave: true } : { forLeave: true, categoryCode: 'other' },
      );
      documentId = doc.id;
    }

    const id = uuidv7();
    await this.database.tx(principal.rls(), async (tx) => {
      const { days } = await this.validateRequest(tx, input, who, today, !!file);
      const deductNow = rules.accrual !== 'none' && rules.deductWhen === 'submission';
      const [row] = await tx
        .insert(leaveRequest)
        .values({
          id,
          employeeId: who.employeeId,
          companyId: who.current.companyId,
          leaveTypeId: type.id,
          startDate: input.startDate,
          endDate: input.endDate,
          days: days.toFixed(2),
          reason: input.reason ?? null,
          documentId,
          deducted: deductNow,
          requestedBy: principal.userId,
        })
        .returning();
      if (deductNow) await this.ledgerUsage(tx, row!, today, principal.userId);
      await this.audit.record(tx, {
        action: 'leave.requested',
        entityType: 'leave_request',
        entityId: id,
        companyId: who.current.companyId,
        after: { employeeId: who.employeeId, type: type.code, startDate: input.startDate, endDate: input.endDate, days, onBehalf: !who.self },
      });
      const inst = await this.workflow.start(tx, principal, {
        definitionKey: 'leave.standard',
        companyId: who.current.companyId,
        subjectType: 'leave_request',
        subjectId: id,
        subjectEmployeeId: who.employeeId,
        summary: { type: { ar: type.nameAr, en: type.nameEn }, startDate: input.startDate, endDate: input.endDate, days },
      });
      await tx.update(leaveRequest).set({ workflowInstanceId: inst.id }).where(eq(leaveRequest.id, id));
    });
    return this.getRequest(principal, id);
  }

  async cancel(principal: Principal, id: string, reason: string): Promise<LeaveRequestDto> {
    const today = await this.today();
    await this.database.tx(principal.rls(), async (tx) => {
      const [r] = await tx.select().from(leaveRequest).where(eq(leaveRequest.id, id)).for('update');
      if (!r) throw ApiError.notFound('Leave request');
      const staff = principal.canCompany('leave.request.manage', r.companyId);
      const own = r.requestedBy === principal.userId || r.employeeId === principal.employeeId;
      if (r.status === 'pending') {
        if (!own && !staff) throw ApiError.forbidden();
        await tx.update(leaveRequest).set({ cancelledAt: new Date(), cancelledBy: principal.userId, cancelReason: reason }).where(eq(leaveRequest.id, id));
        await this.workflow.cancelWithin(tx, r.workflowInstanceId!);
      } else if (r.status === 'approved') {
        // LEV-06: approved leave is cancelled by HR; the whole request is reversed and refunded.
        if (!staff) throw ApiError.forbidden('Approved leave can only be cancelled by HR');
        if (r.deducted) await this.ledgerRefund(tx, r, today, principal.userId, `Cancelled: ${reason}`);
        await tx
          .update(leaveRequest)
          .set({ status: 'cancelled', deducted: false, cancelledAt: new Date(), cancelledBy: principal.userId, cancelReason: reason })
          .where(eq(leaveRequest.id, id));
        await this.attendance.recomputeRange(tx, r.employeeId, r.companyId, r.startDate, r.endDate);
      } else {
        throw ApiError.conflict('This request is already closed');
      }
      await this.audit.record(tx, {
        action: 'leave.cancelled',
        entityType: 'leave_request',
        entityId: id,
        companyId: r.companyId,
        before: { status: r.status },
        after: { status: 'cancelled', reason },
      });
    });
    return this.getRequest(principal, id);
  }

  private async toRequestDtos(tx: Tx, principal: Principal, rows: RequestRow[]): Promise<LeaveRequestDto[]> {
    if (!rows.length) return [];
    const emps = await tx
      .select({ id: employee.id, ar: employee.fullNameAr, en: employee.fullNameEn })
      .from(employee)
      .where(inArray(employee.id, [...new Set(rows.map((r) => r.employeeId))]));
    const types = await tx.select().from(leaveType).where(inArray(leaveType.id, [...new Set(rows.map((r) => r.leaveTypeId))]));
    const visible = await this.documents.visibleDocumentIds(
      tx,
      principal,
      rows.filter((r) => r.documentId).map((r) => ({ documentId: r.documentId!, employeeId: r.employeeId, companyId: r.companyId })),
    );
    return rows.map((r) => {
      const e = emps.find((x) => x.id === r.employeeId);
      const t = types.find((x) => x.id === r.leaveTypeId);
      return {
        id: r.id,
        employeeId: r.employeeId,
        employeeName: { ar: e?.ar ?? '', en: e?.en ?? '' },
        companyId: r.companyId,
        leaveTypeId: r.leaveTypeId,
        leaveTypeName: { ar: t?.nameAr ?? '', en: t?.nameEn ?? '' },
        startDate: r.startDate,
        endDate: r.endDate,
        days: num(r.days),
        reason: r.reason,
        status: r.status,
        attachmentId: r.documentId && visible.has(r.documentId) ? r.documentId : null,
        hasAttachment: !!r.documentId,
        workflowInstanceId: r.workflowInstanceId,
        createdAt: r.createdAt.toISOString(),
        decidedAt: r.decidedAt?.toISOString() ?? null,
        cancelReason: r.cancelReason,
      };
    });
  }

  /** Visible to the employee, staff in scope, and the participants of the approval. */
  async getRequest(principal: Principal, id: string): Promise<LeaveRequestDto> {
    return this.database.tx(principal.rls(), async (tx) => {
      const [r] = await tx.select().from(leaveRequest).where(eq(leaveRequest.id, id));
      if (!r) throw ApiError.notFound('Leave request');
      return (await this.toRequestDtos(tx, principal, [r]))[0]!;
    });
  }

  async employeeRequests(principal: Principal, employeeId: string): Promise<LeaveRequestDto[]> {
    await this.visibleEmployee(principal, employeeId);
    return this.database.tx(principal.rls(), async (tx) => {
      const rows = await tx.select().from(leaveRequest).where(eq(leaveRequest.employeeId, employeeId)).orderBy(desc(leaveRequest.startDate)).limit(200);
      return this.toRequestDtos(tx, principal, rows);
    });
  }

  async companyRequests(principal: Principal, companyId: string, from: string, to: string): Promise<LeaveRequestDto[]> {
    const scope = principal.scope('leave.request.view');
    if (!scope.all && !scope.companyIds.includes(companyId) && !principal.touchesCompany('leave.request.view', companyId)) {
      throw ApiError.notFound('Company');
    }
    return this.database.tx(principal.rls(), async (tx) => {
      const rows = await tx
        .select({ r: leaveRequest, dept: employeeCurrentAssignment.departmentId })
        .from(leaveRequest)
        .leftJoin(employeeCurrentAssignment, eq(employeeCurrentAssignment.employeeId, leaveRequest.employeeId))
        .where(and(eq(leaveRequest.companyId, companyId), lte(leaveRequest.startDate, to), gte(leaveRequest.endDate, from)))
        .orderBy(asc(leaveRequest.startDate))
        .limit(1000);
      const allowed = rows.filter(({ dept }) => principal.canDepartment('leave.request.view', companyId, dept ?? ''));
      return this.toRequestDtos(tx, principal, allowed.map((x) => x.r));
    });
  }

  // --- in-day permissions (LEV-05) ------------------------------------------------------------------

  async requestPermission(principal: Principal, input: z.infer<typeof permissionRequestInput>): Promise<PermissionRequestDto> {
    const who = await this.submitter(principal, input.employeeId);
    const policy = await this.settings.get('leave.permissions', who.current.companyId);
    const today = await this.today();
    const fail = (path: string, message: string) => ApiError.validation([{ path, message }]);
    if (!policy.enabled) throw new ApiError(403, 'MODULE_DISABLED', 'In-day permissions are disabled for this company');
    const minutes = toMinutes(input.endTime) - toMinutes(input.startTime);
    if (minutes <= 0) throw fail('endTime', 'The end is before the start');
    if (policy.unit === 'hours' && (minutes % 60 !== 0 || input.startTime.slice(3) !== '00')) throw fail('endTime', 'Permissions are in whole hours');
    if (minutes > policy.maxMinutesPerDay) throw fail('endTime', `At most ${policy.maxMinutesPerDay} minutes per day`);
    if (who.self && input.date < addDays(today, -policy.retroactiveDays)) throw fail('date', `Requests are possible up to ${policy.retroactiveDays} days back`);

    const id = uuidv7();
    await this.database.tx(principal.rls(), async (tx) => {
      const [wd] = await this.calendar.resolveWorkdays(tx, who.employeeId, [input.date]);
      if (!wd?.isWorkday || wd.holiday || !wd.startTime || !wd.endTime) throw fail('date', 'Not a scheduled workday');
      if (wd.endTime > wd.startTime && (input.startTime < wd.startTime.slice(0, 5) || input.endTime > wd.endTime.slice(0, 5))) {
        throw fail('startTime', `Must be within working hours ${wd.startTime.slice(0, 5)}–${wd.endTime.slice(0, 5)}`);
      }
      const onLeave = await tx
        .select({ id: leaveRequest.id })
        .from(leaveRequest)
        .where(
          and(
            eq(leaveRequest.employeeId, who.employeeId),
            inArray(leaveRequest.status, ['pending', 'approved']),
            lte(leaveRequest.startDate, input.date),
            gte(leaveRequest.endDate, input.date),
          ),
        );
      if (onLeave.length) throw ApiError.conflict('There is a leave request for this day');
      const month = input.date.slice(0, 7);
      const existing = await tx
        .select()
        .from(leavePermission)
        .where(
          and(
            eq(leavePermission.employeeId, who.employeeId),
            inArray(leavePermission.status, ['pending', 'approved']),
            gte(leavePermission.workDate, `${month}-01`),
            lte(leavePermission.workDate, `${month}-31`),
          ),
        );
      const sameDay = existing.filter((p) => p.workDate === input.date);
      if (sameDay.some((p) => p.startTime.slice(0, 5) < input.endTime && p.endTime.slice(0, 5) > input.startTime)) {
        throw ApiError.conflict('Another permission covers part of this time');
      }
      if (sameDay.reduce((s, p) => s + p.minutes, 0) + minutes > policy.maxMinutesPerDay) {
        throw fail('endTime', `At most ${policy.maxMinutesPerDay} minutes per day`);
      }
      const monthTotal = existing.reduce((s, p) => s + p.minutes, 0) + minutes;
      if (policy.maxMinutesPerMonth > 0 && monthTotal > policy.maxMinutesPerMonth) {
        throw new ApiError(409, 'INSUFFICIENT_BALANCE', `At most ${policy.maxMinutesPerMonth} minutes per month`, {
          meta: { available: policy.maxMinutesPerMonth - (monthTotal - minutes), requested: minutes },
        });
      }
      await tx.insert(leavePermission).values({
        id,
        employeeId: who.employeeId,
        companyId: who.current.companyId,
        workDate: input.date,
        startTime: input.startTime,
        endTime: input.endTime,
        minutes,
        reason: input.reason,
        requestedBy: principal.userId,
      });
      await this.audit.record(tx, {
        action: 'leave.permission_requested',
        entityType: 'leave_permission',
        entityId: id,
        companyId: who.current.companyId,
        after: { employeeId: who.employeeId, date: input.date, startTime: input.startTime, endTime: input.endTime, minutes },
      });
      const inst = await this.workflow.start(tx, principal, {
        definitionKey: 'leave.permission',
        companyId: who.current.companyId,
        subjectType: 'leave_permission',
        subjectId: id,
        subjectEmployeeId: who.employeeId,
        summary: { date: input.date, startTime: input.startTime, endTime: input.endTime, minutes },
      });
      await tx.update(leavePermission).set({ workflowInstanceId: inst.id }).where(eq(leavePermission.id, id));
    });
    return this.getPermission(principal, id);
  }

  async cancelPermission(principal: Principal, id: string): Promise<PermissionRequestDto> {
    await this.database.tx(principal.rls(), async (tx) => {
      const [p] = await tx.select().from(leavePermission).where(eq(leavePermission.id, id)).for('update');
      if (!p) throw ApiError.notFound('Permission');
      const staff = principal.canCompany('leave.request.manage', p.companyId);
      const own = p.requestedBy === principal.userId || p.employeeId === principal.employeeId;
      if (p.status === 'pending') {
        if (!own && !staff) throw ApiError.forbidden();
        await this.workflow.cancelWithin(tx, p.workflowInstanceId!);
      } else if (p.status === 'approved') {
        if (!staff) throw ApiError.forbidden('Approved permissions can only be cancelled by HR');
        await tx.update(leavePermission).set({ status: 'cancelled' }).where(eq(leavePermission.id, id));
        await this.attendance.recomputeRange(tx, p.employeeId, p.companyId, p.workDate, p.workDate);
      } else {
        throw ApiError.conflict('This request is already closed');
      }
      await this.audit.record(tx, { action: 'leave.permission_cancelled', entityType: 'leave_permission', entityId: id, companyId: p.companyId, before: { status: p.status } });
    });
    return this.getPermission(principal, id);
  }

  private async toPermissionDtos(tx: Tx, rows: PermissionRow[]): Promise<PermissionRequestDto[]> {
    if (!rows.length) return [];
    const emps = await tx
      .select({ id: employee.id, ar: employee.fullNameAr, en: employee.fullNameEn })
      .from(employee)
      .where(inArray(employee.id, [...new Set(rows.map((r) => r.employeeId))]));
    return rows.map((p) => {
      const e = emps.find((x) => x.id === p.employeeId);
      return {
        id: p.id,
        employeeId: p.employeeId,
        employeeName: { ar: e?.ar ?? '', en: e?.en ?? '' },
        companyId: p.companyId,
        date: p.workDate,
        startTime: p.startTime.slice(0, 5),
        endTime: p.endTime.slice(0, 5),
        minutes: p.minutes,
        reason: p.reason,
        status: p.status,
        workflowInstanceId: p.workflowInstanceId,
        createdAt: p.createdAt.toISOString(),
      };
    });
  }

  async getPermission(principal: Principal, id: string): Promise<PermissionRequestDto> {
    return this.database.tx(principal.rls(), async (tx) => {
      const [p] = await tx.select().from(leavePermission).where(eq(leavePermission.id, id));
      if (!p) throw ApiError.notFound('Permission');
      return (await this.toPermissionDtos(tx, [p]))[0]!;
    });
  }

  async employeePermissions(principal: Principal, employeeId: string): Promise<PermissionRequestDto[]> {
    await this.visibleEmployee(principal, employeeId);
    return this.database.tx(principal.rls(), async (tx) => {
      const rows = await tx.select().from(leavePermission).where(eq(leavePermission.employeeId, employeeId)).orderBy(desc(leavePermission.workDate)).limit(200);
      return this.toPermissionDtos(tx, rows);
    });
  }

  // --- daily job ------------------------------------------------------------------------------------

  /** Accrual, carryover and expiry entries for everyone employed today (idempotent). */
  async dailyAccrual(): Promise<number> {
    const today = await this.today();
    const people = await this.database.system((tx) =>
      tx
        .select({
          employeeId: employeeCurrentAssignment.employeeId,
          companyId: employeeCurrentAssignment.companyId,
          departmentId: employeeCurrentAssignment.departmentId,
          contractTypeId: employeeCurrentAssignment.contractTypeId,
          employmentCategoryId: employeeCurrentAssignment.employmentCategoryId,
          validTo: employeeCurrentAssignment.validTo,
          hireDate: employee.hireDate,
        })
        .from(employeeCurrentAssignment)
        .innerJoin(employee, eq(employee.id, employeeCurrentAssignment.employeeId)),
    );
    let n = 0;
    for (const { hireDate, validTo, ...a } of people) {
      if (validTo && validTo < today) continue; // left the group: nothing accrues
      if ((await this.modules.access('leave', a.companyId)) === 'hidden') continue;
      n += await this.database.system(async (tx) => {
        const before = await tx.select({ c: sql<number>`count(*)::int` }).from(leaveLedger).where(eq(leaveLedger.employeeId, a.employeeId));
        await this.balancesIn(tx, a.employeeId, hireDate, a, today);
        const after = await tx.select({ c: sql<number>`count(*)::int` }).from(leaveLedger).where(eq(leaveLedger.employeeId, a.employeeId));
        return after[0]!.c - before[0]!.c;
      });
    }
    if (n) this.logger.log(`Wrote ${n} leave ledger entr${n === 1 ? 'y' : 'ies'}`);
    return n;
  }
}
