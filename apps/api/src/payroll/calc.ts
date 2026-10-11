import type { EndOfServicePolicy, ItemSource, PayrollPolicy } from '@hrms/shared';

/**
 * Pure payroll calculation for one employee and one monthly period (PAY-01, PAY-08, D-10).
 * Every item carries a human-readable explanation. Golden cases: test/payroll-calc.test.ts.
 * No statutory tax or social insurance is computed (Q-24): only configured items.
 */

export interface PaySegment {
  /** Inclusive dates, already clipped to the period. */
  from: string;
  to: string;
  baseMonthly: number;
  currency: string;
  items: { kind: 'allowance' | 'deduction'; code: string; label: string; calc: 'fixed' | 'percent_of_base'; amount: number }[];
}

export interface CalcInput {
  periodStart: string;
  periodEnd: string;
  policy: PayrollPolicy;
  /** Days of employment in this company within the period (inclusive ranges). */
  employed: { from: string; to: string }[];
  segments: PaySegment[];
  /** Scheduled workdays in the period (for the working-days basis). */
  workdaysInPeriod: number;
  attendance: {
    overtimeMinutes: number;
    holidayWorkMinutes: number;
    lateMinutes: number;
    absentConfirmedDays: number;
    absentPendingDays: number;
  };
  unpaidLeaveDays: number;
  manual: { id: string; kind: 'earning' | 'deduction'; label: string; amount: number }[];
  /** Finalised commitment evaluation of the month with salary impact (Phase 10). */
  commitment?: { bonusPercent: number; band: string } | null;
}

export interface CalcItem {
  kind: 'earning' | 'deduction';
  source: ItemSource;
  code: string;
  label: string;
  quantity: number | null;
  rate: number | null;
  amount: number;
  explanation: string;
  manualId?: string;
}

export interface CalcResult {
  currency: string;
  daysPaid: number;
  periodDays: number;
  items: CalcItem[];
  gross: number;
  deductions: number;
  net: number;
  warnings: string[];
}

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const money = (n: number) => n.toFixed(2);
const day = 86_400_000;
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / day) + 1;
const maxS = (a: string, b: string) => (a > b ? a : b);
const minS = (a: string, b: string) => (a < b ? a : b);

function overlapDays(a: { from: string; to: string }, b: { from: string; to: string }): number {
  const from = maxS(a.from, b.from);
  const to = minS(a.to, b.to);
  return from > to ? 0 : daysBetween(from, to);
}

export function calculatePay(input: CalcInput): CalcResult {
  const { policy } = input;
  const periodDays = daysBetween(input.periodStart, input.periodEnd);
  const warnings: string[] = [];
  const items: CalcItem[] = [];
  const daysPaid = input.employed.reduce((t, r) => t + daysBetween(r.from, r.to), 0);
  const segments = [...input.segments].sort((a, b) => a.from.localeCompare(b.from));
  const last = segments.at(-1);
  const currency = last?.currency ?? '';
  if (!last) warnings.push('no_salary');
  if (new Set(segments.map((s) => s.currency)).size > 1) warnings.push('currency_changed');

  // Base salary and recurring items, prorated by calendar days employed (mid-period changes).
  for (const s of segments) {
    const days = input.employed.reduce((t, r) => t + overlapDays(s, r), 0);
    if (!days) continue;
    const full = days === periodDays;
    const share = (amount: number) => (full ? amount : (amount * days) / periodDays);
    const prorate = full ? '' : ` × ${days}/${periodDays} days`;
    items.push({
      kind: 'earning',
      source: 'base',
      code: 'BASE',
      label: 'Basic salary',
      quantity: days,
      rate: s.baseMonthly,
      amount: round2(share(s.baseMonthly)),
      explanation: `${money(s.baseMonthly)}${prorate}`,
    });
    for (const it of s.items) {
      const monthly = it.calc === 'fixed' ? it.amount : (s.baseMonthly * it.amount) / 100;
      const how = it.calc === 'fixed' ? money(it.amount) : `${money(s.baseMonthly)} × ${it.amount}%`;
      items.push({
        kind: it.kind === 'allowance' ? 'earning' : 'deduction',
        source: 'recurring',
        code: it.code,
        label: it.label,
        quantity: null,
        rate: null,
        amount: round2(share(monthly)),
        explanation: `${how}${prorate}`,
      });
    }
  }

  // Rates for attendance and leave items, from the latest monthly base.
  const base = last?.baseMonthly ?? 0;
  let basisDays = policy.dayRateBasis === 'fixed_30' ? 30 : policy.dayRateBasis === 'calendar_days' ? periodDays : input.workdaysInPeriod;
  if (basisDays <= 0) {
    warnings.push('no_workdays_basis');
    basisDays = 30;
  }
  const dayRate = base / basisDays;
  const hourRate = dayRate / policy.hoursPerDay;
  const rateText = `${money(base)} ÷ ${basisDays}`;

  const { attendance: a } = input;
  if (policy.overtimeMultiplier > 0 && a.overtimeMinutes > 0) {
    const hours = a.overtimeMinutes / 60;
    items.push({
      kind: 'earning',
      source: 'attendance',
      code: 'OVERTIME',
      label: 'Overtime',
      quantity: round2(hours),
      rate: round2(hourRate * policy.overtimeMultiplier),
      amount: round2(hours * hourRate * policy.overtimeMultiplier),
      explanation: `${round2(hours)} h × (${rateText} ÷ ${policy.hoursPerDay} h) × ${policy.overtimeMultiplier}`,
    });
  }
  if (policy.holidayWorkMultiplier > 0 && a.holidayWorkMinutes > 0) {
    const hours = a.holidayWorkMinutes / 60;
    items.push({
      kind: 'earning',
      source: 'attendance',
      code: 'HOLIDAY_WORK',
      label: 'Holiday work',
      quantity: round2(hours),
      rate: round2(hourRate * policy.holidayWorkMultiplier),
      amount: round2(hours * hourRate * policy.holidayWorkMultiplier),
      explanation: `${round2(hours)} h × (${rateText} ÷ ${policy.hoursPerDay} h) × ${policy.holidayWorkMultiplier}`,
    });
  }
  if (policy.latenessDeduction === 'per_minute') {
    const chargeable = Math.max(0, a.lateMinutes - policy.latenessToleranceMinutes);
    if (chargeable > 0) {
      items.push({
        kind: 'deduction',
        source: 'attendance',
        code: 'LATENESS',
        label: 'Lateness',
        quantity: chargeable,
        rate: round2(hourRate / 60),
        amount: round2((chargeable * hourRate) / 60),
        explanation: `(${a.lateMinutes} − ${policy.latenessToleranceMinutes} tolerance) min × (${rateText} ÷ ${policy.hoursPerDay} h ÷ 60)`,
      });
    }
  }
  const absent = policy.absenceDeduction === 'none' ? 0 : a.absentConfirmedDays + (policy.absenceDeduction === 'confirmed_and_pending' ? a.absentPendingDays : 0);
  if (absent > 0) {
    items.push({
      kind: 'deduction',
      source: 'attendance',
      code: 'ABSENCE',
      label: 'Absence',
      quantity: absent,
      rate: round2(dayRate),
      amount: round2(absent * dayRate),
      explanation: `${absent} day(s) × ${rateText}`,
    });
  }
  if (policy.unpaidLeaveDeduction && input.unpaidLeaveDays > 0) {
    items.push({
      kind: 'deduction',
      source: 'leave',
      code: 'UNPAID_LEAVE',
      label: 'Unpaid leave',
      quantity: input.unpaidLeaveDays,
      rate: round2(dayRate),
      amount: round2(input.unpaidLeaveDays * dayRate),
      explanation: `${input.unpaidLeaveDays} day(s) × ${rateText}`,
    });
  }
  if (input.commitment && input.commitment.bonusPercent > 0 && base > 0) {
    items.push({
      kind: 'earning',
      source: 'attendance',
      code: 'COMMITMENT',
      label: 'Commitment bonus',
      quantity: null,
      rate: input.commitment.bonusPercent,
      amount: round2((base * input.commitment.bonusPercent) / 100),
      explanation: `${money(base)} × ${input.commitment.bonusPercent}% (${input.commitment.band})`,
    });
  }
  for (const m of input.manual) {
    items.push({ kind: m.kind, source: 'manual', code: 'MANUAL', label: m.label, quantity: null, rate: null, amount: round2(m.amount), explanation: 'Entered manually', manualId: m.id });
  }

  const gross = round2(items.filter((i) => i.kind === 'earning').reduce((t, i) => t + i.amount, 0));
  const deductions = round2(items.filter((i) => i.kind === 'deduction').reduce((t, i) => t + i.amount, 0));
  const net = round2(gross - deductions);
  if (net < 0) warnings.push('negative_net');
  return { currency, daysPaid, periodDays, items, gross, deductions, net, warnings };
}

/** End-of-service settlement estimate (PAY-11) with predefined methods. */
export function endOfService(policy: EndOfServicePolicy, hireDate: string, endDate: string, monthlyBase: number): { years: number; amount: number; explanation: string[] } {
  const years = Math.max(0, (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${hireDate}T00:00:00Z`)) / day + 1) / 365.25;
  const y = Math.round(years * 1000) / 1000;
  const explanation: string[] = [`Service: ${y} years`];
  if (policy.method === 'none') return { years: y, amount: 0, explanation: [...explanation, 'No end-of-service method configured'] };
  if (y < policy.minYears) return { years: y, amount: 0, explanation: [...explanation, `Less than the minimum of ${policy.minYears} years`] };
  let amount = 0;
  if (policy.method === 'months_per_year') {
    amount = y * policy.monthsPerYear * monthlyBase;
    explanation.push(`${y} years × ${policy.monthsPerYear} month(s) × ${money(monthlyBase)}`);
  } else {
    const bands = [...policy.bands].sort((a, b) => a.fromYears - b.fromYears);
    for (let i = 0; i < bands.length; i++) {
      const from = bands[i]!.fromYears;
      const to = bands[i + 1]?.fromYears ?? Number.POSITIVE_INFINITY;
      const inBand = Math.max(0, Math.min(y, to) - from);
      if (!inBand) continue;
      const part = (inBand * bands[i]!.daysPerYear * monthlyBase) / 30;
      amount += part;
      explanation.push(`${round2(inBand)} years × ${bands[i]!.daysPerYear} days × ${money(monthlyBase)} ÷ 30 = ${money(part)}`);
    }
  }
  if (policy.capMonths !== null && amount > policy.capMonths * monthlyBase) {
    amount = policy.capMonths * monthlyBase;
    explanation.push(`Capped at ${policy.capMonths} months`);
  }
  return { years: y, amount: round2(amount), explanation };
}
