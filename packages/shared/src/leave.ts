import { z } from 'zod';

/** Phase 5: leave and in-day permissions (LEV-01..08). */

export const LEAVE_ACCRUALS = ['yearly', 'monthly', 'none'] as const;
export type LeaveAccrual = (typeof LEAVE_ACCRUALS)[number];

export const LEDGER_KINDS = ['opening', 'accrual', 'usage', 'refund', 'adjustment', 'carryover_expiry', 'expiry'] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];

export const LEAVE_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;
export type LeaveStatus = (typeof LEAVE_STATUSES)[number];

const date = z.iso.date();
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM');
const days = z.number().min(0).max(366);

/**
 * Rules of a leave type (LEV-01, LEV-02, LEV-06, LEV-08). Full days only (LEV-04).
 * The leave year is the calendar year (Gregorian, DL-029).
 */
export const leaveRulesSchema = z.object({
  /** Days per leave year. */
  entitlementDays: days,
  /** Higher entitlement by completed years of service; the highest matching tier wins. */
  serviceTiers: z.array(z.object({ fromYears: z.number().int().min(1).max(60), days })).max(10).default([]),
  /** yearly = granted on 1 January (pro-rata in the hiring year); monthly = 1/12 each month; none = no balance. */
  accrual: z.enum(LEAVE_ACCRUALS),
  /** Count only scheduled workdays (rest days and holidays inside the leave are free) or every calendar day. */
  countDays: z.enum(['workdays', 'calendar']),
  /** When the balance is reduced: on approval, or already on submission (refunded on rejection). */
  deductWhen: z.enum(['approval', 'submission']),
  /** How far the balance may go below zero (0 = never). */
  allowNegativeDays: days,
  /** For types without a balance: maximum days per leave year (null = no limit). */
  maxDaysPerYear: days.nullable(),
  maxDaysPerRequest: days.nullable(),
  /** Days of notice an employee must give (staff may record later). */
  minNoticeDays: z.number().int().min(0).max(365),
  /** How many days in the past an employee may still request (LEV-06 retroactive). */
  retroactiveDays: z.number().int().min(0).max(365),
  /** Unused balance carried into the next year (null = everything, 0 = nothing). */
  carryoverMaxDays: days.nullable(),
  /** Carried days lapse after this many months of the new year when unused (null = never). */
  carryoverExpiryMonths: z.number().int().min(1).max(12).nullable(),
  attachment: z.enum(['none', 'optional', 'required']),
  /** Document category for attachments, e.g. the medical category (C-12). */
  attachmentCategoryId: z.uuid().nullable(),
  /** Empty = all employees. */
  eligibleContractTypeIds: z.array(z.uuid()).max(50).default([]),
  eligibleCategoryIds: z.array(z.uuid()).max(50).default([]),
});
export type LeaveRules = z.infer<typeof leaveRulesSchema>;

export const DEFAULT_LEAVE_RULES: LeaveRules = {
  entitlementDays: 21,
  serviceTiers: [],
  accrual: 'yearly',
  countDays: 'workdays',
  deductWhen: 'approval',
  allowNegativeDays: 0,
  maxDaysPerYear: null,
  maxDaysPerRequest: null,
  minNoticeDays: 0,
  retroactiveDays: 7,
  carryoverMaxDays: null,
  carryoverExpiryMonths: null,
  attachment: 'none',
  attachmentCategoryId: null,
  eligibleContractTypeIds: [],
  eligibleCategoryIds: [],
};

export const leaveTypeInput = z.object({
  /** null = group-wide; a company type with the same code replaces the group type for that company. */
  companyId: z.uuid().nullable(),
  code: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{2,30}$/),
  nameAr: z.string().trim().min(1).max(120),
  nameEn: z.string().trim().min(1).max(120),
  paid: z.boolean(),
  rules: leaveRulesSchema,
});

export const leaveTypeUpdateInput = leaveTypeInput.omit({ companyId: true, code: true }).extend({
  status: z.enum(['active', 'inactive']),
});

export const leaveRequestInput = z.object({
  /** Staff may record a request for an employee; omitted = myself. */
  employeeId: z.uuid().optional(),
  leaveTypeId: z.uuid(),
  startDate: date,
  endDate: date,
  reason: z.string().trim().max(1000).optional(),
});

export const leaveCancelInput = z.object({ reason: z.string().trim().min(3).max(500) });

export const balanceAdjustInput = z.object({
  employeeId: z.uuid(),
  leaveTypeId: z.uuid(),
  kind: z.enum(['opening', 'adjustment']),
  /** Positive adds days, negative removes days. */
  amount: z.number().min(-366).max(366).refine((n) => n !== 0, 'Must not be zero'),
  effectiveDate: date,
  note: z.string().trim().min(3).max(500),
});

export const permissionRequestInput = z.object({
  employeeId: z.uuid().optional(),
  date,
  startTime: time,
  endTime: time,
  reason: z.string().trim().min(3).max(500),
});

export interface LeaveTypeDto {
  id: string;
  companyId: string | null;
  code: string;
  nameAr: string;
  nameEn: string;
  paid: boolean;
  status: 'active' | 'inactive';
  rules: LeaveRules;
}

export interface LeaveBalanceDto {
  leaveTypeId: string;
  code: string;
  nameAr: string;
  nameEn: string;
  /** false for types without a balance (accrual none). */
  tracked: boolean;
  /** Sum of the ledger up to today. */
  balance: number;
  /** Days in pending requests not yet deducted. */
  pending: number;
  available: number;
  /** Days taken this year (approved, including upcoming). */
  usedThisYear: number;
  maxDaysPerYear: number | null;
}

export interface LedgerEntryDto {
  id: string;
  leaveTypeId: string;
  effectiveDate: string;
  kind: LedgerKind;
  amount: number;
  note: string | null;
  sourceId: string | null;
  createdAt: string;
}

export interface LeaveRequestDto {
  id: string;
  employeeId: string;
  employeeName: { ar: string; en: string };
  companyId: string;
  leaveTypeId: string;
  leaveTypeName: { ar: string; en: string };
  startDate: string;
  endDate: string;
  days: number;
  reason: string | null;
  status: LeaveStatus;
  /** Attachment id, only when the viewer may open it (C-12: managers see the decision only). */
  attachmentId: string | null;
  hasAttachment: boolean;
  workflowInstanceId: string | null;
  createdAt: string;
  decidedAt: string | null;
  cancelReason: string | null;
}

export interface PermissionRequestDto {
  id: string;
  employeeId: string;
  employeeName: { ar: string; en: string };
  companyId: string;
  date: string;
  startTime: string;
  endTime: string;
  minutes: number;
  reason: string;
  status: LeaveStatus;
  workflowInstanceId: string | null;
  createdAt: string;
}
