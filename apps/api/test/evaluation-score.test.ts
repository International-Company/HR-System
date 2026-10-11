import { describe, expect, it } from 'vitest';
import { DEFAULT_EVALUATION_POLICY, evaluationPolicySchema } from '@hrms/shared';
import { computeEvaluation, periodRange, type EvalDay } from '../src/evaluation/score.js';

const day = (over: Partial<EvalDay> = {}): EvalDay => ({
  dayClass: 'workday',
  status: 'present',
  lateMinutes: 0,
  earlyMinutes: 0,
  workedMinutes: 480,
  overtimeMinutes: 0,
  expectedMinutes: 480,
  ...over,
});
const days = (n: number, over: Partial<EvalDay> = {}) => Array.from({ length: n }, () => day(over));

describe('commitment evaluation — golden cases (CEV-01, CEV-02)', () => {
  it('a perfect month scores 100 in the top band', () => {
    const r = computeEvaluation(days(20), DEFAULT_EVALUATION_POLICY);
    expect(r.score).toBe(100);
    expect(r.band.nameEn).toBe('Excellent');
  });

  it('absences, late days, early departures and short hours reduce their components', () => {
    const input = [...days(16), day({ lateMinutes: 15 }), day({ earlyMinutes: 30, workedMinutes: 450 }), day({ status: 'absent_confirmed', workedMinutes: 0 }), day({ status: 'absent_confirmed', workedMinutes: 0 })];
    const r = computeEvaluation(input, DEFAULT_EVALUATION_POLICY);
    const c = Object.fromEntries(r.components.map((x) => [x.key, x.score]));
    expect(c).toMatchObject({ attendance: 90, punctuality: 94.44, early_departure: 94.44, worked_hours: 89.69 });
    // 0.5×90 + 0.25×94.44 + 0.10×94.44 + 0.15×89.69 = 45 + 23.61 + 9.44 + 13.45
    expect(r.score).toBe(91.51);
    expect(r.counts).toEqual({ required: 20, present: 18, lateDays: 1, earlyDays: 1, absent: 2 });
  });

  it('leave, holidays, rest days and unreviewed absences do not count (by default)', () => {
    const input = [...days(10), day({ status: 'excused', workedMinutes: 0 }), day({ dayClass: 'holiday', status: 'not_required' }), day({ dayClass: 'rest', status: 'not_required' }), day({ status: 'absent_pending', workedMinutes: 0 })];
    expect(computeEvaluation(input, DEFAULT_EVALUATION_POLICY).score).toBe(100);
    const strict = computeEvaluation(input, { ...DEFAULT_EVALUATION_POLICY, countPendingAbsence: true });
    expect(strict.counts).toMatchObject({ required: 11, absent: 1 });
    expect(strict.components.find((x) => x.key === 'attendance')!.score).toBe(90.91);
  });

  it('overtime counts only with a weight, up to the target', () => {
    const policy = { ...DEFAULT_EVALUATION_POLICY, weights: { attendance: 40, punctuality: 20, early_departure: 10, worked_hours: 10, overtime: 20 } };
    const r = computeEvaluation(days(20, { overtimeMinutes: 15 }), policy); // 5 h of 10 h target
    expect(r.components.find((x) => x.key === 'overtime')!.score).toBe(50);
    expect(r.score).toBe(90);
  });

  it('bands pick the highest band reached; the policy validates weights and bands', () => {
    // 10 of 20 days: 0.5×50 + 0.25×100 + 0.10×100 + 0.15×50 = 67.5
    const input = [...days(10), ...days(10, { status: 'absent_confirmed', workedMinutes: 0 })];
    expect(computeEvaluation(input, DEFAULT_EVALUATION_POLICY).band.nameEn).toBe('Acceptable');
    expect(evaluationPolicySchema.safeParse({ ...DEFAULT_EVALUATION_POLICY, weights: { ...DEFAULT_EVALUATION_POLICY.weights, attendance: 10 } }).success).toBe(false);
    expect(evaluationPolicySchema.safeParse({ ...DEFAULT_EVALUATION_POLICY, bands: [{ minScore: 50, nameAr: 'x', nameEn: 'x', bonusPercent: 0 }] }).success).toBe(false);
  });

  it('periods: months and quarters', () => {
    expect(periodRange('2026-02')).toEqual({ start: '2026-02-01', end: '2026-02-28', months: ['2026-02'] });
    expect(periodRange('2026-Q4')).toEqual({ start: '2026-10-01', end: '2026-12-31', months: ['2026-10', '2026-11', '2026-12'] });
  });
});
