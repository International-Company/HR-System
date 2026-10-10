import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gte, inArray, isNull, lte, or, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import type {
  HolidayDto,
  ScheduleAssignmentDto,
  ScheduleDto,
  WorkdayDto,
  holidayInput,
  scheduleAssignmentInput,
  scheduleInput,
  scheduleUpdateInput,
} from '@hrms/shared';
import { DATABASE } from '../common/tokens.js';
import type { Database, Tx } from '../db/database.js';
import {
  department,
  employmentAssignment,
  holiday,
  scheduleAssignment,
  scheduleDay,
  workSchedule,
} from '../db/schema.js';
import { ApiError } from '../common/errors.js';
import { uuidv7 } from '../common/ids.js';
import type { Principal } from '../access/principal.js';
import { AuditService } from '../audit/audit.service.js';
import { EmployeesService, dayBefore } from '../employees/employees.service.js';

type ScheduleRow = typeof workSchedule.$inferSelect;
type DayRow = typeof scheduleDay.$inferSelect;
type SAssignRow = typeof scheduleAssignment.$inferSelect;

const hhmm = (t: string | null) => (t ? t.slice(0, 5) : null);

function toScheduleDto(s: ScheduleRow, days: DayRow[]): ScheduleDto {
  return {
    id: s.id,
    companyId: s.companyId,
    code: s.code,
    nameAr: s.nameAr,
    nameEn: s.nameEn,
    graceInMinutes: s.graceInMinutes,
    graceOutMinutes: s.graceOutMinutes,
    status: s.status,
    version: s.version,
    days: [1, 2, 3, 4, 5, 6, 7].map((w) => {
      const d = days.find((x) => x.scheduleId === s.id && x.isoWeekday === w);
      return {
        isoWeekday: w,
        isWorkday: d?.isWorkday ?? false,
        startTime: hhmm(d?.startTime ?? null),
        endTime: hhmm(d?.endTime ?? null),
        breaks: d?.breaks ?? [],
      };
    }),
  };
}

const toAssignmentDto = (a: SAssignRow): ScheduleAssignmentDto => ({
  id: a.id,
  scheduleId: a.scheduleId,
  targetType: a.targetType,
  companyId: a.companyId,
  departmentId: a.departmentId,
  employeeId: a.employeeId,
  validFrom: a.validFrom,
  validTo: a.validTo,
});

/** ISO weekday (1 = Monday … 7 = Sunday) of a calendar date. */
export function isoWeekday(isoDate: string): number {
  const d = new Date(`${isoDate}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

export function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (d <= end) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

const covers = (from: string, to: string | null, date: string) => from <= date && (to === null || to >= date);

/**
 * Work schedules (SCH-01..03) and official holidays (SCH-04). Schedules can be assigned to a
 * company (default), a department or an employee; the most specific assignment wins.
 */
@Injectable()
export class CalendarService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(EmployeesService) private readonly employees: EmployeesService,
  ) {}

  private canManage(principal: Principal, perm: 'schedules.manage' | 'holidays.manage', companyId: string | null): boolean {
    return companyId ? principal.canCompany(perm, companyId) : principal.hasGroup(perm);
  }

  private validateDays(input: { days: z.infer<typeof scheduleInput>['days'] }) {
    const seen = new Set(input.days.map((d) => d.isoWeekday));
    if (seen.size !== 7) throw ApiError.validation([{ path: 'days', message: 'Exactly one entry per weekday (1–7)' }]);
    for (const d of input.days) {
      if (d.isWorkday && (!d.startTime || !d.endTime || d.startTime === d.endTime)) {
        throw ApiError.validation([{ path: `days.${d.isoWeekday}`, message: 'Working days need different start and end times' }]);
      }
      for (const b of d.breaks) {
        if (b.startTime >= b.endTime) {
          throw ApiError.validation([{ path: `days.${d.isoWeekday}.breaks`, message: 'A break must end after it starts' }]);
        }
      }
    }
  }

  // --- schedules -----------------------------------------------------------------------

  async listSchedules(principal: Principal): Promise<ScheduleDto[]> {
    return this.database.tx(principal.rls(), async (tx) => {
      const rows = await tx.select().from(workSchedule).orderBy(asc(workSchedule.code));
      const days = rows.length
        ? await tx.select().from(scheduleDay).where(inArray(scheduleDay.scheduleId, rows.map((r) => r.id)))
        : [];
      return rows.map((r) => toScheduleDto(r, days));
    });
  }

  async createSchedule(principal: Principal, input: z.infer<typeof scheduleInput>): Promise<ScheduleDto> {
    const companyId = input.companyId ?? null;
    if (!this.canManage(principal, 'schedules.manage', companyId)) throw ApiError.forbidden();
    this.validateDays(input);
    return this.database.tx(principal.rls(), async (tx) => {
      const id = uuidv7();
      const [row] = await tx
        .insert(workSchedule)
        .values({
          id,
          companyId,
          code: input.code,
          nameAr: input.nameAr,
          nameEn: input.nameEn,
          graceInMinutes: input.graceInMinutes,
          graceOutMinutes: input.graceOutMinutes,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();
      await this.writeDays(tx, id, input.days);
      const dto = toScheduleDto(row!, await tx.select().from(scheduleDay).where(eq(scheduleDay.scheduleId, id)));
      await this.audit.record(tx, { action: 'calendar.schedule_created', entityType: 'work_schedule', entityId: id, companyId, after: dto });
      return dto;
    });
  }

  async updateSchedule(principal: Principal, id: string, input: z.infer<typeof scheduleUpdateInput>): Promise<ScheduleDto> {
    this.validateDays(input);
    return this.database.tx(principal.rls(), async (tx) => {
      const [before] = await tx.select().from(workSchedule).where(eq(workSchedule.id, id));
      if (!before) throw ApiError.notFound('Schedule');
      if (!this.canManage(principal, 'schedules.manage', before.companyId)) throw ApiError.forbidden();
      const beforeDays = await tx.select().from(scheduleDay).where(eq(scheduleDay.scheduleId, id));
      const [after] = await tx
        .update(workSchedule)
        .set({
          nameAr: input.nameAr,
          nameEn: input.nameEn,
          graceInMinutes: input.graceInMinutes,
          graceOutMinutes: input.graceOutMinutes,
          status: input.status,
          updatedBy: principal.userId,
        })
        .where(and(eq(workSchedule.id, id), eq(workSchedule.version, input.version)))
        .returning();
      if (!after) throw ApiError.versionConflict();
      await tx.delete(scheduleDay).where(eq(scheduleDay.scheduleId, id));
      await this.writeDays(tx, id, input.days);
      const dto = toScheduleDto(after, await tx.select().from(scheduleDay).where(eq(scheduleDay.scheduleId, id)));
      await this.audit.record(tx, {
        action: 'calendar.schedule_updated',
        entityType: 'work_schedule',
        entityId: id,
        companyId: after.companyId,
        before: toScheduleDto(before, beforeDays),
        after: dto,
      });
      return dto;
    });
  }

  private async writeDays(tx: Tx, scheduleId: string, days: z.infer<typeof scheduleInput>['days']) {
    await tx.insert(scheduleDay).values(
      days.map((d) => ({
        scheduleId,
        isoWeekday: d.isoWeekday,
        isWorkday: d.isWorkday,
        startTime: d.isWorkday ? d.startTime! : null,
        endTime: d.isWorkday ? d.endTime! : null,
        breaks: d.isWorkday ? d.breaks : [],
      })),
    );
  }

  // --- assignments -------------------------------------------------------------------------

  async listAssignments(principal: Principal, companyId: string): Promise<ScheduleAssignmentDto[]> {
    if (!principal.touchesCompany('schedules.view', companyId)) throw ApiError.notFound('Company');
    const rows = await this.database.tx(principal.rls(), (tx) =>
      tx
        .select()
        .from(scheduleAssignment)
        .where(and(eq(scheduleAssignment.companyId, companyId), isNull(scheduleAssignment.endedAt)))
        .orderBy(asc(scheduleAssignment.targetType), asc(scheduleAssignment.validFrom)),
    );
    return rows.map(toAssignmentDto);
  }

  async assign(principal: Principal, input: z.infer<typeof scheduleAssignmentInput>): Promise<ScheduleAssignmentDto> {
    if (!principal.canCompany('schedules.manage', input.companyId)) throw ApiError.forbidden();
    return this.database.tx(principal.rls(), async (tx) => {
      const [sched] = await tx.select().from(workSchedule).where(eq(workSchedule.id, input.scheduleId));
      if (!sched || sched.status !== 'active' || (sched.companyId && sched.companyId !== input.companyId)) {
        throw ApiError.validation([{ path: 'scheduleId', message: 'Schedule not usable in this company' }]);
      }
      const departmentId = input.targetType === 'department' ? (input.departmentId ?? null) : null;
      const employeeId = input.targetType === 'employee' ? (input.employeeId ?? null) : null;
      if (input.targetType === 'department') {
        const [d] = await tx
          .select({ id: department.id })
          .from(department)
          .where(and(eq(department.id, departmentId ?? ''), eq(department.companyId, input.companyId)));
        if (!d) throw ApiError.validation([{ path: 'departmentId', message: 'Unknown department' }]);
      }
      if (input.targetType === 'employee') {
        const [e] = await tx
          .select({ id: employmentAssignment.id })
          .from(employmentAssignment)
          .where(and(eq(employmentAssignment.employeeId, employeeId ?? ''), eq(employmentAssignment.companyId, input.companyId)));
        if (!e) throw ApiError.validation([{ path: 'employeeId', message: 'The employee does not belong to this company' }]);
      }
      const targetCond = and(
        eq(scheduleAssignment.targetType, input.targetType),
        eq(scheduleAssignment.companyId, input.companyId),
        departmentId ? eq(scheduleAssignment.departmentId, departmentId) : isNull(scheduleAssignment.departmentId),
        employeeId ? eq(scheduleAssignment.employeeId, employeeId) : isNull(scheduleAssignment.employeeId),
        isNull(scheduleAssignment.endedAt),
      );
      // Close the running open-ended assignment of the same target (history is kept).
      const [open] = await tx.select().from(scheduleAssignment).where(and(targetCond, isNull(scheduleAssignment.validTo)));
      if (open) {
        if (input.validFrom <= open.validFrom) {
          throw ApiError.validation([{ path: 'validFrom', message: 'Must be after the start of the current schedule' }]);
        }
        await tx.update(scheduleAssignment).set({ validTo: dayBefore(input.validFrom) }).where(eq(scheduleAssignment.id, open.id));
      }
      const [row] = await tx
        .insert(scheduleAssignment)
        .values({
          id: uuidv7(),
          scheduleId: input.scheduleId,
          targetType: input.targetType,
          companyId: input.companyId,
          departmentId,
          employeeId,
          validFrom: input.validFrom,
          validTo: input.validTo ?? null,
          createdBy: principal.userId,
        })
        .returning();
      const dto = toAssignmentDto(row!);
      await this.audit.record(tx, {
        action: 'calendar.schedule_assigned',
        entityType: 'schedule_assignment',
        entityId: dto.id,
        companyId: input.companyId,
        before: open ? toAssignmentDto(open) : null,
        after: dto,
      });
      return dto;
    });
  }

  // --- holidays ---------------------------------------------------------------------------

  async listHolidays(principal: Principal, year: number, companyId?: string): Promise<HolidayDto[]> {
    const rows = await this.database.tx(principal.rls(), (tx) =>
      tx
        .select()
        .from(holiday)
        .where(
          and(
            gte(holiday.date, `${year}-01-01`),
            lte(holiday.date, `${year}-12-31`),
            companyId ? or(isNull(holiday.companyId), eq(holiday.companyId, companyId)) : undefined,
          ),
        )
        .orderBy(asc(holiday.date)),
    );
    return rows.map((h) => ({ id: h.id, companyId: h.companyId, date: h.date, nameAr: h.nameAr, nameEn: h.nameEn }));
  }

  async addHoliday(principal: Principal, input: z.infer<typeof holidayInput>): Promise<HolidayDto> {
    const companyId = input.companyId ?? null;
    if (!this.canManage(principal, 'holidays.manage', companyId)) throw ApiError.forbidden();
    return this.database.tx(principal.rls(), async (tx) => {
      const [row] = await tx
        .insert(holiday)
        .values({ id: uuidv7(), companyId, date: input.date, nameAr: input.nameAr, nameEn: input.nameEn, createdBy: principal.userId })
        .returning();
      await this.audit.record(tx, { action: 'calendar.holiday_added', entityType: 'holiday', entityId: row!.id, companyId, after: input });
      return { id: row!.id, companyId, date: row!.date, nameAr: row!.nameAr, nameEn: row!.nameEn };
    });
  }

  async removeHoliday(principal: Principal, id: string): Promise<void> {
    await this.database.tx(principal.rls(), async (tx) => {
      const [h] = await tx.select().from(holiday).where(eq(holiday.id, id));
      if (!h) throw ApiError.notFound('Holiday');
      if (!this.canManage(principal, 'holidays.manage', h.companyId)) throw ApiError.forbidden();
      await tx.delete(holiday).where(eq(holiday.id, id));
      await this.audit.record(tx, { action: 'calendar.holiday_removed', entityType: 'holiday', entityId: id, companyId: h.companyId, before: h });
    });
  }

  // --- resolution: what applies to an employee on each date -------------------------------

  async workdays(principal: Principal, employeeId: string, from: string, to: string): Promise<WorkdayDto[]> {
    if (to < from) throw ApiError.validation([{ path: 'to', message: 'Must not be before "from"' }]);
    const days = eachDay(from, to);
    if (days.length > 62) throw ApiError.validation([{ path: 'to', message: 'At most 62 days per request' }]);
    const { current, access } = await this.employees.loadVisible(principal, employeeId);
    const cid = current?.companyId;
    // The employee themself, or staff who may view schedules in the employee's company.
    if (!access.self && !(cid && principal.touchesCompany('schedules.view', cid))) throw ApiError.forbidden();
    return this.database.tx(principal.rls(), (tx) => this.resolveWorkdays(tx, employeeId, days));
  }

  /** Pure resolution inside a transaction (also used by attendance and leave). */
  async resolveWorkdays(tx: Tx, employeeId: string, days: string[]): Promise<WorkdayDto[]> {
    if (!days.length) return [];
    const from = days[0]!;
    const to = days[days.length - 1]!;
    const assigns = await tx
      .select()
      .from(employmentAssignment)
      .where(
        and(
          eq(employmentAssignment.employeeId, employeeId),
          lte(employmentAssignment.validFrom, to),
          or(isNull(employmentAssignment.validTo), gte(employmentAssignment.validTo, from)),
        ),
      );
    const companyIds = [...new Set(assigns.map((a) => a.companyId))];
    const deptIds = [...new Set(assigns.map((a) => a.departmentId).filter((x): x is string => !!x))];
    const targets: SQL[] = [eq(scheduleAssignment.employeeId, employeeId)];
    if (deptIds.length) targets.push(and(eq(scheduleAssignment.targetType, 'department'), inArray(scheduleAssignment.departmentId, deptIds))!);
    if (companyIds.length) targets.push(and(eq(scheduleAssignment.targetType, 'company'), inArray(scheduleAssignment.companyId, companyIds))!);
    const sas = await tx
      .select()
      .from(scheduleAssignment)
      .where(and(or(...targets), isNull(scheduleAssignment.endedAt), lte(scheduleAssignment.validFrom, to), or(isNull(scheduleAssignment.validTo), gte(scheduleAssignment.validTo, from))));
    const scheduleIds = [...new Set(sas.map((s) => s.scheduleId))];
    const schedules = scheduleIds.length ? await tx.select().from(workSchedule).where(inArray(workSchedule.id, scheduleIds)) : [];
    const sdays = scheduleIds.length ? await tx.select().from(scheduleDay).where(inArray(scheduleDay.scheduleId, scheduleIds)) : [];
    const hols = await tx
      .select()
      .from(holiday)
      .where(and(gte(holiday.date, from), lte(holiday.date, to), or(isNull(holiday.companyId), companyIds.length ? inArray(holiday.companyId, companyIds) : undefined)));

    return days.map((date): WorkdayDto => {
      const a = assigns.find((x) => covers(x.validFrom, x.validTo, date));
      const pick = (type: 'employee' | 'department' | 'company') =>
        sas.find(
          (s) =>
            s.targetType === type &&
            covers(s.validFrom, s.validTo, date) &&
            (type === 'employee' ? s.employeeId === employeeId : type === 'department' ? s.departmentId === a?.departmentId : s.companyId === a?.companyId),
        );
      const sa = a ? (pick('employee') ?? pick('department') ?? pick('company')) : undefined;
      const sched = schedules.find((s) => s.id === sa?.scheduleId);
      const d = sdays.find((x) => x.scheduleId === sched?.id && x.isoWeekday === isoWeekday(date));
      const hol =
        hols.find((h) => h.date === date && a && h.companyId === a.companyId) ?? hols.find((h) => h.date === date && h.companyId === null);
      return {
        date,
        scheduleId: sched?.id ?? null,
        isWorkday: !!(a && d?.isWorkday && !hol),
        holiday: hol && a ? { id: hol.id, nameAr: hol.nameAr, nameEn: hol.nameEn } : null,
        startTime: hhmm(d?.startTime ?? null),
        endTime: hhmm(d?.endTime ?? null),
        breaks: d?.breaks ?? [],
        graceInMinutes: sched?.graceInMinutes ?? 0,
        graceOutMinutes: sched?.graceOutMinutes ?? 0,
      };
    });
  }
}

