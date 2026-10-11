import type { DayClass, DayStatus, PunchKind, SettingValue, WorkdayDto } from '@hrms/shared';
import { addDays, localDate, zonedToUtc } from './time.js';

export type AttendancePolicy = SettingValue<'attendance.policy'>;

export interface ComputeInput {
  workDate: string;
  tz: string;
  now: Date;
  /** False when the person had no employment assignment on the date. */
  employed: boolean;
  workday: WorkdayDto;
  /** Non-voided punches of this work date, in time order. */
  punches: { kind: PunchKind; at: Date }[];
  policy: AttendancePolicy;
  review: { status: 'absent_confirmed' | 'excused'; note: string | null } | null;
  /** Approved full-day leave (Phase 5). */
  onLeave?: boolean;
}

export interface ComputedDay {
  dayClass: DayClass;
  status: DayStatus;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  firstIn: Date | null;
  lastOut: Date | null;
  workedMinutes: number;
  breakMinutes: number;
  lateMinutes: number;
  earlyMinutes: number;
  overtimeMinutes: number;
  holidayWorkMinutes: number;
  closure: 'normal' | 'administrative' | 'open' | 'none';
  flags: string[];
}

type Interval = [number, number];

const mins = (ms: number) => Math.floor(ms / 60_000);

function overlap(a: Interval[], b: Interval[]): number {
  let total = 0;
  for (const [s1, e1] of a) for (const [s2, e2] of b) total += Math.max(0, Math.min(e1, e2) - Math.max(s1, s2));
  return total;
}

/** a minus b (both sorted, non-overlapping within themselves). */
function subtract(a: Interval[], b: Interval[]): Interval[] {
  let out = a;
  for (const [bs, be] of b) {
    const next: Interval[] = [];
    for (const [s, e] of out) {
      if (be <= s || bs >= e) next.push([s, e]);
      else {
        if (bs > s) next.push([s, bs]);
        if (be < e) next.push([be, e]);
      }
    }
    out = next;
  }
  return out;
}

const sum = (xs: Interval[]) => xs.reduce((t, [s, e]) => t + Math.max(0, e - s), 0);

/**
 * Pure attendance calculation for one employee and one work date (ATT-09..17, C-02).
 * Golden cases are in test/attendance-compute.test.ts.
 */
export function computeDay(input: ComputeInput): ComputedDay {
  const { workday: wd, policy, tz } = input;
  const flags: string[] = [];
  const dayClass: DayClass = !input.employed
    ? 'not_employed'
    : wd.holiday
      ? 'holiday'
      : wd.isWorkday
        ? 'workday'
        : wd.scheduleId
          ? 'rest'
          : 'unscheduled';

  // Scheduled window (for holidays the schedule is still known but not required).
  const hasSchedule = !!(wd.startTime && wd.endTime);
  const startAt = hasSchedule ? zonedToUtc(input.workDate, wd.startTime!, tz).getTime() : null;
  const endAt = hasSchedule
    ? zonedToUtc(wd.endTime! <= wd.startTime! ? addDays(input.workDate, 1) : input.workDate, wd.endTime!, tz).getTime()
    : null;

  // Pair punches into work sessions and extra breaks.
  const sessions: [number, number | null][] = [];
  const breaks: [number, number | null][] = [];
  for (const p of input.punches) {
    const t = p.at.getTime();
    const open = sessions.at(-1);
    if (p.kind === 'in') {
      if (open && open[1] === null) flags.push('duplicate_in');
      else sessions.push([t, null]);
    } else if (p.kind === 'out') {
      if (open && open[1] === null) {
        open[1] = t;
        const ob = breaks.at(-1);
        if (ob && ob[1] === null) ob[1] = t;
      } else flags.push('out_without_in');
    } else if (p.kind === 'break_start') {
      if (open && open[1] === null) breaks.push([t, null]);
    } else if (p.kind === 'break_end') {
      const ob = breaks.at(-1);
      if (ob && ob[1] === null) ob[1] = t;
    }
  }

  const nowMs = input.now.getTime();
  const dayOver = localDate(input.now, tz) > input.workDate || (endAt !== null && nowMs > endAt + 4 * 3_600_000);
  let closure: ComputedDay['closure'] = sessions.length ? 'normal' : 'none';
  const last = sessions.at(-1);
  if (last && last[1] === null) {
    if (dayOver && policy.autoCheckout && endAt !== null && dayClass === 'workday') {
      // Administrative closure at the scheduled end: not proof of departure, never overtime.
      last[1] = Math.max(last[0], endAt);
      closure = 'administrative';
      flags.push('administrative_closure');
    } else if (dayOver) {
      closure = 'open';
      flags.push('missing_checkout');
    } else {
      closure = 'open'; // still at work
    }
  }

  const effectiveEnd = (e: number | null) => (e === null ? Math.min(nowMs, endAt ?? nowMs) : e);
  const sessionIv: Interval[] = sessions.map(([s, e]) => [s, Math.max(s, effectiveEnd(e))]);
  const breakIv: Interval[] = breaks.map(([s, e]) => [s, Math.max(s, effectiveEnd(e))]);
  let worked = subtract(sessionIv, breakIv);

  // Scheduled unpaid breaks are deducted automatically when the person was working (ATT-13).
  let scheduledBreak = 0;
  if (hasSchedule) {
    const sched: Interval[] = wd.breaks
      .filter((b) => !b.paid)
      .map((b) => [zonedToUtc(input.workDate, b.startTime, tz).getTime(), zonedToUtc(input.workDate, b.endTime, tz).getTime()]);
    scheduledBreak = overlap(worked, sched);
    worked = subtract(worked, sched);
  }
  const workedMinutes = mins(sum(worked));
  const breakMinutes = mins(sum(breakIv) + scheduledBreak);
  const firstIn = sessions.length ? new Date(sessions[0]![0]) : null;
  const lastOutMs = sessions.length && sessions.at(-1)![1] !== null ? sessions.at(-1)![1]! : null;

  let lateMinutes = 0;
  let earlyMinutes = 0;
  let overtimeMinutes = 0;
  let holidayWorkMinutes = 0;

  if (dayClass === 'workday' && startAt !== null && endAt !== null && firstIn) {
    const lateMs = firstIn.getTime() - startAt;
    if (lateMs > wd.graceInMinutes * 60_000) lateMinutes = mins(lateMs);
    if (closure === 'normal' && lastOutMs !== null) {
      const earlyMs = endAt - lastOutMs;
      if (earlyMs > wd.graceOutMinutes * 60_000) earlyMinutes = mins(earlyMs);
    }
    if (closure === 'normal') {
      // Overtime after the scheduled end, without prior approval (ATT-12).
      const after = mins(overlap(worked, [[endAt, Number.MAX_SAFE_INTEGER]]));
      if (after > 0 && after >= policy.overtimeMinMinutes) overtimeMinutes += after;
      if (policy.earlyArrival === 'overtime') {
        const before = mins(overlap(worked, [[0, startAt]]));
        if (before > 0 && before >= policy.overtimeMinMinutes) overtimeMinutes += before;
      }
    }
  } else if (dayClass === 'holiday' && workedMinutes > 0) {
    // Holiday work is classified separately, never automatic overtime (ATT-17).
    holidayWorkMinutes = workedMinutes;
    flags.push('holiday_work');
  } else if ((dayClass === 'rest' || dayClass === 'unscheduled') && workedMinutes > 0) {
    flags.push(dayClass === 'rest' ? 'rest_day_work' : 'unscheduled_work');
    if (policy.restDayWork === 'overtime' && closure === 'normal') overtimeMinutes = workedMinutes;
  }
  if (lateMinutes) flags.push('late');
  if (earlyMinutes) flags.push('early_departure');
  if (overtimeMinutes) flags.push('overtime');

  let status: DayStatus;
  if (dayClass === 'not_employed') status = 'not_required';
  else if (sessions.length) status = closure === 'open' && dayOver ? 'incomplete' : 'present';
  else if (input.review) status = input.review.status;
  else if (dayClass === 'workday') {
    if (input.onLeave) status = 'excused';
    else status = dayOver || (startAt !== null && nowMs > startAt + 4 * 3_600_000 && localDate(input.now, tz) >= input.workDate) ? 'absent_pending' : 'upcoming';
  } else status = 'not_required';
  if (status === 'absent_pending') flags.push('possible_absence');

  return {
    dayClass,
    status,
    scheduledStart: wd.startTime,
    scheduledEnd: wd.endTime,
    firstIn,
    lastOut: lastOutMs !== null ? new Date(lastOutMs) : null,
    workedMinutes,
    breakMinutes,
    lateMinutes,
    earlyMinutes,
    overtimeMinutes,
    holidayWorkMinutes,
    closure,
    flags: [...new Set(flags)],
  };
}
