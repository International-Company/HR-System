import { z } from 'zod';
import { compensationFields } from './employees.js';

/** Phase 9: recruitment (REC-01..07). Internal only: no public careers page (Q-11 default). */

export const VACANCY_STATUSES = ['draft', 'open', 'on_hold', 'closed', 'filled'] as const;
export type VacancyStatus = (typeof VACANCY_STATUSES)[number];

export const STAGE_OUTCOMES = ['open', 'accepted', 'rejected', 'withdrawn'] as const;
export type StageOutcome = (typeof STAGE_OUTCOMES)[number];

export const OFFER_STATUSES = ['draft', 'pending_approval', 'approved', 'sent', 'accepted', 'declined', 'withdrawn'] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

export const CANDIDATE_SOURCES = ['direct', 'referral', 'agency', 'website', 'other'] as const;

const date = z.iso.date();
const text = (max: number) => z.string().trim().max(max);

/** Candidate statuses are configurable (REC-04); three closing outcomes must exist. */
export const recruitmentStagesSchema = z
  .object({
    stages: z
      .array(
        z.object({
          key: z.string().regex(/^[a-z][a-z0-9_]{1,30}$/),
          nameAr: z.string().trim().min(1).max(60),
          nameEn: z.string().trim().min(1).max(60),
          outcome: z.enum(STAGE_OUTCOMES),
        }),
      )
      .min(4)
      .max(20),
    /** Months to keep data of candidates who were not hired (GDPR storage limitation, C-20). */
    retentionMonths: z.number().int().min(1).max(120),
  })
  .refine((v) => new Set(v.stages.map((s) => s.key)).size === v.stages.length, { message: 'Stage keys must be unique' })
  .refine((v) => v.stages[0]?.outcome === 'open', { message: 'The first stage must be an open stage' })
  .refine((v) => (['accepted', 'rejected', 'withdrawn'] as const).every((o) => v.stages.some((s) => s.outcome === o)), {
    message: 'Accepted, rejected and withdrawn stages are required',
  });
export type RecruitmentStages = z.infer<typeof recruitmentStagesSchema>;

export const DEFAULT_RECRUITMENT_STAGES: RecruitmentStages = {
  stages: [
    { key: 'new', nameAr: 'جديد', nameEn: 'New', outcome: 'open' },
    { key: 'under_review', nameAr: 'قيد المراجعة', nameEn: 'Under review', outcome: 'open' },
    { key: 'interview', nameAr: 'مقابلة', nameEn: 'Interview', outcome: 'open' },
    { key: 'accepted', nameAr: 'مقبول', nameEn: 'Accepted', outcome: 'accepted' },
    { key: 'rejected', nameAr: 'مرفوض', nameEn: 'Rejected', outcome: 'rejected' },
    { key: 'withdrawn', nameAr: 'منسحب', nameEn: 'Withdrawn', outcome: 'withdrawn' },
  ],
  retentionMonths: 12,
};

export const vacancyInput = z.object({
  companyId: z.uuid(),
  departmentId: z.uuid().nullable().optional(),
  jobTitleId: z.uuid().nullable().optional(),
  employmentCategoryId: z.uuid().nullable().optional(),
  contractTypeId: z.uuid().nullable().optional(),
  workLocationId: z.uuid().nullable().optional(),
  title: z.string().trim().min(2).max(200),
  description: text(10_000).default(''),
  openings: z.number().int().min(1).max(500),
  /** Document categories a candidate must provide (REC-07: nothing is hardcoded). */
  requiredDocumentCategoryIds: z.array(z.uuid()).max(20).default([]),
});
export const vacancyUpdateInput = vacancyInput.omit({ companyId: true }).extend({ status: z.enum(VACANCY_STATUSES) });

export const candidateInput = z.object({
  companyId: z.uuid(),
  fullNameAr: z.string().trim().min(1).max(200),
  fullNameEn: z.string().trim().min(1).max(200),
  email: z.email().max(200).nullable().optional(),
  phone: text(40).nullable().optional(),
  nationality: z.string().regex(/^[A-Z]{2}$/, 'ISO 3166 country code').nullable().optional(),
  source: z.enum(CANDIDATE_SOURCES),
  notes: text(4000).default(''),
});
export const candidateUpdateInput = candidateInput.omit({ companyId: true });

export const applicationInput = z.object({ vacancyId: z.uuid(), candidateId: z.uuid() });
export const stageChangeInput = z.object({ stage: z.string().min(2).max(31), note: text(2000).optional() });
export const noteInput = z.object({ note: z.string().trim().min(1).max(4000) });

export const interviewInput = z.object({
  scheduledAt: z.iso.datetime({ offset: true }),
  durationMinutes: z.number().int().min(10).max(480),
  mode: z.enum(['in_person', 'phone', 'video']),
  location: text(300).optional(),
  interviewerUserIds: z.array(z.uuid()).min(1).max(10),
});
export const interviewResultInput = z.object({
  result: z.enum(['pass', 'fail', 'hold']),
  score: z.number().int().min(1).max(5).nullable().optional(),
  feedback: z.string().trim().min(3).max(4000),
});

export const offerInput = compensationFields.pick({ baseSalary: true, currency: true }).extend({
  startDate: date,
  jobTitleId: z.uuid().nullable().optional(),
  notes: text(2000).optional(),
});
export const offerStatusInput = z.object({ status: z.enum(['sent', 'accepted', 'declined', 'withdrawn']), note: text(1000).optional() });

/** REC-06: the employee record is pre-filled from the candidate, vacancy and accepted offer. */
export const convertInput = z.object({
  hireDate: date,
  probationEndDate: date.nullable().optional(),
  departmentId: z.uuid().nullable().optional(),
  managerEmployeeId: z.uuid().nullable().optional(),
  paymentMethod: z.enum(['bank_transfer', 'cash', 'cheque']).default('bank_transfer'),
});

export interface VacancyDto {
  id: string;
  companyId: string;
  departmentId: string | null;
  jobTitleId: string | null;
  employmentCategoryId: string | null;
  contractTypeId: string | null;
  workLocationId: string | null;
  title: string;
  description: string;
  openings: number;
  status: VacancyStatus;
  requiredDocumentCategoryIds: string[];
  applications: number;
  hired: number;
  createdAt: string;
}

export interface CandidateDto {
  id: string;
  companyId: string;
  fullNameAr: string;
  fullNameEn: string;
  email: string | null;
  phone: string | null;
  nationality: string | null;
  source: (typeof CANDIDATE_SOURCES)[number];
  notes: string;
  employeeId: string | null;
  retainUntil: string;
  createdAt: string;
}

export interface ApplicationEventDto {
  id: string;
  kind: 'stage' | 'note' | 'interview' | 'offer' | 'converted';
  stage: string | null;
  text: string | null;
  byName: string | null;
  at: string;
}

export interface InterviewDto {
  id: string;
  scheduledAt: string;
  durationMinutes: number;
  mode: 'in_person' | 'phone' | 'video';
  location: string | null;
  interviewers: { userId: string; name: string }[];
  status: 'scheduled' | 'done' | 'cancelled';
  result: 'pass' | 'fail' | 'hold' | null;
  score: number | null;
  feedback: string | null;
  canRecordResult: boolean;
}

export interface OfferDto {
  id: string;
  status: OfferStatus;
  /** Salary is shown only with the offers permission. */
  baseSalary: number | null;
  currency: string | null;
  startDate: string;
  jobTitleId: string | null;
  notes: string | null;
  workflowInstanceId: string | null;
  createdAt: string;
}

export interface ApplicationDto {
  id: string;
  vacancyId: string;
  vacancyTitle: string;
  companyId: string;
  candidate: CandidateDto;
  stage: string;
  outcome: StageOutcome;
  employeeId: string | null;
  missingDocumentCategoryIds: string[];
  documents: { id: string; title: string; categoryId: string; mime: string; sizeBytes: number; createdAt: string }[];
  events: ApplicationEventDto[];
  interviews: InterviewDto[];
  offers: OfferDto[];
  createdAt: string;
}

export interface ApplicationSummaryDto {
  id: string;
  vacancyId: string;
  candidateId: string;
  candidateName: { ar: string; en: string };
  stage: string;
  outcome: StageOutcome;
  employeeId: string | null;
  updatedAt: string;
}
