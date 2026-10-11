import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gte, inArray, isNull, lte, or } from 'drizzle-orm';
import type { EvaluationResultDto } from '@hrms/shared';
import { DATABASE } from '../common/tokens.js';
import type { Database, Tx } from '../db/database.js';
import { attendanceDay, employee, employeeCurrentAssignment, employmentAssignment, evaluationResult } from '../db/schema.js';
import { ApiError } from '../common/errors.js';
import { uuidv7 } from '../common/ids.js';
import type { Principal } from '../access/principal.js';
import { AuditService } from '../audit/audit.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { ModulesService } from '../settings/modules.service.js';
import { CalendarService, eachDay } from '../calendar/calendar.service.js';
import { AttendanceService } from '../attendance/attendance.service.js';
import { localDate } from '../attendance/time.js';
import { computeEvaluation, periodRange, type EvalDay } from './score.js';

type ResultRow = typeof evaluationResult.$inferSelect;

const minutesOf = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const maxS = (a: string, b: string) => (a > b ? a : b);
const minS = (a: string, b: string) => (a < b ? a : b);

/**
 * Attendance commitment evaluation (CEV-01..03): scored from attendance days only, stored with
 * its inputs, finalised, and recalculated only with an audited reason.
 */
@Injectable()
export class EvaluationService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(ModulesService) private readonly modules: ModulesService,
    @Inject(CalendarService) private readonly calendar: CalendarService,
    @Inject(AttendanceService) private readonly attendance: AttendanceService,
  ) {}

  private requireManage(principal: Principal, companyId: string) {
    if (!principal.canCompany('evaluation.manage', companyId)) throw ApiError.forbidden();
  }

  /**
   * Calculate (or recalculate) everyone employed in the company during the period. Finalised
   * results change only with a reason (CEV-02 recalculation, audited).
   */
  async calculate(principal: Principal, companyId: string, period: string, reason?: string): Promise<{ calculated: number; skippedFinal: number }> {
    this.requireManage(principal, companyId);
    if ((await this.modules.access('evaluation', companyId)) !== 'enabled') throw new ApiError(403, 'MODULE_DISABLED', 'Evaluation is disabled for this company');
    const policy = await this.settings.get('evaluation.policy', companyId);
    if ((policy.period === 'quarterly') !== period.includes('Q')) {
      throw ApiError.validation([{ path: 'period', message: policy.period === 'quarterly' ? 'Use a quarter such as 2026-Q1' : 'Use a month such as 2026-03' }]);
    }
    const today = localDate(new Date(), await this.settings.get('general.timezone'));
    const range = periodRange(period);
    if (range.start > today) throw ApiError.validation([{ path: 'period', message: 'The period has not started' }]);
    const last = minS(range.end, today);
    const out = { calculated: 0, skippedFinal: 0 };
    await this.database.tx(principal.rls(), async (tx) => {
      const assigns = await tx
        .select()
        .from(employmentAssignment)
        .where(and(eq(employmentAssignment.companyId, companyId), lte(employmentAssignment.validFrom, last), or(isNull(employmentAssignment.validTo), gte(employmentAssignment.validTo, range.start))));
      const people = [...new Set(assigns.map((a) => a.employeeId))];
      for (const employeeId of people) {
        const [existing] = await tx.select().from(evaluationResult).where(and(eq(evaluationResult.employeeId, employeeId), eq(evaluationResult.companyId, companyId), eq(evaluationResult.period, period)));
        if (existing?.status === 'final' && !reason) {
          out.skippedFinal++;
          continue;
        }
        const spans = assigns.filter((a) => a.employeeId === employeeId).map((a) => ({ from: maxS(a.validFrom, range.start), to: minS(a.validTo ?? last, last) }));
        const dates = [...new Set(spans.flatMap((s) => (s.from <= s.to ? eachDay(s.from, s.to) : [])))].sort();
        if (!dates.length) continue;
        // Attendance days are recomputed first so the score uses current data.
        await this.attendance.recomputeRange(tx, employeeId, companyId, dates[0]!, dates.at(-1)!);
        const rows = await tx
          .select()
          .from(attendanceDay)
          .where(and(eq(attendanceDay.employeeId, employeeId), eq(attendanceDay.companyId, companyId), inArray(attendanceDay.workDate, dates)));
        const workdays = await this.calendar.resolveWorkdays(tx, employeeId, dates);
        const days: (EvalDay & { date: string })[] = rows.map((d) => {
          const w = workdays.find((x) => x.date === d.workDate);
          let expected = 0;
          if (w?.startTime && w.endTime) {
            const span = (minutesOf(w.endTime) - minutesOf(w.startTime) + 1440) % 1440 || 1440;
            const unpaid = w.breaks.filter((b) => !b.paid).reduce((t, b) => t + Math.max(0, minutesOf(b.endTime) - minutesOf(b.startTime)), 0);
            expected = Math.max(0, span - unpaid);
          }
          return {
            date: d.workDate,
            dayClass: d.dayClass,
            status: d.status,
            lateMinutes: d.lateMinutes,
            earlyMinutes: d.earlyMinutes,
            workedMinutes: d.workedMinutes,
            overtimeMinutes: d.overtimeMinutes,
            expectedMinutes: expected,
          };
        });
        const r = computeEvaluation(days, policy);
        const values = {
          periodStart: range.start,
          periodEnd: range.end,
          score: r.score.toFixed(2),
          band: r.band,
          components: r.components,
          inputs: { days, counts: r.counts } as Record<string, unknown>,
          policy: policy as unknown as Record<string, unknown>,
          calculatedAt: new Date(),
          calculatedBy: principal.userId,
        };
        if (existing) {
          await tx.update(evaluationResult).set({ ...values, calcVersion: existing.calcVersion + 1 }).where(eq(evaluationResult.id, existing.id));
          if (existing.status === 'final') {
            await this.audit.record(tx, {
              action: 'evaluation.recalculated',
              entityType: 'evaluation_result',
              entityId: existing.id,
              companyId,
              before: { score: existing.score, band: existing.band },
              after: { score: r.score, band: r.band, reason },
            });
          }
        } else {
          await tx.insert(evaluationResult).values({ id: uuidv7(), employeeId, companyId, period, ...values });
        }
        out.calculated++;
      }
      await this.audit.record(tx, { action: 'evaluation.calculated', entityType: 'company', entityId: companyId, companyId, details: { period, ...out, reason: reason ?? null } });
    });
    return out;
  }

  async finalize(principal: Principal, companyId: string, period: string): Promise<{ finalized: number }> {
    this.requireManage(principal, companyId);
    const n = await this.database.tx(principal.rls(), async (tx) => {
      const rows = await tx
        .update(evaluationResult)
        .set({ status: 'final', finalizedAt: new Date(), finalizedBy: principal.userId })
        .where(and(eq(evaluationResult.companyId, companyId), eq(evaluationResult.period, period), eq(evaluationResult.status, 'draft')))
        .returning({ id: evaluationResult.id });
      await this.audit.record(tx, { action: 'evaluation.finalized', entityType: 'company', entityId: companyId, companyId, details: { period, count: rows.length } });
      return rows.length;
    });
    return { finalized: n };
  }

  private async dtos(tx: Tx, rows: ResultRow[]): Promise<EvaluationResultDto[]> {
    if (!rows.length) return [];
    const emps = await tx
      .select({ id: employee.id, no: employee.employeeNo, ar: employee.fullNameAr, en: employee.fullNameEn })
      .from(employee)
      .where(inArray(employee.id, [...new Set(rows.map((r) => r.employeeId))]));
    return rows
      .map((r) => {
        const e = emps.find((x) => x.id === r.employeeId);
        return {
          id: r.id,
          employeeId: r.employeeId,
          employeeNo: e?.no ?? '',
          employeeName: { ar: e?.ar ?? '', en: e?.en ?? '' },
          companyId: r.companyId,
          period: r.period,
          periodStart: r.periodStart,
          periodEnd: r.periodEnd,
          score: Number(r.score),
          band: r.band,
          components: r.components,
          status: r.status,
          calcVersion: r.calcVersion,
          calculatedAt: r.calculatedAt.toISOString(),
          finalizedAt: r.finalizedAt?.toISOString() ?? null,
        };
      })
      .sort((a, b) => a.employeeNo.localeCompare(b.employeeNo));
  }

  async list(principal: Principal, companyId: string, period: string): Promise<EvaluationResultDto[]> {
    if (!principal.touchesCompany('evaluation.view', companyId) && !principal.canCompany('evaluation.manage', companyId)) throw ApiError.notFound('Company');
    return this.database.tx(principal.rls(), async (tx) => {
      const rows = await tx
        .select({ r: evaluationResult, dept: employeeCurrentAssignment.departmentId })
        .from(evaluationResult)
        .leftJoin(employeeCurrentAssignment, eq(employeeCurrentAssignment.employeeId, evaluationResult.employeeId))
        .where(and(eq(evaluationResult.companyId, companyId), eq(evaluationResult.period, period)))
        .orderBy(asc(evaluationResult.employeeId));
      const allowed = rows.filter(({ dept }) => principal.canCompany('evaluation.manage', companyId) || principal.canDepartment('evaluation.view', companyId, dept ?? ''));
      return this.dtos(tx, allowed.map((x) => x.r));
    });
  }

  /** Staff in scope; the employee sees own finalised results when the policy allows (CEV-02). */
  async forEmployee(principal: Principal, employeeId: string): Promise<EvaluationResultDto[]> {
    return this.database.tx(principal.rls(), async (tx) => {
      const rows = await tx.select().from(evaluationResult).where(eq(evaluationResult.employeeId, employeeId)).orderBy(asc(evaluationResult.periodStart));
      const [cur] = await tx.select({ d: employeeCurrentAssignment.departmentId }).from(employeeCurrentAssignment).where(eq(employeeCurrentAssignment.employeeId, employeeId));
      const out: ResultRow[] = [];
      for (const r of rows) {
        const staff = principal.canCompany('evaluation.manage', r.companyId) || principal.canDepartment('evaluation.view', r.companyId, cur?.d ?? '');
        const self = principal.canSelf('evaluation.view', employeeId) && r.status === 'final' && (await this.settings.getWith(tx, 'evaluation.policy', r.companyId)).employeeVisible;
        if (staff || self) out.push(r);
      }
      // Nothing visible gives an empty list, which does not reveal whether results exist.
      return this.dtos(tx, out);
    });
  }
}
