import type { EvaluationComponentDto, EvaluationPolicy } from '@hrms/shared';

/**
 * Pure attendance-commitment score (CEV-01, CEV-02). Inputs are attendance days only.
 * Golden cases: test/evaluation-score.test.ts.
 */

export interface EvalDay {
  dayClass: string;
  status: string;
  lateMinutes: number;
  earlyMinutes: number;
  workedMinutes: number;
  overtimeMinutes: number;
  /** Scheduled working minutes (after unpaid breaks). */
  expectedMinutes: number;
}

export interface EvalResult {
  score: number;
  band: { nameAr: string; nameEn: string; bonusPercent: number };
  components: EvaluationComponentDto[];
  counts: { required: number; present: number; lateDays: number; earlyDays: number; absent: number };
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const pct = (part: number, whole: number) => (whole > 0 ? Math.max(0, Math.min(100, (100 * part) / whole)) : 100);

export function computeEvaluation(days: EvalDay[], policy: EvaluationPolicy): EvalResult {
  const absentStatuses = policy.countPendingAbsence ? ['absent_confirmed', 'absent_pending'] : ['absent_confirmed'];
  // Required: scheduled workdays that count (leave, holidays, future and unreviewed days are left out).
  const required = days.filter((d) => d.dayClass === 'workday' && (d.status === 'present' || d.status === 'incomplete' || absentStatuses.includes(d.status)));
  const present = required.filter((d) => d.status === 'present' || d.status === 'incomplete');
  const lateDays = present.filter((d) => d.lateMinutes > 0).length;
  const earlyDays = present.filter((d) => d.earlyMinutes > 0).length;
  const worked = required.reduce((t, d) => t + d.workedMinutes, 0);
  const expected = required.reduce((t, d) => t + d.expectedMinutes, 0);
  const overtimeHours = days.reduce((t, d) => t + d.overtimeMinutes, 0) / 60;

  const raw: Record<EvaluationComponentDto['key'], { score: number; detail: string }> = {
    attendance: { score: pct(present.length, required.length), detail: `${present.length}/${required.length} days` },
    punctuality: { score: pct(present.length - lateDays, present.length), detail: `${lateDays} late day(s)` },
    early_departure: { score: pct(present.length - earlyDays, present.length), detail: `${earlyDays} early departure(s)` },
    worked_hours: { score: pct(worked, expected), detail: `${r2(worked / 60)}/${r2(expected / 60)} h` },
    overtime: { score: pct(overtimeHours, policy.overtimeTargetHours), detail: `${r2(overtimeHours)}/${policy.overtimeTargetHours} h` },
  };
  const components: EvaluationComponentDto[] = (Object.keys(raw) as EvaluationComponentDto['key'][]).map((key) => ({
    key,
    weight: policy.weights[key],
    score: r2(raw[key].score),
    detail: raw[key].detail,
  }));
  const score = r2(components.reduce((t, c) => t + (c.weight * c.score) / 100, 0));
  const band = [...policy.bands].sort((a, b) => b.minScore - a.minScore).find((b) => score >= b.minScore) ?? policy.bands.at(-1)!;
  return {
    score,
    band: { nameAr: band.nameAr, nameEn: band.nameEn, bonusPercent: band.bonusPercent },
    components,
    counts: { required: required.length, present: present.length, lateDays, earlyDays, absent: required.length - present.length },
  };
}

/** Period boundaries: "2026-03" or "2026-Q1". */
export function periodRange(period: string): { start: string; end: string; months: string[] } {
  const year = Number(period.slice(0, 4));
  const q = period.match(/Q([1-4])$/);
  const firstMonth = q ? (Number(q[1]) - 1) * 3 + 1 : Number(period.slice(5, 7));
  const count = q ? 3 : 1;
  const months = Array.from({ length: count }, (_, i) => `${year}-${String(firstMonth + i).padStart(2, '0')}`);
  const end = new Date(Date.UTC(year, firstMonth - 1 + count, 0)).toISOString().slice(0, 10);
  return { start: `${months[0]}-01`, end, months };
}
