import { z } from 'zod';

/** Phase 3: workflow engine, notifications, work schedules, holidays, in-app restore. */

// --- Workflow ------------------------------------------------------------------------

export const APPROVER_RULES = ['direct_manager', 'role_in_company', 'specific_user'] as const;
export type ApproverRule = (typeof APPROVER_RULES)[number];
export const INSTANCE_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;
export const TASK_STATUSES = ['pending', 'approved', 'rejected', 'skipped', 'cancelled'] as const;

export const workflowStepInput = z.object({
  approverRule: z.enum(APPROVER_RULES),
  roleKey: z.string().min(1).max(64).nullable().optional(),
  userId: z.uuid().nullable().optional(),
  skipIfUnresolved: z.boolean().default(true),
  nameAr: z.string().trim().min(1).max(100),
  nameEn: z.string().trim().min(1).max(100),
});

export const workflowStepsInput = z.object({
  steps: z.array(workflowStepInput).min(1).max(10),
  version: z.number().int().positive(),
});

export const taskDecisionInput = z.object({
  decision: z.enum(['approve', 'reject']),
  comment: z.string().trim().max(1000).optional(),
});

export const delegationInput = z.object({
  toUserId: z.uuid(),
  validFrom: z.iso.date(),
  validTo: z.iso.date(),
});

export interface WorkflowStepDto {
  seq: number;
  approverRule: ApproverRule;
  roleKey: string | null;
  userId: string | null;
  skipIfUnresolved: boolean;
  nameAr: string;
  nameEn: string;
}

export interface WorkflowDefinitionDto {
  id: string;
  key: string;
  subjectType: string;
  nameAr: string;
  nameEn: string;
  locked: boolean;
  steps: WorkflowStepDto[];
  version: number;
}

export interface WorkflowTaskDto {
  id: string;
  instanceId: string;
  seq: number;
  stepNameAr: string;
  stepNameEn: string;
  status: (typeof TASK_STATUSES)[number];
  assigneeUserId: string | null;
  assigneeName: string | null;
  delegatedFromUserId: string | null;
  decidedAt: string | null;
  comment: string | null;
  createdAt: string;
}

export interface WorkflowInstanceDto {
  id: string;
  definitionKey: string;
  definitionNameAr: string;
  definitionNameEn: string;
  companyId: string;
  subjectType: string;
  subjectId: string;
  subjectEmployeeId: string | null;
  subjectEmployeeName: { ar: string; en: string } | null;
  summary: Record<string, unknown>;
  requesterUserId: string;
  requesterName: string;
  status: (typeof INSTANCE_STATUSES)[number];
  currentSeq: number;
  createdAt: string;
  completedAt: string | null;
  tasks: WorkflowTaskDto[];
}

export interface DelegationDto {
  id: string;
  fromUserId: string;
  toUserId: string;
  toUserName: string;
  validFrom: string;
  validTo: string;
  revokedAt: string | null;
}

// --- Notifications ---------------------------------------------------------------------

export interface NotificationDto {
  id: string;
  eventType: string;
  title: { ar: string; en: string };
  body: { ar: string; en: string };
  link: string | null;
  createdAt: string;
  readAt: string | null;
}

export const pushSubscriptionInput = z.object({
  endpoint: z.url().max(1000),
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
});

// --- Work schedules & holidays -------------------------------------------------------------

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM');

export const scheduleDayInput = z.object({
  isoWeekday: z.number().int().min(1).max(7),
  isWorkday: z.boolean(),
  startTime: time.nullable().optional(),
  endTime: time.nullable().optional(),
  breaks: z
    .array(z.object({ startTime: time, endTime: time, paid: z.boolean().default(false) }))
    .max(5)
    .default([]),
});

export const scheduleInput = z.object({
  companyId: z.uuid().nullable().optional(),
  code: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .regex(/^[A-Za-z0-9_-]+$/),
  nameAr: z.string().trim().min(1).max(200),
  nameEn: z.string().trim().min(1).max(200),
  graceInMinutes: z.number().int().min(0).max(240),
  graceOutMinutes: z.number().int().min(0).max(240),
  days: z.array(scheduleDayInput).length(7),
});

export const scheduleUpdateInput = scheduleInput.omit({ code: true, companyId: true }).extend({
  status: z.enum(['active', 'inactive']).optional(),
  version: z.number().int().positive(),
});

export const scheduleAssignmentInput = z.object({
  scheduleId: z.uuid(),
  targetType: z.enum(['company', 'department', 'employee']),
  companyId: z.uuid(),
  departmentId: z.uuid().nullable().optional(),
  employeeId: z.uuid().nullable().optional(),
  validFrom: z.iso.date(),
  validTo: z.iso.date().nullable().optional(),
});

export const holidayInput = z.object({
  companyId: z.uuid().nullable().optional(),
  date: z.iso.date(),
  nameAr: z.string().trim().min(1).max(200),
  nameEn: z.string().trim().min(1).max(200),
});

export interface ScheduleDayDto {
  isoWeekday: number;
  isWorkday: boolean;
  startTime: string | null;
  endTime: string | null;
  breaks: { startTime: string; endTime: string; paid: boolean }[];
}

export interface ScheduleDto {
  id: string;
  companyId: string | null;
  code: string;
  nameAr: string;
  nameEn: string;
  graceInMinutes: number;
  graceOutMinutes: number;
  status: 'active' | 'inactive';
  days: ScheduleDayDto[];
  version: number;
}

export interface ScheduleAssignmentDto {
  id: string;
  scheduleId: string;
  targetType: 'company' | 'department' | 'employee';
  companyId: string;
  departmentId: string | null;
  employeeId: string | null;
  validFrom: string;
  validTo: string | null;
}

export interface HolidayDto {
  id: string;
  companyId: string | null;
  date: string;
  nameAr: string;
  nameEn: string;
}

/** What applies to one employee on one date (input for attendance and leave). */
export interface WorkdayDto {
  date: string;
  scheduleId: string | null;
  isWorkday: boolean;
  holiday: { id: string; nameAr: string; nameEn: string } | null;
  startTime: string | null;
  endTime: string | null;
  breaks: { startTime: string; endTime: string; paid: boolean }[];
  graceInMinutes: number;
  graceOutMinutes: number;
}

// --- In-app restore (BKP-06) ----------------------------------------------------------------

export const RESTORE_STATUSES = [
  'awaiting_approval',
  'requested',
  'preparing',
  'ready',
  'switching',
  'completed',
  'failed',
  'cancelled',
] as const;
export type RestoreStatus = (typeof RESTORE_STATUSES)[number];

export const restoreRequestInput = z.object({
  backupRunId: z.uuid(),
  password: z.string().min(1).max(256),
  code: z.string().trim().regex(/^\d{6}$/),
  confirmation: z.string().trim().min(1).max(200),
});

export const restoreStepUpInput = z.object({
  password: z.string().min(1).max(256),
  code: z.string().trim().regex(/^\d{6}$/),
});

export interface RestorePreviewDto {
  backupRunId: string;
  backupAt: string;
  schemaVersion: string | null;
  currentSchemaVersion: string | null;
  compatible: boolean;
  changesSince: { module: string; count: number }[];
  warnings: string[];
  confirmationPhrase: string;
  secondApproverRequired: boolean;
}

export interface RestoreRequestDto {
  id: string;
  backupRunId: string;
  backupAt: string | null;
  status: RestoreStatus;
  requestedBy: string;
  requestedByName: string | null;
  approvedBy: string | null;
  createdAt: string;
  updatedAt: string;
  error: string | null;
  details: Record<string, unknown>;
}
