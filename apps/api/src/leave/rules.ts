import type { LeaveRules, LedgerKind } from '@hrms/shared';

/**
 * Pure leave-balance rules (LEV-01, LEV-02, LEV-06). The leave year is the calendar year.
 * Golden cases are in test/leave-rules.test.ts.
 *
 * Ledger semantics: the balance on a date is the sum of the entries effective on or before
 * it, starting at the latest opening entry (an opening entry states the whole balance on its
 * date and replaces everything before it, including that day's accrual; DL-036).
 */

export interface LedgerRow {
  kind: LedgerKind;
  amount: number;
  effectiveDate: string;
  periodKey?: string | null;
}

export interface PlannedEntry {
  kind: 'accrual' | 'expiry' | 'carryover_expiry';
  effectiveDate: string;
  amount: number;
  periodKey: string;
  note: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const pad = (n: number) => String(n).padStart(2, '0');
const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const daysInYear = (y: number) => (isLeap(y) ? 366 : 365);
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const dayOfYear = (d: string) => {
  const t = Date.parse(`${d}T00:00:00Z`);
  return Math.round((t - Date.UTC(Number(d.slice(0, 4)), 0, 1)) / 86_400_000) + 1;
};

export function addMonths(d: string, months: number): string {
  const y = Number(d.slice(0, 4));
  const m = Number(d.slice(5, 7)) - 1 + months;
  const ny = y + Math.floor(m / 12);
  const nm = ((m % 12) + 12) % 12;
  const day = Math.min(Number(d.slice(8, 10)), daysInMonth(ny, nm + 1));
  return `${ny}-${pad(nm + 1)}-${pad(day)}`;
}

/** Completed years of service on a date. */
export function serviceYears(hireDate: string, on: string): number {
  let years = Number(on.slice(0, 4)) - Number(hireDate.slice(0, 4));
  if (on.slice(5) < hireDate.slice(5)) years--;
  return Math.max(0, years);
}

/** Entitlement for a leave year: the highest service tier reached, otherwise the base. */
export function entitlementFor(rules: LeaveRules, years: number): number {
  let days = rules.entitlementDays;
  let best = 0;
  for (const t of rules.serviceTiers) {
    if (years >= t.fromYears && t.fromYears >= best) {
      best = t.fromYears;
      days = t.days;
    }
  }
  return days;
}

/** Opening entry that starts the current balance (latest one on or before the date). */
function latestOpening(rows: LedgerRow[], asOf: string): string | null {
  let at: string | null = null;
  for (const r of rows) if (r.kind === 'opening' && r.effectiveDate <= asOf && (!at || r.effectiveDate >= at)) at = r.effectiveDate;
  return at;
}

/** Rows that count for the balance on a date. */
export function countedRows(rows: LedgerRow[], asOf: string): LedgerRow[] {
  const opening = latestOpening(rows, asOf);
  // On the opening date itself, the opening replaces entitlement entries (accrual, expiry)
  // while transactions of that day (usage, refund, adjustment) still count.
  const sameDayKinds: LedgerKind[] = ['opening', 'usage', 'refund', 'adjustment'];
  return rows.filter(
    (r) => r.effectiveDate <= asOf && (!opening || r.effectiveDate > opening || (r.effectiveDate === opening && sameDayKinds.includes(r.kind))),
  );
}

export function balanceOn(rows: LedgerRow[], asOf: string): number {
  // If several openings share the latest date, they are summed (an opening may be split by note).
  return round2(countedRows(rows, asOf).reduce((t, r) => t + r.amount, 0));
}

/**
 * Entries the accrual job should have written up to `asOf` (idempotent through periodKey).
 * `start` is when tracking begins: the hire date, or later when the type was introduced.
 */
export function plannedEntries(rules: LeaveRules, hireDate: string, start: string, asOf: string, rows: LedgerRow[]): PlannedEntry[] {
  if (rules.accrual === 'none' || asOf < start) return [];
  const out: PlannedEntry[] = [];
  const all: LedgerRow[] = [...rows];
  const written = new Set(rows.filter((r) => r.periodKey).map((r) => `${r.kind}:${r.periodKey}`));
  const add = (e: PlannedEntry) => {
    if (written.has(`${e.kind}:${e.periodKey}`)) return;
    written.add(`${e.kind}:${e.periodKey}`);
    out.push(e);
    all.push(e);
  };
  const startYear = Number(start.slice(0, 4));
  const endYear = Number(asOf.slice(0, 4));
  const opening = latestOpening(rows, asOf);
  // Periods that started on or before the opening balance are already included in it.
  const coveredByOpening = (from: string) => !!opening && from <= opening;

  // Accrual grants (entitlement by service on the first day of the period).
  for (let y = startYear; y <= endYear; y++) {
    if (rules.accrual === 'yearly') {
      const from = y === startYear ? start : `${y}-01-01`;
      if (from > asOf) break;
      const share = (daysInYear(y) - dayOfYear(from) + 1) / daysInYear(y);
      const amount = round2(entitlementFor(rules, serviceYears(hireDate, from)) * share);
      if (amount > 0 && !coveredByOpening(from)) {
        add({ kind: 'accrual', effectiveDate: from, amount, periodKey: String(y), note: share < 1 ? `Pro-rata ${y}` : `Entitlement ${y}` });
      }
      continue;
    }
    for (let m = 1; m <= 12; m++) {
      const month = `${y}-${pad(m)}`;
      if (month < start.slice(0, 7)) continue;
      const from = month === start.slice(0, 7) ? start : `${month}-01`;
      if (from > asOf) break;
      const dim = daysInMonth(y, m);
      const share = (dim - Number(from.slice(8, 10)) + 1) / dim;
      const amount = round2((entitlementFor(rules, serviceYears(hireDate, from)) / 12) * share);
      if (amount > 0 && !coveredByOpening(from)) add({ kind: 'accrual', effectiveDate: from, amount, periodKey: month, note: `Accrual ${month}` });
    }
  }

  // Year end: carryover cap, then expiry of carried days that were not used in time.
  for (let y = startYear; y < endYear; y++) {
    const newYear = `${y + 1}-01-01`;
    if (opening && opening >= newYear) continue;
    const atEnd = balanceOn(all, `${y}-12-31`);
    let carried = Math.max(0, atEnd);
    if (rules.carryoverMaxDays !== null && atEnd > rules.carryoverMaxDays) {
      add({ kind: 'expiry', effectiveDate: newYear, amount: -round2(atEnd - rules.carryoverMaxDays), periodKey: String(y), note: `Above carryover limit ${y}` });
      carried = rules.carryoverMaxDays;
    }
    if (rules.carryoverExpiryMonths === null || carried <= 0) continue;
    const deadline = addMonths(newYear, rules.carryoverExpiryMonths);
    if (deadline > asOf) continue;
    // Days taken in the new year before the deadline use the carried days first.
    const used = -all
      .filter((r) => (r.kind === 'usage' || r.kind === 'refund') && r.effectiveDate >= newYear && r.effectiveDate < deadline)
      .reduce((t, r) => t + r.amount, 0);
    const lapse = round2(Math.max(0, Math.min(carried - Math.max(0, used), balanceOn(all, addDays(deadline, -1)))));
    if (lapse > 0) {
      add({ kind: 'carryover_expiry', effectiveDate: deadline, amount: -lapse, periodKey: String(y), note: `Carried days from ${y} expired` });
    }
  }
  return out;
}

export function addDays(d: string, n: number): string {
  return new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}
