import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import ipaddr from 'ipaddr.js';
import type {
  AttendanceDayDto,
  CorrectionDto,
  NetworkRangeDto,
  PunchDto,
  PunchKind,
  TodayDto,
  correctionInput,
  networkRangeInput,
  punchInput,
} from '@hrms/shared';
import type { z } from 'zod';
import { DATABASE } from '../common/tokens.js';
import type { Database, Tx } from '../db/database.js';
import {
  attendanceCorrection,
  attendanceDay,
  attendanceDevice,
  employee,
  employmentAssignment,
  networkRange,
  punch,
  punchVoid,
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
import { NotificationsService } from '../notifications/notifications.service.js';
import { computeDay, type AttendancePolicy } from './compute.js';
import { addDays, localDate, localTime, zonedToUtc } from './time.js';
import { DevicesService } from './devices.service.js';

type DayRow = typeof attendanceDay.$inferSelect;
type PunchRow = typeof punch.$inferSelect;

export interface ClientMeta {
  ip: string | null;
  userAgent: string | null;
  rpId: string;
  origin: string;
}

/** Network membership of an address (IPv4-mapped IPv6 addresses are normalised). */
export function ipInRanges(ip: string | null, cidrs: string[]): boolean {
  if (!ip) return false;
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    addr = ipaddr.process(ip);
  } catch {
    return false;
  }
  return cidrs.some((c) => {
    try {
      const [net, bits] = ipaddr.parseCIDR(c);
      if (net.kind() !== addr.kind()) return false;
      return addr.kind() === 'ipv4'
        ? (addr as ipaddr.IPv4).match(net as ipaddr.IPv4, bits)
        : (addr as ipaddr.IPv6).match(net as ipaddr.IPv6, bits);
    } catch {
      return false;
    }
  });
}

const NEXT: Record<'out' | 'in' | 'on_break', PunchKind[]> = {
  out: ['in'],
  in: ['out', 'break_start'],
  on_break: ['break_end'],
};

function stateOf(punches: { kind: PunchKind }[]): 'out' | 'in' | 'on_break' {
  let s: 'out' | 'in' | 'on_break' = 'out';
  for (const p of punches) {
    if (p.kind === 'in') s = 'in';
    else if (p.kind === 'out') s = 'out';
    else if (p.kind === 'break_start' && s === 'in') s = 'on_break';
    else if (p.kind === 'break_end' && s === 'on_break') s = 'in';
  }
  return s;
}

/**
 * Attendance (ATT-01..17). Punches are append-only facts with server time; attendance days
 * are recomputed from them. IP restriction is a network control, not proof of presence
 * (ATT-08).
 */
@Injectable()
export class AttendanceService implements OnModuleInit {
  private readonly logger = new Logger('Attendance');

  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(ModulesService) private readonly modules: ModulesService,
    @Inject(CalendarService) private readonly calendar: CalendarService,
    @Inject(EmployeesService) private readonly employees: EmployeesService,
    @Inject(WorkflowService) private readonly workflow: WorkflowService,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
    @Inject(DevicesService) private readonly devices: DevicesService,
  ) {}

  onModuleInit() {
    this.workflow.registerHandler('attendance_correction', {
      onCompleted: async (tx, inst, outcome) => {
        const [c] = await tx.select().from(attendanceCorrection).where(eq(attendanceCorrection.id, inst.subjectId));
        if (!c) return;
        if (outcome === 'approved') {
          const ctx = await this.contextFor(tx, c.companyId);
          await this.applyCorrection(tx, c, inst.requesterUserId, ctx);
        } else {
          await tx
            .update(attendanceCorrection)
            .set({ status: outcome === 'rejected' ? 'rejected' : 'cancelled', decidedAt: new Date() })
            .where(eq(attendanceCorrection.id, c.id));
        }
      },
      link: (inst) => `/attendance?correction=${inst.subjectId}`,
    });
  }

  // --- context ------------------------------------------------------------------------------

  /** Settings are read outside transactions (single-connection safety); see SettingsService cache. */
  async prefetch(companyId: string): Promise<{ tz: string; policy: AttendancePolicy }> {
    const [tz, policy] = await Promise.all([this.settings.get('general.timezone'), this.settings.get('attendance.policy', companyId)]);
    return { tz, policy };
  }

  /** Settings read inside an existing transaction (no nested transaction). */
  private async contextFor(tx: Tx, companyId: string): Promise<{ tz: string; policy: AttendancePolicy }> {
    return {
      tz: await this.settings.getWith(tx, 'general.timezone'),
      policy: await this.settings.getWith(tx, 'attendance.policy', companyId),
    };
  }

  private async currentCompany(principal: Principal): Promise<{ employeeId: string; companyId: string; workLocationId: string | null }> {
    if (!principal.employeeId) throw ApiError.forbidden('Your account is not linked to an employee record');
    const { current } = await this.employees.loadVisible(principal, principal.employeeId);
    if (!current) throw ApiError.conflict('You have no current employment assignment');
    return { employeeId: principal.employeeId, companyId: current.companyId, workLocationId: current.workLocationId };
  }

  private async networkFor(companyId: string, workLocationId: string | null, ip: string | null) {
    const ranges = await this.database.system((tx) =>
      tx
        .select({ cidr: networkRange.cidr, loc: networkRange.workLocationId })
        .from(networkRange)
        .where(and(eq(networkRange.companyId, companyId), eq(networkRange.status, 'active'))),
    );
    // Company-wide ranges apply to everybody; location ranges to that location's staff.
    const applicable = ranges.filter((r) => r.loc === null || r.loc === workLocationId).map((r) => r.cidr);
    return { configured: applicable.length > 0, allowed: ipInRanges(ip, applicable), ip };
  }

  // --- today & punching ------------------------------------------------------------------------

  async today(principal: Principal, meta: ClientMeta): Promise<TodayDto> {
    const me = await this.currentCompany(principal);
    const { tz, policy } = await this.prefetch(me.companyId);
    const access = await this.modules.access('attendance', me.companyId);
    const open = await this.openContext(principal, me.employeeId, tz);
    const network = await this.networkFor(me.companyId, me.workLocationId, meta.ip);
    const devs = await this.devices.myDevices(principal);
    const days = await this.days(principal, me.employeeId, open.workDate, open.workDate);
    return {
      employeeId: me.employeeId,
      workDate: open.workDate,
      state: open.state,
      allowedKinds: NEXT[open.state],
      network: { ip: meta.ip, allowed: network.allowed || !policy.requireNetwork, configured: network.configured },
      verification: policy.verification,
      hasWebauthnDevice: devs.some((d) => d.kind === 'webauthn' && d.status === 'approved'),
      hasPinDevice: devs.some((d) => d.kind === 'pin' && d.status === 'approved'),
      day: days[0] ?? null,
      moduleAccess: access,
    };
  }

  /** Work date for the next punch: an open session from the previous day keeps its date. */
  private async openContext(principal: Principal, employeeId: string, tz: string) {
    const today = localDate(new Date(), tz);
    const recent = await this.database.tx(principal.rls(), (tx) =>
      this.activePunches(tx, employeeId, addDays(today, -1), today),
    );
    const yesterday = recent.filter((p) => p.workDate === addDays(today, -1));
    const ySate = stateOf(yesterday);
    const lastY = yesterday.at(-1);
    if (ySate !== 'out' && lastY && Date.now() - lastY.at.getTime() < 16 * 3_600_000) {
      return { workDate: addDays(today, -1), state: ySate, punches: yesterday };
    }
    const t = recent.filter((p) => p.workDate === today);
    return { workDate: today, state: stateOf(t), punches: t };
  }

  private async activePunches(tx: Tx, employeeId: string, from: string, to: string): Promise<PunchRow[]> {
    const rows = await tx
      .select({ p: punch, v: punchVoid.punchId })
      .from(punch)
      .leftJoin(punchVoid, eq(punchVoid.punchId, punch.id))
      .where(and(eq(punch.employeeId, employeeId), gte(punch.workDate, from), lte(punch.workDate, to)))
      .orderBy(asc(punch.at));
    return rows.filter((r) => !r.v).map((r) => r.p);
  }

  async punch(principal: Principal, input: z.infer<typeof punchInput>, meta: ClientMeta): Promise<TodayDto> {
    if (!principal.canSelf('attendance.punch', principal.employeeId ?? '')) throw ApiError.forbidden();
    const me = await this.currentCompany(principal);
    if ((await this.modules.access('attendance', me.companyId)) !== 'enabled') {
      throw new ApiError(403, 'MODULE_DISABLED', 'Attendance is disabled for your company');
    }
    const { tz, policy } = await this.prefetch(me.companyId);

    // Idempotency: a repeated request (double tap, retry) returns the current state.
    const [dup] = await this.database.tx(principal.rls(), (tx) =>
      tx.select({ id: punch.id }).from(punch).where(eq(punch.idempotencyKey, `${principal.userId}:${input.idempotencyKey}`)),
    );
    if (dup) return this.today(principal, meta);

    const network = await this.networkFor(me.companyId, me.workLocationId, meta.ip);
    if (policy.requireNetwork && !network.allowed) {
      await this.audit.recordStandalone({
        action: 'attendance.punch_denied',
        outcome: 'denied',
        companyId: me.companyId,
        details: { reason: network.configured ? 'outside_network' : 'no_network_configured', kind: input.kind },
      });
      throw new ApiError(403, 'FORBIDDEN', network.configured ? 'You are not on an authorised company network' : 'No authorised network is configured for your company', {
        meta: { reason: network.configured ? 'outside_network' : 'no_network_configured', ip: meta.ip },
      });
    }

    // Optional extra verification (ATT-03, ATT-04).
    let method: PunchRow['method'] = 'session';
    let deviceId: string | null = null;
    if (policy.verification !== 'none') {
      const v = await this.devices.verifyForPunch(principal, input, meta, policy);
      method = v.method;
      deviceId = v.deviceId;
    }

    const open = await this.openContext(principal, me.employeeId, tz);
    if (!NEXT[open.state].includes(input.kind)) {
      throw ApiError.conflict(`You cannot record "${input.kind}" now`);
    }

    await this.database.tx(principal.rls(), async (tx) => {
      const id = uuidv7();
      await tx.insert(punch).values({
        id,
        employeeId: me.employeeId,
        companyId: me.companyId,
        workDate: open.workDate,
        kind: input.kind,
        at: new Date(),
        source: 'pwa',
        method,
        ip: meta.ip,
        deviceId,
        userAgent: meta.userAgent?.slice(0, 300) ?? null,
        idempotencyKey: `${principal.userId}:${input.idempotencyKey}`,
        createdBy: principal.userId,
      });
      await this.recompute(tx, me.employeeId, me.companyId, open.workDate, { tz, policy });
      await this.audit.record(tx, {
        action: 'attendance.punch',
        entityType: 'punch',
        entityId: id,
        companyId: me.companyId,
        details: { kind: input.kind, method, workDate: open.workDate },
      });
    });
    return this.today(principal, meta);
  }

  // --- calculation ----------------------------------------------------------------------------

  /** Recompute and store one attendance day (runs inside the caller's transaction). */
  async recompute(
    tx: Tx,
    employeeId: string,
    companyId: string,
    workDate: string,
    ctx: { tz: string; policy: AttendancePolicy },
  ): Promise<DayRow> {
    const [workday] = await this.calendar.resolveWorkdays(tx, employeeId, [workDate]);
    const [assignment] = await tx
      .select({ id: employmentAssignment.id, companyId: employmentAssignment.companyId })
      .from(employmentAssignment)
      .where(
        and(
          eq(employmentAssignment.employeeId, employeeId),
          lte(employmentAssignment.validFrom, workDate),
          or(isNull(employmentAssignment.validTo), gte(employmentAssignment.validTo, workDate)),
        ),
      );
    const punches = await this.activePunches(tx, employeeId, workDate, workDate);
    const [existing] = await tx
      .select()
      .from(attendanceDay)
      .where(and(eq(attendanceDay.employeeId, employeeId), eq(attendanceDay.workDate, workDate)));
    const c = computeDay({
      workDate,
      tz: ctx.tz,
      now: new Date(),
      employed: !!assignment,
      workday: workday!,
      punches: punches.map((p) => ({ kind: p.kind, at: p.at })),
      policy: ctx.policy,
      review: existing?.reviewStatus ? { status: existing.reviewStatus, note: existing.reviewNote } : null,
    });
    const values = {
      companyId: assignment?.companyId ?? companyId,
      dayClass: c.dayClass,
      status: c.status,
      scheduledStart: c.scheduledStart,
      scheduledEnd: c.scheduledEnd,
      firstIn: c.firstIn,
      lastOut: c.lastOut,
      workedMinutes: c.workedMinutes,
      breakMinutes: c.breakMinutes,
      lateMinutes: c.lateMinutes,
      earlyMinutes: c.earlyMinutes,
      overtimeMinutes: c.overtimeMinutes,
      holidayWorkMinutes: c.holidayWorkMinutes,
      closure: c.closure,
      flags: c.flags,
      computedAt: new Date(),
    };
    if (existing) {
      const [row] = await tx
        .update(attendanceDay)
        .set({ ...values, calcVersion: existing.calcVersion + 1 })
        .where(eq(attendanceDay.id, existing.id))
        .returning();
      return row!;
    }
    const [row] = await tx.insert(attendanceDay).values({ id: uuidv7(), employeeId, workDate, ...values }).returning();
    return row!;
  }

  // --- reading ---------------------------------------------------------------------------------

  private canView(principal: Principal, employeeId: string, companyId: string | null, departmentId: string | null): boolean {
    if (principal.canSelf('attendance.record.view', employeeId)) return true;
    if (!companyId) return false;
    const s = principal.scope('attendance.record.view');
    return s.all || s.companyIds.includes(companyId) || (!!departmentId && s.departmentIds.includes(departmentId));
  }

  async days(principal: Principal, employeeId: string, from: string, to: string): Promise<AttendanceDayDto[]> {
    const range = eachDay(from, to);
    if (range.length > 62) throw ApiError.validation([{ path: 'to', message: 'At most 62 days per request' }]);
    const { current } = await this.employees.loadVisible(principal, employeeId);
    if (!this.canView(principal, employeeId, current?.companyId ?? null, current?.departmentId ?? null)) throw ApiError.forbidden();
    const companyId = current?.companyId ?? '';
    const { tz, policy } = await this.prefetch(companyId);
    return this.database.tx(principal.rls(), async (tx) => {
      const stored = await tx
        .select()
        .from(attendanceDay)
        .where(and(eq(attendanceDay.employeeId, employeeId), gte(attendanceDay.workDate, from), lte(attendanceDay.workDate, to)));
      const allPunches = await tx
        .select({ p: punch, v: punchVoid.punchId, label: attendanceDevice.label })
        .from(punch)
        .leftJoin(punchVoid, eq(punchVoid.punchId, punch.id))
        .leftJoin(attendanceDevice, eq(attendanceDevice.id, punch.deviceId))
        .where(and(eq(punch.employeeId, employeeId), gte(punch.workDate, from), lte(punch.workDate, to)))
        .orderBy(asc(punch.at));
      const workdays = await this.calendar.resolveWorkdays(tx, employeeId, range);
      const assigns = await tx
        .select()
        .from(employmentAssignment)
        .where(eq(employmentAssignment.employeeId, employeeId));
      const today = localDate(new Date(), tz);
      return range.map((date, n): AttendanceDayDto => {
        const row = stored.find((r) => r.workDate === date);
        const ps = allPunches.filter((x) => x.p.workDate === date);
        const punches: PunchDto[] = ps.map(({ p, v, label }) => ({
          id: p.id,
          kind: p.kind,
          at: p.at.toISOString(),
          localTime: localTime(p.at, tz),
          source: p.source,
          method: p.method,
          ip: p.ip,
          deviceLabel: label,
          voided: !!v,
        }));
        // Rows are refreshed by punches and the daily job; past/future days without a row
        // are computed on the fly for display.
        const c =
          row && date < today
            ? row
            : {
                ...computeDay({
                  workDate: date,
                  tz,
                  now: new Date(),
                  employed: assigns.some((a) => a.validFrom <= date && (a.validTo === null || a.validTo >= date)),
                  workday: workdays[n]!,
                  punches: ps.filter((x) => !x.v).map((x) => ({ kind: x.p.kind, at: x.p.at })),
                  policy,
                  review: row?.reviewStatus ? { status: row.reviewStatus, note: row.reviewNote } : null,
                }),
                reviewNote: row?.reviewNote ?? null,
              };
        return {
          employeeId,
          workDate: date,
          dayClass: c.dayClass,
          status: c.status,
          scheduledStart: c.scheduledStart ? String(c.scheduledStart).slice(0, 5) : null,
          scheduledEnd: c.scheduledEnd ? String(c.scheduledEnd).slice(0, 5) : null,
          firstIn: c.firstIn ? localTime(c.firstIn, tz) : null,
          lastOut: c.lastOut ? localTime(c.lastOut, tz) : null,
          workedMinutes: c.workedMinutes,
          breakMinutes: c.breakMinutes,
          lateMinutes: c.lateMinutes,
          earlyMinutes: c.earlyMinutes,
          overtimeMinutes: c.overtimeMinutes,
          holidayWorkMinutes: c.holidayWorkMinutes,
          closure: c.closure,
          flags: c.flags,
          reviewNote: c.reviewNote ?? null,
          punches,
        };
      });
    });
  }

  /** Exceptions queue for HR/timekeeping (ATT-14). */
  async review(principal: Principal, companyId: string, from: string, to: string) {
    if (!principal.canCompany('attendance.review', companyId)) throw ApiError.notFound('Company');
    return this.database.tx(principal.rls(), async (tx) => {
      const rows = await tx
        .select({ d: attendanceDay, ar: employee.fullNameAr, en: employee.fullNameEn, no: employee.employeeNo })
        .from(attendanceDay)
        .innerJoin(employee, eq(employee.id, attendanceDay.employeeId))
        .where(
          and(
            eq(attendanceDay.companyId, companyId),
            gte(attendanceDay.workDate, from),
            lte(attendanceDay.workDate, to),
            or(
              inArray(attendanceDay.status, ['absent_pending', 'incomplete']),
              sql`cardinality(${attendanceDay.flags}) > 0`,
            ),
          ),
        )
        .orderBy(desc(attendanceDay.workDate), asc(employee.employeeNo))
        .limit(500);
      return rows.map(({ d, ar, en, no }) => ({
        employeeId: d.employeeId,
        employeeNo: no,
        name: { ar, en },
        workDate: d.workDate,
        status: d.status,
        dayClass: d.dayClass,
        lateMinutes: d.lateMinutes,
        earlyMinutes: d.earlyMinutes,
        overtimeMinutes: d.overtimeMinutes,
        workedMinutes: d.workedMinutes,
        closure: d.closure,
        flags: d.flags,
        reviewNote: d.reviewNote,
      }));
    });
  }

  async reviewDay(
    principal: Principal,
    employeeId: string,
    workDate: string,
    action: 'confirm_absence' | 'excuse' | 'reopen',
    note: string,
  ): Promise<void> {
    const { current } = await this.employees.loadVisible(principal, employeeId);
    if (!current || !principal.canCompany('attendance.review', current.companyId)) throw ApiError.forbidden();
    const ctx = await this.prefetch(current.companyId);
    await this.database.tx(principal.rls(), async (tx) => {
      const day = await this.recompute(tx, employeeId, current.companyId, workDate, ctx);
      if (action !== 'reopen' && !['absent_pending', 'absent_confirmed', 'excused'].includes(day.status)) {
        throw ApiError.conflict('Only days without attendance can be confirmed as absence or excused');
      }
      await tx
        .update(attendanceDay)
        .set({
          reviewStatus: action === 'confirm_absence' ? 'absent_confirmed' : action === 'excuse' ? 'excused' : null,
          reviewNote: note,
          reviewedBy: principal.userId,
          reviewedAt: new Date(),
        })
        .where(eq(attendanceDay.id, day.id));
      const after = await this.recompute(tx, employeeId, current.companyId, workDate, ctx);
      await this.audit.record(tx, {
        action: `attendance.${action}`,
        entityType: 'attendance_day',
        entityId: after.id,
        companyId: current.companyId,
        before: { status: day.status },
        after: { status: after.status, note },
      });
    });
  }

  // --- corrections (ATT-15) --------------------------------------------------------------------------

  async requestCorrection(principal: Principal, input: z.infer<typeof correctionInput>): Promise<CorrectionDto> {
    const employeeId = input.employeeId ?? principal.employeeId;
    if (!employeeId) throw ApiError.forbidden('Your account is not linked to an employee record');
    const { current } = await this.employees.loadVisible(principal, employeeId);
    if (!current) throw ApiError.conflict('No current employment assignment');
    const self = employeeId === principal.employeeId;
    const direct = principal.canCompany('attendance.record.correct', current.companyId) && !self;
    if (!self && !direct) throw ApiError.forbidden();
    if ((await this.modules.access('attendance', current.companyId)) !== 'enabled') {
      throw new ApiError(403, 'MODULE_DISABLED', 'Attendance is disabled for this company');
    }
    const ctx = await this.prefetch(current.companyId);
    const today = localDate(new Date(), ctx.tz);
    if (input.workDate > today) throw ApiError.validation([{ path: 'workDate', message: 'Cannot correct future days' }]);
    if (self && input.workDate < addDays(today, -ctx.policy.correctionWindowDays)) {
      throw ApiError.validation([{ path: 'workDate', message: `Corrections are possible up to ${ctx.policy.correctionWindowDays} days back` }]);
    }
    if (!input.add.length && !input.voidPunchIds.length) {
      throw ApiError.validation([{ path: 'add', message: 'Nothing to correct' }]);
    }
    const id = uuidv7();
    await this.database.tx(principal.rls(), async (tx) => {
      if (input.voidPunchIds.length) {
        const owned = await tx
          .select({ id: punch.id })
          .from(punch)
          .where(and(inArray(punch.id, input.voidPunchIds), eq(punch.employeeId, employeeId), eq(punch.workDate, input.workDate)));
        if (owned.length !== input.voidPunchIds.length) throw ApiError.validation([{ path: 'voidPunchIds', message: 'Unknown punches for that day' }]);
      }
      const [row] = await tx
        .insert(attendanceCorrection)
        .values({
          id,
          employeeId,
          companyId: current.companyId,
          workDate: input.workDate,
          changes: { add: input.add, voidPunchIds: input.voidPunchIds },
          reason: input.reason,
          direct,
          requestedBy: principal.userId,
        })
        .returning();
      await this.audit.record(tx, {
        action: direct ? 'attendance.corrected' : 'attendance.correction_requested',
        entityType: 'attendance_correction',
        entityId: id,
        companyId: current.companyId,
        after: { employeeId, workDate: input.workDate, add: input.add, voidPunchIds: input.voidPunchIds, reason: input.reason },
      });
      if (direct) {
        await this.applyCorrection(tx, row!, principal.userId, ctx);
      } else {
        const inst = await this.workflow.start(tx, principal, {
          definitionKey: 'attendance.correction',
          companyId: current.companyId,
          subjectType: 'attendance_correction',
          subjectId: id,
          subjectEmployeeId: employeeId,
          summary: { workDate: input.workDate, changes: input.add.map((a) => `${a.kind} ${a.time}`).join(', ') },
        });
        await tx.update(attendanceCorrection).set({ workflowInstanceId: inst.id }).where(eq(attendanceCorrection.id, id));
      }
    });
    return (await this.listCorrections(principal, employeeId)).find((c) => c.id === id)!;
  }

  private async applyCorrection(
    tx: Tx,
    c: typeof attendanceCorrection.$inferSelect,
    byUserId: string,
    ctx: { tz: string; policy: AttendancePolicy },
  ): Promise<void> {
    for (const pid of c.changes.voidPunchIds) {
      await tx.insert(punchVoid).values({ punchId: pid, correctionId: c.id, voidedBy: byUserId }).onConflictDoNothing();
    }
    for (const a of c.changes.add) {
      // A time earlier than an overnight schedule's start may belong to the next calendar day.
      let at = zonedToUtc(c.workDate, a.time, ctx.tz);
      const [wd] = await this.calendar.resolveWorkdays(tx, c.employeeId, [c.workDate]);
      if (wd?.startTime && wd.endTime && wd.endTime <= wd.startTime && a.time < wd.startTime && a.kind !== 'in') {
        at = zonedToUtc(addDays(c.workDate, 1), a.time, ctx.tz);
      }
      await tx.insert(punch).values({
        id: uuidv7(),
        employeeId: c.employeeId,
        companyId: c.companyId,
        workDate: c.workDate,
        kind: a.kind,
        at,
        source: 'correction',
        method: 'correction',
        correctionId: c.id,
        createdBy: byUserId,
      });
    }
    await tx.update(attendanceCorrection).set({ status: 'approved', decidedAt: new Date() }).where(eq(attendanceCorrection.id, c.id));
    await this.recompute(tx, c.employeeId, c.companyId, c.workDate, ctx);
  }

  async listCorrections(principal: Principal, employeeId: string): Promise<CorrectionDto[]> {
    const { current } = await this.employees.loadVisible(principal, employeeId);
    if (!this.canView(principal, employeeId, current?.companyId ?? null, current?.departmentId ?? null)) throw ApiError.forbidden();
    const rows = await this.database.tx(principal.rls(), (tx) =>
      tx.select().from(attendanceCorrection).where(eq(attendanceCorrection.employeeId, employeeId)).orderBy(desc(attendanceCorrection.createdAt)).limit(100),
    );
    return rows.map((r) => ({
      id: r.id,
      employeeId: r.employeeId,
      workDate: r.workDate,
      add: r.changes.add,
      voidPunchIds: r.changes.voidPunchIds,
      reason: r.reason,
      status: r.status,
      direct: r.direct,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  // --- networks (ATT-01) ----------------------------------------------------------------------------

  async listNetworks(principal: Principal, companyId: string): Promise<NetworkRangeDto[]> {
    if (!principal.canCompany('attendance.network.manage', companyId) && !principal.canCompany('attendance.review', companyId)) {
      throw ApiError.notFound('Company');
    }
    const rows = await this.database.tx(principal.rls(), (tx) =>
      tx.select().from(networkRange).where(eq(networkRange.companyId, companyId)).orderBy(asc(networkRange.label)),
    );
    return rows.map((r) => ({ id: r.id, companyId: r.companyId, workLocationId: r.workLocationId, cidr: r.cidr, label: r.label, status: r.status }));
  }

  async addNetwork(principal: Principal, input: z.infer<typeof networkRangeInput>): Promise<NetworkRangeDto> {
    if (!principal.canCompany('attendance.network.manage', input.companyId)) throw ApiError.forbidden();
    let cidr = input.cidr.trim();
    if (!cidr.includes('/')) cidr = cidr.includes(':') ? `${cidr}/128` : `${cidr}/32`;
    try {
      const [addr, bits] = ipaddr.parseCIDR(cidr);
      // Refuse "everything" ranges that would disable the control.
      if (bits < (addr.kind() === 'ipv4' ? 8 : 32)) throw new Error('too wide');
      cidr = `${addr.toString()}/${bits}`;
    } catch {
      throw ApiError.validation([{ path: 'cidr', message: 'Enter an IP address or network such as 203.0.113.0/24' }]);
    }
    return this.database.tx(principal.rls(), async (tx) => {
      const [row] = await tx
        .insert(networkRange)
        .values({ id: uuidv7(), companyId: input.companyId, workLocationId: input.workLocationId ?? null, cidr, label: input.label, createdBy: principal.userId })
        .returning();
      await this.audit.record(tx, { action: 'attendance.network_added', entityType: 'network_range', entityId: row!.id, companyId: input.companyId, after: { cidr, label: input.label } });
      return { id: row!.id, companyId: row!.companyId, workLocationId: row!.workLocationId, cidr: row!.cidr, label: row!.label, status: row!.status };
    });
  }

  async deactivateNetwork(principal: Principal, id: string): Promise<void> {
    await this.database.tx(principal.rls(), async (tx) => {
      const [r] = await tx.select().from(networkRange).where(eq(networkRange.id, id));
      if (!r || !principal.canCompany('attendance.network.manage', r.companyId)) throw ApiError.notFound('Network');
      await tx.update(networkRange).set({ status: 'inactive' }).where(eq(networkRange.id, id));
      await this.audit.record(tx, { action: 'attendance.network_removed', entityType: 'network_range', entityId: id, companyId: r.companyId, before: { cidr: r.cidr } });
    });
  }

  // --- daily job (ATT-11, ATT-14) ---------------------------------------------------------------------

  /** Recompute recent days for every employee: detects absences, closes forgotten check-outs. */
  async dailyRecompute(days = 2): Promise<number> {
    const tz = await this.settings.get('general.timezone');
    const today = localDate(new Date(), tz);
    const rows = await this.database.system((tx) =>
      tx
        .selectDistinct({ employeeId: employmentAssignment.employeeId, companyId: employmentAssignment.companyId })
        .from(employmentAssignment)
        .where(and(lte(employmentAssignment.validFrom, today), or(isNull(employmentAssignment.validTo), gte(employmentAssignment.validTo, addDays(today, -days))))),
    );
    const policies = new Map<string, AttendancePolicy>();
    for (const r of rows) if (!policies.has(r.companyId)) policies.set(r.companyId, (await this.prefetch(r.companyId)).policy);
    let n = 0;
    for (const r of rows) {
      if ((await this.modules.access('attendance', r.companyId)) === 'hidden') continue;
      for (let i = days; i >= 1; i--) {
        const date = addDays(today, -i);
        await this.database.system(async (tx) => {
          const before = await tx.select({ s: attendanceDay.status }).from(attendanceDay).where(and(eq(attendanceDay.employeeId, r.employeeId), eq(attendanceDay.workDate, date)));
          const day = await this.recompute(tx, r.employeeId, r.companyId, date, { tz, policy: policies.get(r.companyId)! });
          if (day.status === 'absent_pending' && before[0]?.s !== 'absent_pending') {
            await this.notifyException(tx, r.employeeId, r.companyId, date, 'absence');
          }
          if (day.flags.includes('missing_checkout') && !before.length) {
            await this.notifyException(tx, r.employeeId, r.companyId, date, 'missing_checkout');
          }
        });
        n++;
      }
    }
    if (n) this.logger.log(`Recomputed ${n} attendance day(s)`);
    return n;
  }

  /** Tell the employee (and nobody else) about a possible absence / missing check-out (NOT-04). */
  private async notifyException(tx: Tx, employeeId: string, companyId: string, date: string, type: 'absence' | 'missing_checkout') {
    const users = await tx.execute<{ id: string }>(sql`select id from user_account where employee_id = ${employeeId} and status = 'active'`);
    const ids = (users as unknown as { rows: { id: string }[] }).rows.map((u) => u.id);
    await this.notifications.notify(tx, {
      userIds: ids,
      companyId,
      eventType: `attendance.${type}`,
      title:
        type === 'absence'
          ? { ar: `لا يوجد تسجيل حضور يوم ${date}`, en: `No attendance recorded on ${date}` }
          : { ar: `لم يُسجَّل الخروج يوم ${date}`, en: `No check-out recorded on ${date}` },
      body: { ar: 'يمكنك طلب تصحيح من صفحة الحضور.', en: 'You can request a correction on the attendance page.' },
      link: `/attendance?date=${date}`,
    });
  }
}

