import { z } from 'zod';

/**
 * Phase 10: attendance commitment evaluation (CEV-01..03). Based only on attendance data:
 * presence, lateness, early departure, worked hours and overtime. No goals, self-assessment,
 * performance forms or behavioural ratings (CEV-03, EXC-01, EXC-02).
 */

export const EVALUATION_COMPONENTS = ['attendance', 'punctuality', 'early_departure', 'worked_hours', 'overtime'] as const;
export type EvaluationComponent = (typeof EVALUATION_COMPONENTS)[number];

export const evaluationPolicySchema = z
  .object({
    period: z.enum(['monthly', 'quarterly']),
    /** Weights in percent; they must add up to 100. */
    weights: z.object({
      attendance: z.number().min(0).max(100),
      punctuality: z.number().min(0).max(100),
      early_departure: z.number().min(0).max(100),
      worked_hours: z.number().min(0).max(100),
      overtime: z.number().min(0).max(100),
    }),
    /** Overtime hours in the period that give the full overtime score. */
    overtimeTargetHours: z.number().min(1).max(500),
    /** Unreviewed possible absences count as absences. */
    countPendingAbsence: z.boolean(),
    /** Score bands, highest first; bonusPercent of the monthly base when salary impact is on. */
    bands: z
      .array(z.object({ minScore: z.number().min(0).max(100), nameAr: z.string().trim().min(1).max(40), nameEn: z.string().trim().min(1).max(40), bonusPercent: z.number().min(0).max(100) }))
      .min(1)
      .max(8),
    employeeVisible: z.boolean(),
    /** Monthly finalised results add the band bonus to payroll (CEV-02). */
    salaryImpact: z.boolean(),
  })
  .refine((v) => Math.abs(Object.values(v.weights).reduce((a, b) => a + b, 0) - 100) < 0.001, { message: 'Weights must add up to 100' })
  .refine((v) => v.bands.some((b) => b.minScore === 0), { message: 'One band must start at 0' });
export type EvaluationPolicy = z.infer<typeof evaluationPolicySchema>;

export const DEFAULT_EVALUATION_POLICY: EvaluationPolicy = {
  period: 'monthly',
  weights: { attendance: 50, punctuality: 25, early_departure: 10, worked_hours: 15, overtime: 0 },
  overtimeTargetHours: 10,
  countPendingAbsence: false,
  bands: [
    { minScore: 90, nameAr: 'ممتاز', nameEn: 'Excellent', bonusPercent: 0 },
    { minScore: 75, nameAr: 'جيد جداً', nameEn: 'Very good', bonusPercent: 0 },
    { minScore: 60, nameAr: 'مقبول', nameEn: 'Acceptable', bonusPercent: 0 },
    { minScore: 0, nameAr: 'ضعيف', nameEn: 'Weak', bonusPercent: 0 },
  ],
  employeeVisible: true,
  salaryImpact: false,
};

/** "2026-03" (monthly) or "2026-Q1" (quarterly). */
export const evaluationPeriod = z.string().regex(/^\d{4}-(0[1-9]|1[0-2]|Q[1-4])$/);

export const evaluationRunInput = z.object({ companyId: z.uuid(), period: evaluationPeriod });
export const evaluationRecalcInput = evaluationRunInput.extend({ reason: z.string().trim().min(5).max(500) });

export interface EvaluationComponentDto {
  key: EvaluationComponent;
  weight: number;
  /** 0–100 before weighting. */
  score: number;
  detail: string;
}

export interface EvaluationResultDto {
  id: string;
  employeeId: string;
  employeeNo: string;
  employeeName: { ar: string; en: string };
  companyId: string;
  period: string;
  periodStart: string;
  periodEnd: string;
  score: number;
  band: { nameAr: string; nameEn: string; bonusPercent: number };
  components: EvaluationComponentDto[];
  status: 'draft' | 'final';
  calcVersion: number;
  calculatedAt: string;
  finalizedAt: string | null;
}
