import { z } from 'zod';
import { assignmentFields, compensationFields } from './employees.js';

/** Phase 8: separation and rehire (TRM-01..08). No clearance/custody module (TRM-08). */

export const SEPARATION_TYPES = ['resignation', 'termination', 'contract_end', 'retirement', 'other'] as const;
export type SeparationType = (typeof SEPARATION_TYPES)[number];

export const SEPARATION_STATUSES = ['pending', 'approved', 'rejected', 'cancelled', 'completed'] as const;
export type SeparationStatus = (typeof SEPARATION_STATUSES)[number];

const date = z.iso.date();

/** Company-overridable exit rules (TRM-05, C-17). */
export const separationPolicySchema = z.object({
  /** Employees may submit their own resignation. */
  selfResignation: z.boolean(),
  /** Notice an employee must give when resigning (staff may set any date). */
  resignationNoticeDays: z.number().int().min(0).max(365),
  /** After the last working day: disable the account, or keep it for own payslips/documents only (Q-27). */
  accountOnExit: z.enum(['disable', 'self_service_only']),
  revokeDevices: z.boolean(),
  /** Approved or pending leave after the last working day is cancelled. */
  cancelFutureLeave: z.boolean(),
  /** An active contract is ended on the last working day. */
  endContract: z.boolean(),
  /** Calculate the end-of-service settlement on approval (PAY-11, TRM-03). */
  settlement: z.boolean(),
});
export type SeparationPolicy = z.infer<typeof separationPolicySchema>;

export const separationInput = z.object({
  /** Omitted = myself (resignation). */
  employeeId: z.uuid().optional(),
  type: z.enum(SEPARATION_TYPES),
  lastWorkingDay: date,
  reason: z.string().trim().min(3).max(2000),
  rehireEligible: z.boolean().default(true),
});

export const separationCancelInput = z.object({ reason: z.string().trim().min(3).max(500) });

export const rehireInput = z.object({
  effectiveDate: date,
  probationEndDate: date.nullable().optional(),
  assignment: assignmentFields,
  compensation: compensationFields.optional(),
  reason: z.string().trim().min(3).max(1000),
  /** Required when the previous separation marked the person as not eligible for rehire. */
  overrideIneligible: z.boolean().default(false),
});

export interface SeparationDto {
  id: string;
  employeeId: string;
  employeeNo: string;
  employeeName: { ar: string; en: string };
  companyId: string;
  type: SeparationType;
  status: SeparationStatus;
  lastWorkingDay: string;
  reason: string;
  rehireEligible: boolean;
  settlement: { amount: number; currency: string; serviceYears: number; explanation: string[] } | null;
  workflowInstanceId: string | null;
  initiatedBySelf: boolean;
  createdAt: string;
  decidedAt: string | null;
  completedAt: string | null;
  cancelReason: string | null;
}
