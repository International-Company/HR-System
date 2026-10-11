import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';
import type { z } from 'zod';
import {
  leaveRulesSchema,
  type EndOfServiceDto,
  type GroupSummaryDto,
  type PayLineDto,
  type PayRunDetailDto,
  type PayRunDto,
  type PayrollPolicy,
  type PayslipDto,
  type fxRatesInput,
  type manualItemInput,
  type paymentInput,
} from '@hrms/shared';
import { DATABASE } from '../common/tokens.js';
import type { Database, Tx } from '../db/database.js';
import {
  attendanceDay,
  company,
  compensation,
  compensationItem,
  employee,
  employmentAssignment,
  leaveRequest,
  leaveType,
  lookupValue,
  payrollItem,
  payrollLine,
  payrollManualItem,
  payrollPayment,
  payrollRun,
} from '../db/schema.js';
import { ApiError } from '../common/errors.js';
import { uuidv7 } from '../common/ids.js';
import type { Principal } from '../access/principal.js';
import { AuditService } from '../audit/audit.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { ModulesService } from '../settings/modules.service.js';
import { CalendarService, eachDay } from '../calendar/calendar.service.js';
import { WorkflowService } from '../workflow/workflow.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { calculatePay, endOfService, round2, type CalcInput, type PaySegment } from './calc.js';

type RunRow = typeof payrollRun.$inferSelect;
type LineRow = typeof payrollLine.$inferSelect;

const num = (v: string | number | null) => (v === null ? null : Number(v));
const lastDay = (period: string) => {
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y!, m!, 0)).toISOString().slice(0, 10);
};
const maxS = (a: string, b: string) => (a > b ? a : b);
const minS = (a: string, b: string) => (a < b ? a : b);

/**
 * Payroll (PAY-01..11): monthly runs per company, calculated from salary records, attendance
 * and leave with predefined methods (D-10); approved through a workflow, locked by the
 * database, reopened only as a new audited revision.
 */
@Injectable()
export class PayrollService implements OnModuleInit {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(ModulesService) private readonly modules: ModulesService,
    @Inject(CalendarService) private readonly calendar: CalendarService,
    @Inject(WorkflowService) private readonly workflow: WorkflowService,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
  ) {}

  onModuleInit() {
    this.workflow.registerHandler('payroll_run', {
      onCompleted: async (tx, inst, outcome) => {
        const [run] = await tx.select().from(payrollRun).where(eq(payrollRun.id, inst.subjectId));
        if (!run) return;
        if (outcome !== 'approved') {
          await tx.update(payrollRun).set({ status: 'draft', workflowInstanceId: null }).where(eq(payrollRun.id, run.id));
          return;
        }
        await tx.update(payrollRun).set({ status: 'approved', lockedAt: new Date() }).where(eq(payrollRun.id, run.id));
        await this.audit.record(tx, { action: 'payroll.approved', entityType: 'payroll_run', entityId: run.id, companyId: run.companyId, details: { period: run.period, revision: run.revision } });
        const policy = await this.settings.getWith(tx, 'payroll.policy', run.companyId);
        if (policy.notifyEmployees) {
          const lines = await tx.select({ e: payrollLine.employeeId }).from(payrollLine).where(eq(payrollLine.runId, run.id));
          const users = lines.length
            ? ((await tx.execute<{ id: string }>(sql`select id from user_account where status = 'active' and employee_id in (${sql.join(lines.map((l) => sql`${l.e}`), sql`, `)})`)) as unknown as { rows: { id: string }[] }).rows
            : [];
          await this.notifications.notify(tx, {
            userIds: users.map((u) => u.id),
            companyId: run.companyId,
            eventType: 'payroll.payslip',
            title: { ar: `قسيمة راتب ${run.period} متاحة`, en: `Payslip for ${run.period} is available` },
            link: '/payslips',
            entityType: 'payroll_run',
            entityId: run.id,
          });
        }
      },
      link: (inst) => `/payroll/${inst.subjectId}`,
    });
  }

  // --- access ---------------------------------------------------------------------------------

  private canSee(principal: Principal, companyId: string) {
    return principal.canCompany('payroll.view', companyId) || principal.canCompany('payroll.prepare', companyId);
  }

  private async loadRun(tx: Tx, principal: Principal, id: string, forUpdate = false): Promise<RunRow> {
    const q = tx.select().from(payrollRun).where(eq(payrollRun.id, id));
    const [run] = forUpdate ? await q.for('update') : await q;
    if (!run || !this.canSee(principal, run.companyId)) throw ApiError.notFound('Payroll run');
    return run;
  }

  private requirePrepare(principal: Principal, run: Pick<RunRow, 'companyId'>) {
    if (!principal.canCompany('payroll.prepare', run.companyId)) throw ApiError.forbidden();
  }

  private requireDraft(run: RunRow) {
    if (run.status !== 'draft') throw ApiError.conflict(run.lockedAt ? 'Approved payroll is locked' : 'The run is waiting for approval');
  }

  // --- runs (PAY-02, PAY-04) ----------------------------------------------------------------------

  async create(principal: Principal, companyId: string, period: string): Promise<PayRunDetailDto> {
    if (!principal.canCompany('payroll.prepare', companyId)) throw ApiError.notFound('Company');
    if ((await this.modules.access('payroll', companyId)) !== 'enabled') throw new ApiError(403, 'MODULE_DISABLED', 'Payroll is disabled for this company');
    const id = uuidv7();
    await this.database.tx(principal.rls(), async (tx) => {
      const existing = await tx.select({ id: payrollRun.id }).from(payrollRun).where(and(eq(payrollRun.companyId, companyId), eq(payrollRun.period, period), ne(payrollRun.status, 'superseded')));
      if (existing.length) throw ApiError.conflict('A payroll for this month already exists');
      await tx.insert(payrollRun).values({ id, companyId, period, periodStart: `${period}-01`, periodEnd: lastDay(period), createdBy: principal.userId });
      await this.audit.record(tx, { action: 'payroll.created', entityType: 'payroll_run', entityId: id, companyId, details: { period } });
    });
    return this.calculate(principal, id);
  }

  /** (Re)calculate every line from current data; manual items are kept (PAY-08 recalculation). */
  async calculate(principal: Principal, id: string): Promise<PayRunDetailDto> {
    const companyId = await this.database.tx(principal.rls(), async (tx) => (await this.loadRun(tx, principal, id)).companyId);
    const policy = await this.settings.get('payroll.policy', companyId);
    await this.database.tx(principal.rls(), async (tx) => {
      const run = await this.loadRun(tx, principal, id, true);
      this.requirePrepare(principal, run);
      this.requireDraft(run);
      const old = await tx.select({ id: payrollLine.id }).from(payrollLine).where(eq(payrollLine.runId, id));
      if (old.length) {
        await tx.delete(payrollItem).where(inArray(payrollItem.lineId, old.map((l) => l.id)));
        await tx.delete(payrollLine).where(eq(payrollLine.runId, id));
      }
      const assigns = await tx
        .select()
        .from(employmentAssignment)
        .where(
          and(
            eq(employmentAssignment.companyId, run.companyId),
            lte(employmentAssignment.validFrom, run.periodEnd),
            or(isNull(employmentAssignment.validTo), gte(employmentAssignment.validTo, run.periodStart)),
          ),
        );
      const employees = [...new Set(assigns.map((a) => a.employeeId))];
      for (const empId of employees) {
        const input = await this.inputsFor(tx, run, empId, policy, assigns.filter((a) => a.employeeId === empId));
        const r = calculatePay(input);
        const lineId = uuidv7();
        await tx.insert(payrollLine).values({
          id: lineId,
          runId: id,
          employeeId: empId,
          companyId: run.companyId,
          currency: r.currency || 'XXX',
          daysPaid: r.daysPaid,
          periodDays: r.periodDays,
          gross: r.gross.toFixed(2),
          deductions: r.deductions.toFixed(2),
          net: r.net.toFixed(2),
          warnings: r.warnings,
          inputs: input as unknown as Record<string, unknown>,
        });
        if (r.items.length) {
          await tx.insert(payrollItem).values(
            r.items.map((it, seq) => ({
              id: uuidv7(),
              lineId,
              kind: it.kind,
              source: it.source,
              code: it.code,
              label: it.label,
              quantity: it.quantity === null ? null : it.quantity.toFixed(2),
              rate: it.rate === null ? null : it.rate.toFixed(4),
              amount: it.amount.toFixed(2),
              explanation: it.explanation,
              manualItemId: it.manualId ?? null,
              seq,
            })),
          );
        }
      }
      await tx.update(payrollRun).set({ calculatedAt: new Date() }).where(eq(payrollRun.id, id));
      await this.audit.record(tx, { action: 'payroll.calculated', entityType: 'payroll_run', entityId: id, companyId: run.companyId, details: { employees: employees.length } });
    });
    return this.get(principal, id);
  }

  /** Everything the calculation needs, stored on the line as a snapshot. */
  private async inputsFor(tx: Tx, run: RunRow, empId: string, policy: PayrollPolicy, assigns: (typeof employmentAssignment.$inferSelect)[]): Promise<CalcInput> {
    const employed = assigns.map((a) => ({ from: maxS(a.validFrom, run.periodStart), to: minS(a.validTo ?? run.periodEnd, run.periodEnd) }));
    const comps = await tx
      .select()
      .from(compensation)
      .where(
        and(
          eq(compensation.employeeId, empId),
          eq(compensation.companyId, run.companyId),
          lte(compensation.validFrom, run.periodEnd),
          or(isNull(compensation.validTo), gte(compensation.validTo, run.periodStart)),
        ),
      )
      .orderBy(asc(compensation.validFrom));
    const compItems = comps.length
      ? await tx
          .select({ ci: compensationItem, code: lookupValue.code, label: lookupValue.nameEn })
          .from(compensationItem)
          .innerJoin(lookupValue, eq(lookupValue.id, compensationItem.typeId))
          .where(inArray(compensationItem.compensationId, comps.map((c) => c.id)))
      : [];
    const segments: PaySegment[] = comps.map((c) => ({
      from: maxS(c.validFrom, run.periodStart),
      to: minS(c.validTo ?? run.periodEnd, run.periodEnd),
      baseMonthly: Number(c.baseSalary),
      currency: c.currency,
      items: compItems
        .filter((x) => x.ci.compensationId === c.id)
        .map((x) => ({ kind: x.ci.kind === 'allowance' ? ('allowance' as const) : ('deduction' as const), code: x.code, label: x.label, calc: x.ci.calc, amount: Number(x.ci.amount) })),
    }));
    const days = await tx
      .select()
      .from(attendanceDay)
      .where(and(eq(attendanceDay.employeeId, empId), eq(attendanceDay.companyId, run.companyId), gte(attendanceDay.workDate, run.periodStart), lte(attendanceDay.workDate, run.periodEnd)));
    const attendance = {
      overtimeMinutes: days.reduce((t, d) => t + d.overtimeMinutes, 0),
      holidayWorkMinutes: days.reduce((t, d) => t + d.holidayWorkMinutes, 0),
      lateMinutes: days.reduce((t, d) => t + d.lateMinutes, 0),
      absentConfirmedDays: days.filter((d) => d.status === 'absent_confirmed').length,
      absentPendingDays: days.filter((d) => d.status === 'absent_pending').length,
    };
    const periodDays = eachDay(run.periodStart, run.periodEnd);
    const workdays = await this.calendar.resolveWorkdays(tx, empId, periodDays);
    const unpaid = await tx
      .select({ r: leaveRequest, rules: leaveType.rules })
      .from(leaveRequest)
      .innerJoin(leaveType, eq(leaveType.id, leaveRequest.leaveTypeId))
      .where(
        and(
          eq(leaveRequest.employeeId, empId),
          eq(leaveRequest.status, 'approved'),
          eq(leaveType.paid, false),
          lte(leaveRequest.startDate, run.periodEnd),
          gte(leaveRequest.endDate, run.periodStart),
        ),
      );
    let unpaidLeaveDays = 0;
    for (const { r, rules } of unpaid) {
      const range = eachDay(maxS(r.startDate, run.periodStart), minS(r.endDate, run.periodEnd));
      unpaidLeaveDays +=
        leaveRulesSchema.parse(rules).countDays === 'calendar' ? range.length : workdays.filter((w) => range.includes(w.date) && w.isWorkday && !w.holiday).length;
    }
    const manual = await tx.select().from(payrollManualItem).where(and(eq(payrollManualItem.runId, run.id), eq(payrollManualItem.employeeId, empId))).orderBy(asc(payrollManualItem.createdAt));
    return {
      periodStart: run.periodStart,
      periodEnd: run.periodEnd,
      policy,
      employed,
      segments,
      workdaysInPeriod: workdays.filter((w) => w.isWorkday).length,
      attendance,
      unpaidLeaveDays,
      manual: manual.map((m) => ({ id: m.id, kind: m.kind, label: m.label, amount: Number(m.amount) })),
    };
  }

  async addManual(principal: Principal, runId: string, employeeId: string, input: z.infer<typeof manualItemInput>): Promise<PayRunDetailDto> {
    await this.database.tx(principal.rls(), async (tx) => {
      const run = await this.loadRun(tx, principal, runId, true);
      this.requirePrepare(principal, run);
      this.requireDraft(run);
      const [line] = await tx.select({ id: payrollLine.id }).from(payrollLine).where(and(eq(payrollLine.runId, runId), eq(payrollLine.employeeId, employeeId)));
      if (!line) throw ApiError.validation([{ path: 'employeeId', message: 'The employee is not in this payroll' }]);
      const id = uuidv7();
      await tx.insert(payrollManualItem).values({ id, runId, employeeId, kind: input.kind, label: input.label, amount: input.amount.toFixed(2), note: input.note ?? null, createdBy: principal.userId });
      await this.audit.record(tx, { action: 'payroll.manual_item_added', entityType: 'payroll_run', entityId: runId, companyId: run.companyId, after: { employeeId, ...input } });
    });
    return this.calculate(principal, runId);
  }

  async removeManual(principal: Principal, runId: string, itemId: string): Promise<PayRunDetailDto> {
    await this.database.tx(principal.rls(), async (tx) => {
      const run = await this.loadRun(tx, principal, runId, true);
      this.requirePrepare(principal, run);
      this.requireDraft(run);
      const [m] = await tx.select().from(payrollManualItem).where(and(eq(payrollManualItem.id, itemId), eq(payrollManualItem.runId, runId)));
      if (!m) throw ApiError.notFound('Item');
      await tx.delete(payrollManualItem).where(eq(payrollManualItem.id, itemId));
      await this.audit.record(tx, { action: 'payroll.manual_item_removed', entityType: 'payroll_run', entityId: runId, companyId: run.companyId, before: { employeeId: m.employeeId, kind: m.kind, label: m.label, amount: m.amount } });
    });
    return this.calculate(principal, runId);
  }

  async setFxRates(principal: Principal, runId: string, input: z.infer<typeof fxRatesInput>): Promise<PayRunDetailDto> {
    await this.database.tx(principal.rls(), async (tx) => {
      const run = await this.loadRun(tx, principal, runId, true);
      this.requirePrepare(principal, run);
      this.requireDraft(run);
      await tx.update(payrollRun).set({ fxRates: input.rates }).where(eq(payrollRun.id, runId));
      await this.audit.record(tx, { action: 'payroll.fx_rates_set', entityType: 'payroll_run', entityId: runId, companyId: run.companyId, before: run.fxRates, after: input.rates });
    });
    return this.get(principal, runId);
  }

  /** Submit for approval; the preparer cannot approve (no self-approval in the workflow). */
  async submit(principal: Principal, runId: string): Promise<PayRunDetailDto> {
    await this.database.tx(principal.rls(), async (tx) => {
      const run = await this.loadRun(tx, principal, runId, true);
      this.requirePrepare(principal, run);
      this.requireDraft(run);
      if (!run.calculatedAt) throw ApiError.conflict('Calculate the payroll first');
      const lines = await tx.select({ n: sql<number>`count(*)::int` }).from(payrollLine).where(eq(payrollLine.runId, runId));
      if (!lines[0]?.n) throw ApiError.conflict('The payroll has no employees');
      const totals = await this.totals(tx, [runId]);
      await tx.update(payrollRun).set({ status: 'submitted' }).where(eq(payrollRun.id, runId));
      const inst = await this.workflow.start(tx, principal, {
        definitionKey: 'payroll.run',
        companyId: run.companyId,
        subjectType: 'payroll_run',
        subjectId: runId,
        summary: { period: run.period, revision: run.revision, ...Object.fromEntries((totals.get(runId) ?? []).map((t) => [`net ${t.currency}`, t.net.toFixed(2)])) },
      });
      await tx.update(payrollRun).set({ workflowInstanceId: inst.id }).where(eq(payrollRun.id, runId));
      await this.audit.record(tx, { action: 'payroll.submitted', entityType: 'payroll_run', entityId: runId, companyId: run.companyId });
    });
    return this.get(principal, runId);
  }

  /** PAY-05: reopening keeps the approved run (superseded) and starts a new revision. */
  async reopen(principal: Principal, runId: string, reason: string): Promise<PayRunDetailDto> {
    const newId = uuidv7();
    await this.database.tx(principal.rls(), async (tx) => {
      const run = await this.loadRun(tx, principal, runId, true);
      if (!principal.canCompany('payroll.reopen', run.companyId)) throw ApiError.forbidden('Reopening payroll needs the special permission');
      if (run.status !== 'approved') throw ApiError.conflict('Only approved payroll can be reopened');
      await tx.update(payrollRun).set({ status: 'superseded' }).where(eq(payrollRun.id, runId));
      await tx.insert(payrollRun).values({
        id: newId,
        companyId: run.companyId,
        period: run.period,
        periodStart: run.periodStart,
        periodEnd: run.periodEnd,
        revision: run.revision + 1,
        revisionOfId: run.id,
        fxRates: run.fxRates,
        reopenReason: reason,
        reopenedBy: principal.userId,
        createdBy: principal.userId,
      });
      const manual = await tx.select().from(payrollManualItem).where(eq(payrollManualItem.runId, runId));
      if (manual.length) {
        await tx.insert(payrollManualItem).values(manual.map((m) => ({ ...m, id: uuidv7(), runId: newId, createdBy: principal.userId, createdAt: new Date() })));
      }
      await this.audit.record(tx, { action: 'payroll.reopened', entityType: 'payroll_run', entityId: newId, companyId: run.companyId, details: { previous: runId, revision: run.revision + 1, reason } });
    });
    if (principal.canCompany('payroll.prepare', (await this.getRunRow(principal, newId)).companyId)) return this.calculate(principal, newId);
    return this.get(principal, newId);
  }

  private async getRunRow(principal: Principal, id: string) {
    return this.database.tx(principal.rls(), (tx) => this.loadRun(tx, principal, id));
  }

  // --- payments (PAY-06) -------------------------------------------------------------------------

  async addPayment(principal: Principal, lineId: string, input: z.infer<typeof paymentInput>): Promise<PayLineDto> {
    const runId = await this.database.tx(principal.rls(), async (tx) => {
      const [line] = await tx.select().from(payrollLine).where(eq(payrollLine.id, lineId));
      if (!line || !principal.canCompany('payroll.payments.manage', line.companyId)) throw ApiError.notFound('Payroll line');
      const [run] = await tx.select().from(payrollRun).where(eq(payrollRun.id, line.runId));
      if (run!.status !== 'approved') throw ApiError.conflict('Payments are recorded for approved payroll');
      await tx.insert(payrollPayment).values({
        id: uuidv7(),
        lineId,
        status: input.status,
        method: input.method,
        reference: input.reference ?? null,
        paidOn: input.paidOn ?? null,
        amount: input.amount.toFixed(2),
        currency: line.currency,
        note: input.note ?? null,
        createdBy: principal.userId,
      });
      await this.audit.record(tx, { action: 'payroll.payment_recorded', entityType: 'payroll_line', entityId: lineId, companyId: line.companyId, after: input });
      return line.runId;
    });
    const detail = await this.get(principal, runId);
    return detail.lines.find((l) => l.id === lineId)!;
  }

  // --- reading -------------------------------------------------------------------------------------

  private async totals(tx: Tx, runIds: string[]): Promise<Map<string, PayRunDto['totals']>> {
    const out = new Map<string, PayRunDto['totals']>();
    if (!runIds.length) return out;
    const rows = await tx
      .select({
        runId: payrollLine.runId,
        currency: payrollLine.currency,
        gross: sql<string>`sum(${payrollLine.gross})`,
        deductions: sql<string>`sum(${payrollLine.deductions})`,
        net: sql<string>`sum(${payrollLine.net})`,
        employees: sql<number>`count(*)::int`,
      })
      .from(payrollLine)
      .where(inArray(payrollLine.runId, runIds))
      .groupBy(payrollLine.runId, payrollLine.currency);
    for (const r of rows) {
      const list = out.get(r.runId) ?? [];
      list.push({ currency: r.currency, gross: Number(r.gross), deductions: Number(r.deductions), net: Number(r.net), employees: r.employees });
      out.set(r.runId, list);
    }
    return out;
  }

  private toRunDto(r: RunRow, totals: PayRunDto['totals']): PayRunDto {
    return {
      id: r.id,
      companyId: r.companyId,
      period: r.period,
      periodStart: r.periodStart,
      periodEnd: r.periodEnd,
      revision: r.revision,
      revisionOfId: r.revisionOfId,
      status: r.status,
      lockedAt: r.lockedAt?.toISOString() ?? null,
      reopenReason: r.reopenReason,
      workflowInstanceId: r.workflowInstanceId,
      fxRates: r.fxRates,
      totals,
      createdAt: r.createdAt.toISOString(),
      calculatedAt: r.calculatedAt?.toISOString() ?? null,
    };
  }

  async list(principal: Principal, companyId: string): Promise<PayRunDto[]> {
    if (!this.canSee(principal, companyId)) throw ApiError.notFound('Company');
    return this.database.tx(principal.rls(), async (tx) => {
      const runs = await tx.select().from(payrollRun).where(eq(payrollRun.companyId, companyId)).orderBy(desc(payrollRun.period), desc(payrollRun.revision)).limit(120);
      const totals = await this.totals(tx, runs.map((r) => r.id));
      return runs.map((r) => this.toRunDto(r, totals.get(r.id) ?? []));
    });
  }

  private async lineDtos(tx: Tx, lines: LineRow[]): Promise<PayLineDto[]> {
    if (!lines.length) return [];
    const items = await tx.select().from(payrollItem).where(inArray(payrollItem.lineId, lines.map((l) => l.id))).orderBy(asc(payrollItem.seq));
    const pays = await tx.select().from(payrollPayment).where(inArray(payrollPayment.lineId, lines.map((l) => l.id))).orderBy(asc(payrollPayment.createdAt));
    const emps = await tx
      .select({ id: employee.id, no: employee.employeeNo, ar: employee.fullNameAr, en: employee.fullNameEn })
      .from(employee)
      .where(inArray(employee.id, [...new Set(lines.map((l) => l.employeeId))]));
    return lines
      .map((l) => {
        const e = emps.find((x) => x.id === l.employeeId);
        return {
          id: l.id,
          employeeId: l.employeeId,
          employeeNo: e?.no ?? '',
          employeeName: { ar: e?.ar ?? '', en: e?.en ?? '' },
          currency: l.currency,
          daysPaid: l.daysPaid,
          periodDays: l.periodDays,
          gross: Number(l.gross),
          deductions: Number(l.deductions),
          net: Number(l.net),
          warnings: l.warnings,
          items: items
            .filter((i) => i.lineId === l.id)
            .map((i) => ({
              // Manual items carry the id of the entry, so they can be removed.
              id: i.manualItemId ?? i.id,
              kind: i.kind,
              source: i.source,
              code: i.code,
              label: i.label,
              quantity: num(i.quantity),
              rate: num(i.rate),
              amount: Number(i.amount),
              explanation: i.explanation,
            })),
          payments: pays
            .filter((p) => p.lineId === l.id)
            .map((p) => ({
              id: p.id,
              status: p.status,
              method: p.method,
              reference: p.reference,
              paidOn: p.paidOn,
              amount: Number(p.amount),
              currency: p.currency,
              note: p.note,
              createdAt: p.createdAt.toISOString(),
            })),
        };
      })
      .sort((a, b) => a.employeeNo.localeCompare(b.employeeNo));
  }

  async get(principal: Principal, id: string): Promise<PayRunDetailDto> {
    return this.database.tx(principal.rls(), async (tx) => {
      const run = await this.loadRun(tx, principal, id);
      const lines = await tx.select().from(payrollLine).where(eq(payrollLine.runId, id));
      const totals = await this.totals(tx, [id]);
      return { ...this.toRunDto(run, totals.get(id) ?? []), lines: await this.lineDtos(tx, lines) };
    });
  }

  // --- payslips (PAY-03, NEG-01) -----------------------------------------------------------------

  private async payslipDto(tx: Tx, line: LineRow, run: RunRow): Promise<PayslipDto> {
    const [dto] = await this.lineDtos(tx, [line]);
    const [co] = await tx.select().from(company).where(eq(company.id, run.companyId));
    const policy = await this.settings.getWith(tx, 'payroll.policy', run.companyId);
    const payDay = Math.min(policy.payDay, Number(run.periodEnd.slice(8, 10)));
    return {
      runId: run.id,
      lineId: line.id,
      companyId: run.companyId,
      companyName: { ar: co?.nameAr ?? '', en: co?.nameEn ?? '' },
      period: run.period,
      payDay: `${run.period}-${String(payDay).padStart(2, '0')}`,
      employeeNo: dto!.employeeNo,
      employeeName: dto!.employeeName,
      currency: dto!.currency,
      daysPaid: dto!.daysPaid,
      gross: dto!.gross,
      deductions: dto!.deductions,
      net: dto!.net,
      // Employees see the items; manual ids and internals are not needed.
      items: dto!.items,
      paymentStatus: dto!.payments.at(-1)?.status ?? null,
    };
  }

  async myPayslips(principal: Principal): Promise<PayslipDto[]> {
    const me = principal.employeeId;
    if (!me || !principal.canSelf('payroll.payslip.view', me)) return [];
    return this.database.tx(principal.rls(), async (tx) => {
      const rows = await tx
        .select({ l: payrollLine, r: payrollRun })
        .from(payrollLine)
        .innerJoin(payrollRun, eq(payrollRun.id, payrollLine.runId))
        .where(and(eq(payrollLine.employeeId, me), eq(payrollRun.status, 'approved')))
        .orderBy(desc(payrollRun.period));
      const out: PayslipDto[] = [];
      for (const { l, r } of rows) out.push(await this.payslipDto(tx, l, r));
      return out;
    });
  }

  async payslip(principal: Principal, lineId: string): Promise<PayslipDto> {
    return this.database.tx(principal.rls(), async (tx) => {
      const [row] = await tx.select({ l: payrollLine, r: payrollRun }).from(payrollLine).innerJoin(payrollRun, eq(payrollRun.id, payrollLine.runId)).where(eq(payrollLine.id, lineId));
      if (!row) throw ApiError.notFound('Payslip');
      const own = row.l.employeeId === principal.employeeId && principal.canSelf('payroll.payslip.view', row.l.employeeId) && row.r.status === 'approved';
      if (!own && !this.canSee(principal, row.l.companyId)) throw ApiError.notFound('Payslip');
      return this.payslipDto(tx, row.l, row.r);
    });
  }

  // --- group summary (PAY-02, Q-13) ---------------------------------------------------------------

  async summary(principal: Principal, period: string): Promise<GroupSummaryDto> {
    const scope = principal.scope('payroll.summary.view');
    if (!scope.all && !scope.companyIds.length) throw ApiError.forbidden();
    const target = await this.settings.get('general.defaultCurrency');
    return this.database.tx(principal.rls(), async (tx) => {
      const companies = await tx.select({ id: company.id }).from(company).orderBy(asc(company.code));
      const visible = companies.filter((c) => scope.all || scope.companyIds.includes(c.id));
      const runs = await tx.select().from(payrollRun).where(and(eq(payrollRun.period, period), ne(payrollRun.status, 'superseded')));
      const totals = await this.totals(tx, runs.map((r) => r.id));
      const group = new Map<string, GroupSummaryDto['totals'][number]>();
      let convertedNet = 0;
      const missing = new Set<string>();
      const rows = visible.map((c) => {
        const run = runs.find((r) => r.companyId === c.id) ?? null;
        const t = run ? (totals.get(run.id) ?? []) : [];
        for (const x of t) {
          const g = group.get(x.currency) ?? { currency: x.currency, gross: 0, deductions: 0, net: 0, employees: 0 };
          g.gross = round2(g.gross + x.gross);
          g.deductions = round2(g.deductions + x.deductions);
          g.net = round2(g.net + x.net);
          g.employees += x.employees;
          group.set(x.currency, g);
          const rate = x.currency === target ? 1 : run!.fxRates[x.currency];
          if (rate === undefined) missing.add(x.currency);
          else convertedNet += x.net * rate;
        }
        return { companyId: c.id, runId: run?.id ?? null, status: run?.status ?? null, totals: t };
      });
      return {
        period,
        companies: rows,
        totals: [...group.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
        converted: target ? { currency: target, net: round2(convertedNet), missingRates: [...missing].sort() } : null,
      };
    });
  }

  // --- end of service (PAY-11) ---------------------------------------------------------------------

  async endOfService(principal: Principal, employeeId: string, endDate: string): Promise<EndOfServiceDto> {
    const ctx = await this.database.tx(principal.rls(), async (tx) => {
      const [e] = await tx.select().from(employee).where(eq(employee.id, employeeId));
      const [a] = await tx
        .select({ companyId: employmentAssignment.companyId })
        .from(employmentAssignment)
        .where(and(eq(employmentAssignment.employeeId, employeeId), lte(employmentAssignment.validFrom, endDate)))
        .orderBy(desc(employmentAssignment.validFrom));
      if (!e || !a || !this.canSee(principal, a.companyId)) throw ApiError.notFound('Employee');
      const [pay] = await tx
        .select()
        .from(compensation)
        .where(and(eq(compensation.employeeId, employeeId), eq(compensation.companyId, a.companyId), lte(compensation.validFrom, endDate)))
        .orderBy(desc(compensation.validFrom));
      return { hireDate: e.hireDate, companyId: a.companyId, base: pay ? Number(pay.baseSalary) : 0, currency: pay?.currency ?? '' };
    });
    const policy = await this.settings.get('payroll.endOfService', ctx.companyId);
    const r = endOfService(policy, ctx.hireDate, endDate, ctx.base);
    return { employeeId, endDate, serviceYears: r.years, monthlyBase: ctx.base, currency: ctx.currency, amount: r.amount, explanation: r.explanation };
  }
}
