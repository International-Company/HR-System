import { describe, expect, it } from 'vitest';
import type { PayrollPolicy } from '@hrms/shared';
import { calculatePay, endOfService, type CalcInput } from '../src/payroll/calc.js';

const policy: PayrollPolicy = {
  dayRateBasis: 'fixed_30',
  hoursPerDay: 8,
  overtimeMultiplier: 1.25,
  holidayWorkMultiplier: 1.5,
  latenessDeduction: 'none',
  latenessToleranceMinutes: 60,
  absenceDeduction: 'confirmed',
  unpaidLeaveDeduction: true,
  payDay: 28,
  notifyEmployees: true,
};
const noAttendance = { overtimeMinutes: 0, holidayWorkMinutes: 0, lateMinutes: 0, absentConfirmedDays: 0, absentPendingDays: 0 };
const month = (over: Partial<CalcInput> = {}): CalcInput => ({
  periodStart: '2026-03-01',
  periodEnd: '2026-03-31',
  policy,
  employed: [{ from: '2026-03-01', to: '2026-03-31' }],
  segments: [{ from: '2026-03-01', to: '2026-03-31', baseMonthly: 3000, currency: 'EUR', items: [] }],
  workdaysInPeriod: 22,
  attendance: noAttendance,
  unpaidLeaveDays: 0,
  manual: [],
  ...over,
});
const amounts = (r: ReturnType<typeof calculatePay>) => Object.fromEntries(r.items.map((i) => [i.code, i.amount]));

describe('payroll calculation — golden cases (PAY-01, PAY-08)', () => {
  it('full month: base and recurring allowance/deduction (fixed and % of base)', () => {
    const r = calculatePay(
      month({
        segments: [
          {
            from: '2026-03-01',
            to: '2026-03-31',
            baseMonthly: 3000,
            currency: 'EUR',
            items: [
              { kind: 'allowance', code: 'HOUSING', label: 'Housing', calc: 'percent_of_base', amount: 25 },
              { kind: 'allowance', code: 'TRANSPORT', label: 'Transport', calc: 'fixed', amount: 150 },
              { kind: 'deduction', code: 'PENSION', label: 'Pension', calc: 'percent_of_base', amount: 5 },
            ],
          },
        ],
      }),
    );
    expect(amounts(r)).toEqual({ BASE: 3000, HOUSING: 750, TRANSPORT: 150, PENSION: 150 });
    expect(r).toMatchObject({ gross: 3900, deductions: 150, net: 3750, daysPaid: 31, currency: 'EUR', warnings: [] });
  });

  it('mid-month hire is prorated by calendar days', () => {
    const r = calculatePay(month({ employed: [{ from: '2026-03-16', to: '2026-03-31' }], segments: [{ from: '2026-03-16', to: '2026-03-31', baseMonthly: 3100, currency: 'EUR', items: [] }] }));
    expect(r.items[0]).toMatchObject({ amount: 1600, explanation: '3100.00 × 16/31 days' });
    expect(r.daysPaid).toBe(16);
  });

  it('salary change in the middle of the period: each part prorated', () => {
    const r = calculatePay(
      month({
        segments: [
          { from: '2026-03-01', to: '2026-03-10', baseMonthly: 3100, currency: 'EUR', items: [] },
          { from: '2026-03-11', to: '2026-03-31', baseMonthly: 4650, currency: 'EUR', items: [] },
        ],
      }),
    );
    expect(r.items.map((i) => i.amount)).toEqual([1000, 3150]);
    expect(r.gross).toBe(4150);
  });

  it('overtime and holiday work: hourly rate × multiplier (30-day basis)', () => {
    const r = calculatePay(month({ attendance: { ...noAttendance, overtimeMinutes: 600, holidayWorkMinutes: 240 } }));
    // day 100.00, hour 12.50 → 10 h × 12.50 × 1.25 = 156.25; 4 h × 12.50 × 1.5 = 75
    expect(amounts(r)).toMatchObject({ OVERTIME: 156.25, HOLIDAY_WORK: 75 });
    expect(r.net).toBe(3231.25);
  });

  it('lateness per minute after a monthly tolerance; absence; unpaid leave', () => {
    const r = calculatePay(
      month({
        policy: { ...policy, latenessDeduction: 'per_minute' },
        attendance: { ...noAttendance, lateMinutes: 90, absentConfirmedDays: 1, absentPendingDays: 2 },
        unpaidLeaveDays: 2,
      }),
    );
    // 30 min × 12.50/60 = 6.25; 1 day × 100; 2 days × 100
    expect(amounts(r)).toMatchObject({ LATENESS: 6.25, ABSENCE: 100, UNPAID_LEAVE: 200 });
    expect(r.net).toBe(2693.75);
    const withPending = calculatePay(month({ policy: { ...policy, absenceDeduction: 'confirmed_and_pending' }, attendance: { ...noAttendance, absentConfirmedDays: 1, absentPendingDays: 2 } }));
    expect(amounts(withPending).ABSENCE).toBe(300);
  });

  it('working-days basis uses the scheduled workdays of the period', () => {
    const r = calculatePay(month({ policy: { ...policy, dayRateBasis: 'working_days' }, workdaysInPeriod: 22, attendance: { ...noAttendance, absentConfirmedDays: 1 } }));
    expect(amounts(r).ABSENCE).toBe(136.36); // 3000 ÷ 22
  });

  it('manual items, rounding to cents, and a negative-net warning', () => {
    const r = calculatePay(month({ manual: [{ id: 'm1', kind: 'earning', label: 'Bonus', amount: 100.005 }, { id: 'm2', kind: 'deduction', label: 'Advance', amount: 5000 }] }));
    expect(r.items.find((i) => i.manualId === 'm1')!.amount).toBe(100.01);
    expect(r.net).toBe(-1899.99);
    expect(r.warnings).toContain('negative_net');
  });

  it('missing salary and changed currency are reported', () => {
    expect(calculatePay(month({ segments: [] })).warnings).toContain('no_salary');
    const r = calculatePay(
      month({
        segments: [
          { from: '2026-03-01', to: '2026-03-15', baseMonthly: 3000, currency: 'EUR', items: [] },
          { from: '2026-03-16', to: '2026-03-31', baseMonthly: 3000, currency: 'USD', items: [] },
        ],
      }),
    );
    expect(r.warnings).toContain('currency_changed');
    expect(r.currency).toBe('USD');
  });
});

describe('end of service (PAY-11)', () => {
  it('none by default; days per year by service bands; months per year; cap and minimum', () => {
    expect(endOfService({ method: 'none', bands: [], monthsPerYear: 0, minYears: 0, capMonths: null }, '2020-01-01', '2025-12-31', 3000).amount).toBe(0);
    const bands = endOfService({ method: 'days_per_year', bands: [{ fromYears: 0, daysPerYear: 15 }, { fromYears: 5, daysPerYear: 30 }], monthsPerYear: 0, minYears: 1, capMonths: null }, '2018-01-01', '2025-12-31', 3000);
    // ~8 years: 5 × 15 days + ~3 × 30 days of (3000 ÷ 30)
    expect(bands.years).toBeCloseTo(8, 1);
    expect(bands.amount).toBeCloseTo(5 * 15 * 100 + (bands.years - 5) * 30 * 100, 0);
    expect(endOfService({ method: 'months_per_year', bands: [], monthsPerYear: 1, minYears: 2, capMonths: null }, '2025-01-01', '2025-12-31', 3000).amount).toBe(0);
    expect(endOfService({ method: 'months_per_year', bands: [], monthsPerYear: 1, minYears: 0, capMonths: 6 }, '2010-01-01', '2025-12-31', 3000).amount).toBe(18000);
  });
});
