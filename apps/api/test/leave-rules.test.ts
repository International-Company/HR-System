import { describe, expect, it } from 'vitest';
import { DEFAULT_LEAVE_RULES, type LeaveRules } from '@hrms/shared';
import { addMonths, balanceOn, entitlementFor, plannedEntries, serviceYears, type LedgerRow } from '../src/leave/rules.js';

const rules = (r: Partial<LeaveRules> = {}): LeaveRules => ({ ...DEFAULT_LEAVE_RULES, ...r });
const apply = (r: LeaveRules, hire: string, start: string, asOf: string, rows: LedgerRow[] = []) => {
  const planned = plannedEntries(r, hire, start, asOf, rows);
  return { planned, rows: [...rows, ...planned], balance: balanceOn([...rows, ...planned], asOf) };
};

describe('leave rules — golden cases (LEV-01, LEV-02)', () => {
  it('service years and month arithmetic', () => {
    expect(serviceYears('2020-09-01', '2025-08-31')).toBe(4);
    expect(serviceYears('2020-09-01', '2025-09-01')).toBe(5);
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-11-01', 3)).toBe('2027-02-01');
  });

  it('mid-year hire gets a pro-rata yearly grant', () => {
    const { planned, balance } = apply(rules(), '2026-07-01', '2026-07-01', '2026-10-11');
    expect(planned).toEqual([expect.objectContaining({ kind: 'accrual', amount: 10.59, periodKey: '2026', effectiveDate: '2026-07-01' })]);
    expect(balance).toBe(10.59);
  });

  it('full year entitlement on 1 January; service tiers raise it', () => {
    expect(apply(rules(), '2020-01-15', '2026-01-01', '2026-03-01').balance).toBe(21);
    const tiered = rules({ serviceTiers: [{ fromYears: 5, days: 30 }, { fromYears: 10, days: 35 }] });
    expect(entitlementFor(tiered, 4)).toBe(21);
    expect(entitlementFor(tiered, 12)).toBe(35);
    expect(apply(tiered, '2021-01-01', '2026-01-01', '2026-03-01').balance).toBe(30);
  });

  it('monthly accrual: 1/12 per month, first month pro-rata', () => {
    const { planned } = apply(rules({ accrual: 'monthly', entitlementDays: 24 }), '2026-03-16', '2026-03-16', '2026-05-10');
    expect(planned.map((p) => [p.periodKey, p.amount])).toEqual([
      ['2026-03', 1.03],
      ['2026-04', 2],
      ['2026-05', 2],
    ]);
  });

  it('carryover cap: days above the limit lapse on 1 January', () => {
    const used: LedgerRow[] = [{ kind: 'usage', amount: -6, effectiveDate: '2025-06-01' }];
    const { planned, balance } = apply(rules({ carryoverMaxDays: 5 }), '2024-01-01', '2025-01-01', '2026-02-01', used);
    expect(planned).toContainEqual(expect.objectContaining({ kind: 'expiry', amount: -10, effectiveDate: '2026-01-01', periodKey: '2025' }));
    expect(balance).toBe(26); // 21 - 6 - 10 + 21
  });

  it('carried days expire after N months unless used first', () => {
    const rows: LedgerRow[] = [
      { kind: 'usage', amount: -6, effectiveDate: '2025-06-01' },
      { kind: 'usage', amount: -4, effectiveDate: '2026-02-10' },
    ];
    const r = rules({ carryoverExpiryMonths: 3 });
    expect(apply(r, '2024-01-01', '2025-01-01', '2026-03-31', rows).planned.some((p) => p.kind === 'carryover_expiry')).toBe(false);
    const { planned, balance } = apply(r, '2024-01-01', '2025-01-01', '2026-04-02', rows);
    expect(planned).toContainEqual(expect.objectContaining({ kind: 'carryover_expiry', amount: -11, effectiveDate: '2026-04-01' }));
    expect(balance).toBe(21); // 15 carried - 4 used - 11 lapsed + 21
  });

  it('an opening balance replaces everything before it and the periods it covers', () => {
    const rows: LedgerRow[] = [{ kind: 'opening', amount: 12.5, effectiveDate: '2026-03-01' }];
    const now = apply(rules(), '2019-05-01', '2024-01-01', '2026-10-01', rows);
    expect(now.planned).toEqual([]);
    expect(now.balance).toBe(12.5);
    const next = apply(rules(), '2019-05-01', '2024-01-01', '2027-01-05', rows);
    expect(next.planned).toEqual([expect.objectContaining({ kind: 'accrual', periodKey: '2027', amount: 21 })]);
    expect(next.balance).toBe(33.5);
  });

  it('is idempotent: written entries are not planned again', () => {
    const first = apply(rules({ carryoverMaxDays: 5 }), '2024-01-01', '2024-01-01', '2026-02-01');
    expect(plannedEntries(rules({ carryoverMaxDays: 5 }), '2024-01-01', '2024-01-01', '2026-02-01', first.rows)).toEqual([]);
  });

  it('types without a balance plan nothing', () => {
    expect(apply(rules({ accrual: 'none' }), '2024-01-01', '2024-01-01', '2026-02-01').planned).toEqual([]);
  });

  it('property: the displayed balance always equals the sum of the counted ledger rows', () => {
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let i = 0; i < 200; i++) {
      const rows: LedgerRow[] = [];
      for (let k = 0; k < 8; k++) {
        const month = String(1 + Math.floor(rnd() * 12)).padStart(2, '0');
        rows.push({ kind: rnd() < 0.7 ? 'usage' : 'refund', amount: (rnd() < 0.7 ? -1 : 1) * (1 + Math.floor(rnd() * 5)), effectiveDate: `202${4 + Math.floor(rnd() * 2)}-${month}-10` });
      }
      const r = rules({ carryoverMaxDays: Math.floor(rnd() * 10), carryoverExpiryMonths: rnd() < 0.5 ? 3 : null, accrual: rnd() < 0.5 ? 'yearly' : 'monthly' });
      const { rows: all, balance } = apply(r, '2023-04-01', '2024-01-01', '2026-06-30', rows);
      const sum = Math.round(all.filter((x) => x.effectiveDate <= '2026-06-30').reduce((t, x) => t + x.amount, 0) * 100) / 100;
      expect(balance).toBe(sum);
      // Re-running the job never changes the balance.
      expect(plannedEntries(r, '2023-04-01', '2024-01-01', '2026-06-30', all)).toEqual([]);
    }
  });
});
