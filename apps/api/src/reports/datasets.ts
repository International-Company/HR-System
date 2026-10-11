import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, ne, or } from 'drizzle-orm';
import type { ReportFilters } from '@hrms/shared';
import type { Tx } from '../db/database.js';
import {
  attendanceDay,
  candidate,
  company,
  compensation,
  contract,
  department,
  employee,
  employeeCurrentAssignment,
  employmentAssignment,
  evaluationResult,
  jobApplication,
  leaveRequest,
  leaveType,
  lifecycleEvent,
  lookupValue,
  payrollLine,
  payrollPayment,
  payrollRun,
  separation,
  vacancy,
} from '../db/schema.js';
import type { Principal } from '../access/principal.js';
import type { LeaveService } from '../leave/leave.service.js';
import { addDays } from '../attendance/time.js';

export type Row = Record<string, string | number | null>;

export interface DatasetContext {
  principal: Principal;
  filters: ReportFilters;
  /** null = the whole company; otherwise only these departments (department-scoped users). */
  departments: string[] | null;
  lang: 'ar' | 'en';
  today: string;
  /** A read transaction under the user's row-level security. */
  tx: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
  leave: LeaveService;
}

const MAX_RANGE_DAYS = 366;

function range(ctx: DatasetContext, defaultDays: number): { from: string; to: string } {
  const to = ctx.filters.to ?? ctx.today;
  const from = ctx.filters.from ?? addDays(to, -defaultDays + 1);
  if (from > to) throw new RangeError('from after to');
  if (Date.parse(to) - Date.parse(from) > MAX_RANGE_DAYS * 86_400_000) throw new RangeError('range too long');
  return { from, to };
}

interface Person {
  employeeNo: string;
  nameAr: string;
  nameEn: string;
  company: string;
  department: string;
  departmentId: string | null;
  jobTitle: string;
}

/** Names of people with their current company/department in the user's language. */
async function people(tx: Tx, lang: 'ar' | 'en', ids: string[]): Promise<Map<string, Person>> {
  const out = new Map<string, Person>();
  if (!ids.length) return out;
  const rows = await tx
    .select({
      id: employee.id,
      no: employee.employeeNo,
      ar: employee.fullNameAr,
      en: employee.fullNameEn,
      coAr: company.nameAr,
      coEn: company.nameEn,
      depId: employeeCurrentAssignment.departmentId,
      depAr: department.nameAr,
      depEn: department.nameEn,
      jobAr: lookupValue.nameAr,
      jobEn: lookupValue.nameEn,
    })
    .from(employee)
    .leftJoin(employeeCurrentAssignment, eq(employeeCurrentAssignment.employeeId, employee.id))
    .leftJoin(company, eq(company.id, employeeCurrentAssignment.companyId))
    .leftJoin(department, eq(department.id, employeeCurrentAssignment.departmentId))
    .leftJoin(lookupValue, eq(lookupValue.id, employeeCurrentAssignment.jobTitleId))
    .where(inArray(employee.id, [...new Set(ids)]));
  for (const r of rows) {
    out.set(r.id, {
      employeeNo: r.no,
      nameAr: r.ar,
      nameEn: r.en,
      company: (lang === 'ar' ? r.coAr : r.coEn) ?? '',
      department: (lang === 'ar' ? r.depAr : r.depEn) ?? '',
      departmentId: r.depId ?? null,
      jobTitle: (lang === 'ar' ? r.jobAr : r.jobEn) ?? '',
    });
  }
  return out;
}

/** Keep rows of employees the user may see (department scope and filter). */
function inScope(ctx: DatasetContext, p: Person | undefined): p is Person {
  if (!p) return false;
  if (ctx.filters.departmentId && p.departmentId !== ctx.filters.departmentId) return false;
  return ctx.departments === null || (!!p.departmentId && ctx.departments.includes(p.departmentId));
}

const personCols = (p: Person) => ({ employeeNo: p.employeeNo, nameAr: p.nameAr, nameEn: p.nameEn, company: p.company, department: p.department });

async function companyName(tx: Tx, id: string, lang: 'ar' | 'en'): Promise<string> {
  const [c] = await tx.select().from(company).where(eq(company.id, id));
  return (lang === 'ar' ? c?.nameAr : c?.nameEn) ?? '';
}

type Runner = (ctx: DatasetContext) => Promise<Row[]>;

export const RUNNERS: Record<string, Runner> = {
  async employees(ctx) {
    return ctx.tx(async (tx) => {
      const rows = await tx
        .select({ e: employee })
        .from(employee)
        .innerJoin(employeeCurrentAssignment, eq(employeeCurrentAssignment.employeeId, employee.id))
        .where(and(eq(employeeCurrentAssignment.companyId, ctx.filters.companyId), ctx.filters.status ? eq(employee.status, ctx.filters.status as 'active') : ne(employee.status, 'terminated')))
        .orderBy(asc(employee.employeeNo))
        .limit(5001);
      const ids = rows.map((r) => r.e.id);
      const names = await people(tx, ctx.lang, ids);
      const pay = ids.length
        ? await tx
            .select()
            .from(compensation)
            .where(and(inArray(compensation.employeeId, ids), eq(compensation.companyId, ctx.filters.companyId), lte(compensation.validFrom, ctx.today), or(isNull(compensation.validTo), gte(compensation.validTo, ctx.today))))
        : [];
      return rows
        .filter((r) => inScope(ctx, names.get(r.e.id)))
        .map(({ e }) => {
          const p = names.get(e.id)!;
          const c = pay.find((x) => x.employeeId === e.id);
          return {
            ...personCols(p),
            jobTitle: p.jobTitle,
            status: e.status,
            hireDate: e.hireDate,
            nationality: e.nationality,
            gender: e.gender,
            email: e.email,
            phone: e.phone,
            birthDate: e.birthDate,
            baseSalary: c ? Number(c.baseSalary) : null,
            currency: c?.currency ?? null,
          };
        });
    });
  },

  async attendance_days(ctx) {
    const { from, to } = range(ctx, 31);
    return ctx.tx(async (tx) => {
      const rows = await tx
        .select()
        .from(attendanceDay)
        .where(
          and(
            eq(attendanceDay.companyId, ctx.filters.companyId),
            gte(attendanceDay.workDate, from),
            lte(attendanceDay.workDate, to),
            ctx.filters.status ? eq(attendanceDay.status, ctx.filters.status as 'present') : inArray(attendanceDay.status, ['present', 'incomplete', 'absent_pending', 'absent_confirmed', 'excused']),
          ),
        )
        .orderBy(asc(attendanceDay.workDate))
        .limit(5001);
      const names = await people(tx, ctx.lang, rows.map((r) => r.employeeId));
      const hhmm = (d: Date | null) => (d ? d.toISOString().slice(11, 16) : null);
      return rows
        .filter((r) => inScope(ctx, names.get(r.employeeId)))
        .map((d) => ({
          ...personCols(names.get(d.employeeId)!),
          date: d.workDate,
          status: d.status,
          firstIn: hhmm(d.firstIn),
          lastOut: hhmm(d.lastOut),
          workedMinutes: d.workedMinutes,
          lateMinutes: d.lateMinutes,
          earlyMinutes: d.earlyMinutes,
          overtimeMinutes: d.overtimeMinutes,
          flags: d.flags.join(', '),
        }));
    });
  },

  async attendance_summary(ctx) {
    const { from, to } = range(ctx, 31);
    return ctx.tx(async (tx) => {
      const rows = await tx
        .select()
        .from(attendanceDay)
        .where(and(eq(attendanceDay.companyId, ctx.filters.companyId), gte(attendanceDay.workDate, from), lte(attendanceDay.workDate, to)));
      const names = await people(tx, ctx.lang, rows.map((r) => r.employeeId));
      const by = new Map<string, Row & { _w: number }>();
      for (const d of rows) {
        const p = names.get(d.employeeId);
        if (!inScope(ctx, p)) continue;
        const r: Row & { _w: number } = by.get(d.employeeId) ?? { ...personCols(p), presentDays: 0, absentDays: 0, possibleAbsences: 0, lateDays: 0, lateMinutes: 0, earlyDays: 0, overtimeMinutes: 0, workedHours: 0, _w: 0 };
        const n = (k: string) => (r[k] as number) + 1;
        if (d.status === 'present' || d.status === 'incomplete') r.presentDays = n('presentDays');
        if (d.status === 'absent_confirmed') r.absentDays = n('absentDays');
        if (d.status === 'absent_pending') r.possibleAbsences = n('possibleAbsences');
        if (d.lateMinutes > 0) r.lateDays = n('lateDays');
        if (d.earlyMinutes > 0) r.earlyDays = n('earlyDays');
        r.lateMinutes = (r.lateMinutes as number) + d.lateMinutes;
        r.overtimeMinutes = (r.overtimeMinutes as number) + d.overtimeMinutes;
        r._w += d.workedMinutes;
        by.set(d.employeeId, r);
      }
      return [...by.values()]
        .map(({ _w, ...r }): Row => ({ ...r, workedHours: Math.round((_w / 60) * 100) / 100 }))
        .sort((a, b) => String(a['employeeNo']).localeCompare(String(b['employeeNo'])));
    });
  },

  async leave_balances(ctx) {
    const ids = await ctx.tx(async (tx) => {
      const rows = await tx
        .select({ id: employee.id })
        .from(employee)
        .innerJoin(employeeCurrentAssignment, eq(employeeCurrentAssignment.employeeId, employee.id))
        .where(and(eq(employeeCurrentAssignment.companyId, ctx.filters.companyId), ne(employee.status, 'terminated')))
        .limit(1000);
      const names = await people(tx, ctx.lang, rows.map((r) => r.id));
      return [...names.entries()].filter(([, p]) => inScope(ctx, p)).sort((a, b) => a[1].employeeNo.localeCompare(b[1].employeeNo));
    });
    const out: Row[] = [];
    // Balances are computed by the leave rules (one employee at a time, outside other transactions).
    for (const [id, p] of ids) {
      for (const b of await ctx.leave.balances(ctx.principal, id)) {
        out.push({ ...personCols(p), leaveType: ctx.lang === 'ar' ? b.nameAr : b.nameEn, balance: b.tracked ? b.balance : null, pending: b.pending, available: b.tracked ? b.available : null, usedThisYear: b.usedThisYear });
      }
    }
    return out;
  },

  async leave_requests(ctx) {
    const { from, to } = range(ctx, 92);
    return ctx.tx(async (tx) => {
      const rows = await tx
        .select({ r: leaveRequest, ar: leaveType.nameAr, en: leaveType.nameEn })
        .from(leaveRequest)
        .innerJoin(leaveType, eq(leaveType.id, leaveRequest.leaveTypeId))
        .where(
          and(
            eq(leaveRequest.companyId, ctx.filters.companyId),
            lte(leaveRequest.startDate, to),
            gte(leaveRequest.endDate, from),
            ctx.filters.status ? eq(leaveRequest.status, ctx.filters.status as 'approved') : undefined,
          ),
        )
        .orderBy(asc(leaveRequest.startDate))
        .limit(5001);
      const names = await people(tx, ctx.lang, rows.map((x) => x.r.employeeId));
      return rows
        .filter((x) => inScope(ctx, names.get(x.r.employeeId)))
        .map(({ r, ar, en }) => ({ ...personCols(names.get(r.employeeId)!), leaveType: ctx.lang === 'ar' ? ar : en, startDate: r.startDate, endDate: r.endDate, days: Number(r.days), status: r.status }));
    });
  },

  async payroll(ctx) {
    const month = ctx.filters.month ?? ctx.today.slice(0, 7);
    return ctx.tx(async (tx) => {
      const [run] = await tx.select().from(payrollRun).where(and(eq(payrollRun.companyId, ctx.filters.companyId), eq(payrollRun.period, month), ne(payrollRun.status, 'superseded')));
      if (!run) return [];
      const lines = await tx.select().from(payrollLine).where(eq(payrollLine.runId, run.id));
      const pays = lines.length ? await tx.select().from(payrollPayment).where(inArray(payrollPayment.lineId, lines.map((l) => l.id))).orderBy(asc(payrollPayment.createdAt)) : [];
      const names = await people(tx, ctx.lang, lines.map((l) => l.employeeId));
      return lines
        .filter((l) => inScope(ctx, names.get(l.employeeId)))
        .map((l) => ({
          ...personCols(names.get(l.employeeId)!),
          runStatus: run.status,
          currency: l.currency,
          daysPaid: l.daysPaid,
          gross: Number(l.gross),
          deductions: Number(l.deductions),
          net: Number(l.net),
          paymentStatus: pays.filter((p) => p.lineId === l.id).at(-1)?.status ?? null,
        }))
        .sort((a, b) => String(a.employeeNo).localeCompare(String(b.employeeNo)));
    });
  },

  async employee_costs(ctx) {
    const rows = await RUNNERS.payroll!(ctx);
    const by = new Map<string, Row>();
    for (const r of rows) {
      const key = `${r.department}|${r.currency}`;
      const g: Row = by.get(key) ?? { company: r.company ?? null, department: r.department ?? null, currency: r.currency ?? null, employees: 0, gross: 0, deductions: 0, net: 0 };
      g.employees = (g.employees as number) + 1;
      for (const k of ['gross', 'deductions', 'net'] as const) g[k] = Math.round(((g[k] as number) + (r[k] as number)) * 100) / 100;
      by.set(key, g);
    }
    return [...by.values()];
  },

  async contracts(ctx) {
    return ctx.tx(async (tx) => {
      const within = ctx.filters.withinDays;
      const rows = await tx
        .select({ c: contract, ar: lookupValue.nameAr, en: lookupValue.nameEn })
        .from(contract)
        .leftJoin(lookupValue, eq(lookupValue.id, contract.contractTypeId))
        .where(
          and(
            eq(contract.companyId, ctx.filters.companyId),
            ctx.filters.status ? eq(contract.status, ctx.filters.status as 'active') : undefined,
            within ? and(eq(contract.status, 'active'), gte(contract.endDate, ctx.today), lte(contract.endDate, addDays(ctx.today, within))) : undefined,
          ),
        )
        .orderBy(asc(contract.endDate))
        .limit(5001);
      const names = await people(tx, ctx.lang, rows.map((x) => x.c.employeeId));
      return rows
        .filter((x) => inScope(ctx, names.get(x.c.employeeId)))
        .map(({ c, ar, en }) => ({
          ...personCols(names.get(c.employeeId)!),
          contractNo: c.contractNo,
          contractType: (ctx.lang === 'ar' ? ar : en) ?? '',
          status: c.status,
          startDate: c.startDate,
          endDate: c.endDate,
          daysLeft: c.endDate ? Math.round((Date.parse(c.endDate) - Date.parse(ctx.today)) / 86_400_000) : null,
          probationEnd: c.probationEnd,
        }));
    });
  },

  async recruitment(ctx) {
    const { from, to } = range(ctx, 366);
    return ctx.tx(async (tx) => {
      const rows = await tx
        .select({ a: jobApplication, v: vacancy, c: candidate })
        .from(jobApplication)
        .innerJoin(vacancy, eq(vacancy.id, jobApplication.vacancyId))
        .innerJoin(candidate, eq(candidate.id, jobApplication.candidateId))
        .where(and(eq(jobApplication.companyId, ctx.filters.companyId), gte(jobApplication.createdAt, new Date(`${from}T00:00:00Z`)), lte(jobApplication.createdAt, new Date(`${to}T23:59:59Z`))))
        .orderBy(desc(jobApplication.createdAt))
        .limit(5001);
      const co = await companyName(tx, ctx.filters.companyId, ctx.lang);
      return rows
        .filter(({ v }) => ctx.departments === null || (!!v.departmentId && ctx.departments.includes(v.departmentId)))
        .map(({ a, v, c }) => ({
          company: co,
          vacancy: v.title,
          vacancyStatus: v.status,
          candidate: ctx.lang === 'ar' ? c.fullNameAr : c.fullNameEn,
          source: c.source,
          stage: a.stage,
          outcome: a.outcome,
          hired: a.employeeId ? 'yes' : 'no',
          appliedOn: a.createdAt.toISOString().slice(0, 10),
        }));
    });
  },

  async separations(ctx) {
    const { from, to } = range(ctx, 366);
    return ctx.tx(async (tx) => {
      const rows = await tx
        .select()
        .from(separation)
        .where(
          and(
            eq(separation.companyId, ctx.filters.companyId),
            gte(separation.lastWorkingDay, from),
            lte(separation.lastWorkingDay, to),
            ctx.filters.status ? eq(separation.status, ctx.filters.status as 'completed') : undefined,
          ),
        )
        .orderBy(asc(separation.lastWorkingDay))
        .limit(5001);
      const names = await people(tx, ctx.lang, rows.map((r) => r.employeeId));
      return rows
        .filter((r) => inScope(ctx, names.get(r.employeeId)))
        .map((s) => ({
          ...personCols(names.get(s.employeeId)!),
          type: s.type,
          status: s.status,
          lastWorkingDay: s.lastWorkingDay,
          reason: s.reason,
          rehireEligible: s.rehireEligible ? 'yes' : 'no',
          settlement: s.settlement?.amount ?? null,
        }));
    });
  },

  async turnover(ctx) {
    const { from, to } = range(ctx, 366);
    return ctx.tx(async (tx) => {
      const covering = async (date: string) =>
        (
          await tx
            .selectDistinct({ e: employmentAssignment.employeeId })
            .from(employmentAssignment)
            .where(and(eq(employmentAssignment.companyId, ctx.filters.companyId), lte(employmentAssignment.validFrom, date), or(isNull(employmentAssignment.validTo), gte(employmentAssignment.validTo, date))))
        ).length;
      const start = await covering(from);
      const end = await covering(to);
      const hires = (
        await tx
          .select({ id: lifecycleEvent.id })
          .from(lifecycleEvent)
          .where(and(eq(lifecycleEvent.companyId, ctx.filters.companyId), inArray(lifecycleEvent.type, ['hire', 'rehire']), gte(lifecycleEvent.effectiveDate, from), lte(lifecycleEvent.effectiveDate, to)))
      ).length;
      const leavers = (
        await tx
          .select({ id: separation.id })
          .from(separation)
          .where(and(eq(separation.companyId, ctx.filters.companyId), eq(separation.status, 'completed'), gte(separation.lastWorkingDay, from), lte(separation.lastWorkingDay, to)))
      ).length;
      const avg = (start + end) / 2;
      return [{ company: await companyName(tx, ctx.filters.companyId, ctx.lang), headcountStart: start, hires, leavers, headcountEnd: end, turnoverRate: avg > 0 ? Math.round((leavers / avg) * 10000) / 100 : 0 }];
    });
  },

  async evaluation(ctx) {
    return ctx.tx(async (tx) => {
      const rows = await tx
        .select()
        .from(evaluationResult)
        .where(
          and(
            eq(evaluationResult.companyId, ctx.filters.companyId),
            ctx.filters.status ? eq(evaluationResult.status, ctx.filters.status as 'final') : undefined,
            ctx.filters.from ? gte(evaluationResult.periodStart, ctx.filters.from) : undefined,
            ctx.filters.to ? lte(evaluationResult.periodEnd, ctx.filters.to) : undefined,
            isNotNull(evaluationResult.score),
          ),
        )
        .orderBy(desc(evaluationResult.periodStart))
        .limit(5001);
      const names = await people(tx, ctx.lang, rows.map((r) => r.employeeId));
      return rows
        .filter((r) => inScope(ctx, names.get(r.employeeId)))
        .map((r) => ({ ...personCols(names.get(r.employeeId)!), period: r.period, score: Number(r.score), band: ctx.lang === 'ar' ? r.band.nameAr : r.band.nameEn, status: r.status }));
    });
  },
};
