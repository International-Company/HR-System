import { describe, expect, it } from 'vitest';
import type { WorkdayDto } from '@hrms/shared';
import { computeDay, type AttendancePolicy } from '../src/attendance/compute.js';
import { localDate, localTime, zonedToUtc } from '../src/attendance/time.js';

/**
 * Golden cases for the attendance calculation (testing-strategy.md §3). Time zone
 * Europe/Berlin to exercise conversions; the day is a Monday in summer time (UTC+2).
 */
const TZ = 'Europe/Berlin';
const DATE = '2026-06-15';
const at = (hm: string, date = DATE) => zonedToUtc(date, hm, TZ);
const policy: AttendancePolicy = {
  requireNetwork: true,
  verification: 'none',
  deviceApproval: false,
  autoCheckout: false,
  overtimeMinMinutes: 15,
  earlyArrival: 'ignore',
  restDayWork: 'flag',
  correctionWindowDays: 30,
};
const workday: WorkdayDto = {
  date: DATE,
  scheduleId: 's1',
  isWorkday: true,
  holiday: null,
  startTime: '08:00',
  endTime: '16:00',
  breaks: [{ startTime: '12:00', endTime: '12:30', paid: false }],
  graceInMinutes: 10,
  graceOutMinutes: 5,
};
const nextDay = new Date(at('09:00', '2026-06-16'));
const run = (punches: [string, string][], over: Partial<Parameters<typeof computeDay>[0]> = {}) =>
  computeDay({
    workDate: DATE,
    tz: TZ,
    now: nextDay,
    employed: true,
    workday,
    punches: punches.map(([kind, hm]) => ({ kind: kind as 'in', at: at(hm) })),
    policy,
    review: null,
    ...over,
  });

describe('time zone helpers', () => {
  it('converts local wall-clock to UTC and back (DST aware)', () => {
    expect(zonedToUtc('2026-06-15', '08:00', TZ).toISOString()).toBe('2026-06-15T06:00:00.000Z');
    expect(zonedToUtc('2026-01-15', '08:00', TZ).toISOString()).toBe('2026-01-15T07:00:00.000Z');
    const t = zonedToUtc('2026-06-15', '23:30', TZ);
    expect(localDate(t, TZ)).toBe('2026-06-15');
    expect(localTime(t, TZ)).toBe('23:30');
  });
});

describe('attendance golden cases', () => {
  it('on time, full day: 7.5 h worked after the scheduled break, no flags', () => {
    const d = run([['in', '07:58'], ['out', '16:02']]);
    expect(d).toMatchObject({ dayClass: 'workday', status: 'present', lateMinutes: 0, earlyMinutes: 0, overtimeMinutes: 0, closure: 'normal' });
    expect(d.workedMinutes).toBe(8 * 60 + 4 - 30);
    expect(d.breakMinutes).toBe(30);
  });

  it('late inside the grace period is not late; beyond it counts from the start', () => {
    expect(run([['in', '08:09'], ['out', '16:00']]).lateMinutes).toBe(0);
    expect(run([['in', '08:11'], ['out', '16:00']]).lateMinutes).toBe(11);
  });

  it('early departure beyond the grace period', () => {
    expect(run([['in', '08:00'], ['out', '15:56']]).earlyMinutes).toBe(0);
    const d = run([['in', '08:00'], ['out', '15:30']]);
    expect(d.earlyMinutes).toBe(30);
    expect(d.flags).toContain('early_departure');
  });

  it('overtime after the scheduled end, only from the minimum threshold (ATT-12)', () => {
    expect(run([['in', '08:00'], ['out', '16:10']]).overtimeMinutes).toBe(0);
    expect(run([['in', '08:00'], ['out', '17:30']]).overtimeMinutes).toBe(90);
  });

  it('early arrival is ignored by default, counted when the policy says so', () => {
    expect(run([['in', '07:00'], ['out', '16:00']]).overtimeMinutes).toBe(0);
    expect(run([['in', '07:00'], ['out', '16:00']], { policy: { ...policy, earlyArrival: 'overtime' } }).overtimeMinutes).toBe(60);
  });

  it('extra breaks are deducted; a break that covers the scheduled break is not deducted twice', () => {
    const d = run([['in', '08:00'], ['break_start', '11:50'], ['break_end', '12:40'], ['out', '16:00']]);
    expect(d.breakMinutes).toBe(50);
    expect(d.workedMinutes).toBe(8 * 60 - 50);
  });

  it('missing check-out: open and incomplete, no overtime and no early departure', () => {
    const d = run([['in', '08:00']]);
    expect(d).toMatchObject({ closure: 'open', status: 'incomplete', overtimeMinutes: 0, earlyMinutes: 0 });
    expect(d.flags).toContain('missing_checkout');
  });

  it('administrative auto-closure never produces overtime (C-02)', () => {
    const d = run([['in', '08:00']], { policy: { ...policy, autoCheckout: true } });
    expect(d).toMatchObject({ closure: 'administrative', status: 'present', overtimeMinutes: 0 });
    expect(d.flags).toContain('administrative_closure');
    expect(d.workedMinutes).toBe(8 * 60 - 30);
  });

  it('still at work today: open session, present, not flagged', () => {
    const d = run([['in', '08:00']], { now: at('11:00') });
    expect(d).toMatchObject({ closure: 'open', status: 'present' });
    expect(d.workedMinutes).toBe(180);
    expect(d.flags).not.toContain('missing_checkout');
  });

  it('no punches on a past workday is a possible absence; approved leave excuses it (ATT-14)', () => {
    expect(run([]).status).toBe('absent_pending');
    expect(run([], { onLeave: true }).status).toBe('excused');
    expect(run([], { now: at('07:00') }).status).toBe('upcoming');
    expect(run([], { review: { status: 'absent_confirmed', note: 'x' } }).status).toBe('absent_confirmed');
  });

  it('holiday work is classified separately and is not overtime (ATT-17)', () => {
    const d = run([['in', '09:00'], ['out', '13:00']], { workday: { ...workday, isWorkday: false, holiday: { id: 'h', nameAr: 'ع', nameEn: 'H' } } });
    expect(d).toMatchObject({ dayClass: 'holiday', holidayWorkMinutes: 210, overtimeMinutes: 0 });
    expect(d.flags).toContain('holiday_work');
    expect(run([], { workday: { ...workday, isWorkday: false, holiday: { id: 'h', nameAr: 'ع', nameEn: 'H' } } }).status).toBe('not_required');
  });

  it('rest-day work is flagged, or overtime by policy (ATT-16)', () => {
    const rest = { ...workday, isWorkday: false, startTime: null, endTime: null, breaks: [] };
    const flagged = run([['in', '09:00'], ['out', '12:00']], { workday: rest });
    expect(flagged).toMatchObject({ dayClass: 'rest', overtimeMinutes: 0 });
    expect(flagged.flags).toContain('rest_day_work');
    expect(run([['in', '09:00'], ['out', '12:00']], { workday: rest, policy: { ...policy, restDayWork: 'overtime' } }).overtimeMinutes).toBe(180);
  });

  it('overnight shift ending the next day', () => {
    const night = { ...workday, startTime: '22:00', endTime: '06:00', breaks: [] };
    const d = computeDay({
      workDate: DATE,
      tz: TZ,
      now: new Date(at('12:00', '2026-06-16')),
      employed: true,
      workday: night,
      punches: [
        { kind: 'in', at: at('22:05') },
        { kind: 'out', at: at('06:30', '2026-06-16') },
      ],
      policy,
      review: null,
    });
    expect(d).toMatchObject({ lateMinutes: 0, earlyMinutes: 0, overtimeMinutes: 30, workedMinutes: 8 * 60 + 25 });
  });

  it('split shift with two sessions in a day', () => {
    const d = run([['in', '08:00'], ['out', '11:00'], ['in', '13:00'], ['out', '16:00']]);
    expect(d.workedMinutes).toBe(360);
    expect(d.status).toBe('present');
  });

  it('days outside employment are not required', () => {
    expect(run([], { employed: false }).status).toBe('not_required');
  });
});
