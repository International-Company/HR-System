import { z } from 'zod';

/** Phase 4: attendance (ATT-01..17). */

export const PUNCH_KINDS = ['in', 'out', 'break_start', 'break_end'] as const;
export type PunchKind = (typeof PUNCH_KINDS)[number];

export const DAY_STATUSES = [
  'present',
  'incomplete',
  'absent_pending',
  'absent_confirmed',
  'excused',
  'not_required',
  'upcoming',
] as const;
export type DayStatus = (typeof DAY_STATUSES)[number];
export type DayClass = 'workday' | 'rest' | 'holiday' | 'unscheduled' | 'not_employed';

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM');

export const punchInput = z.object({
  kind: z.enum(PUNCH_KINDS),
  idempotencyKey: z.string().min(8).max(64),
  /** WebAuthn assertion (AuthenticationResponseJSON) when the policy requires biometrics. */
  assertion: z.record(z.string(), z.unknown()).optional(),
  /** Device-bound PIN: the device token issued at registration plus the 4-digit PIN. */
  deviceToken: z.string().min(20).max(200).optional(),
  pin: z
    .string()
    .regex(/^\d{4}$/)
    .optional(),
});

export const networkRangeInput = z.object({
  companyId: z.uuid(),
  workLocationId: z.uuid().nullable().optional(),
  cidr: z.string().trim().min(3).max(64),
  label: z.string().trim().min(1).max(120),
});

export const devicePinInput = z.object({
  label: z.string().trim().min(1).max(80),
  pin: z.string().regex(/^\d{4}$/),
});

export const deviceWebauthnVerifyInput = z.object({
  label: z.string().trim().min(1).max(80),
  response: z.record(z.string(), z.unknown()),
});

export const correctionInput = z.object({
  employeeId: z.uuid().optional(),
  workDate: z.iso.date(),
  add: z.array(z.object({ kind: z.enum(PUNCH_KINDS), time })).max(8).default([]),
  voidPunchIds: z.array(z.uuid()).max(8).default([]),
  reason: z.string().trim().min(3).max(1000),
});

export const reviewInput = z.object({
  action: z.enum(['confirm_absence', 'excuse', 'reopen']),
  note: z.string().trim().min(1).max(500),
});

export interface PunchDto {
  id: string;
  kind: PunchKind;
  at: string;
  localTime: string;
  source: 'pwa' | 'correction';
  method: 'session' | 'webauthn' | 'pin' | 'correction';
  ip: string | null;
  deviceLabel: string | null;
  voided: boolean;
}

export interface AttendanceDayDto {
  employeeId: string;
  workDate: string;
  dayClass: DayClass;
  status: DayStatus;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  firstIn: string | null;
  lastOut: string | null;
  workedMinutes: number;
  breakMinutes: number;
  lateMinutes: number;
  earlyMinutes: number;
  overtimeMinutes: number;
  holidayWorkMinutes: number;
  closure: 'normal' | 'administrative' | 'open' | 'none';
  flags: string[];
  reviewNote: string | null;
  punches: PunchDto[];
}

export interface TodayDto {
  employeeId: string | null;
  workDate: string;
  state: 'out' | 'in' | 'on_break';
  allowedKinds: PunchKind[];
  network: { ip: string | null; allowed: boolean; configured: boolean };
  verification: 'none' | 'webauthn' | 'pin' | 'webauthn_or_pin';
  hasWebauthnDevice: boolean;
  hasPinDevice: boolean;
  day: AttendanceDayDto | null;
  moduleAccess: 'enabled' | 'read_only' | 'hidden';
}

export interface NetworkRangeDto {
  id: string;
  companyId: string;
  workLocationId: string | null;
  cidr: string;
  label: string;
  status: 'active' | 'inactive';
}

export interface AttendanceDeviceDto {
  id: string;
  userId: string;
  userName: string | null;
  employeeId: string | null;
  label: string;
  kind: 'webauthn' | 'pin';
  status: 'pending' | 'approved' | 'revoked';
  createdAt: string;
  lastUsedAt: string | null;
}

export interface CorrectionDto {
  id: string;
  employeeId: string;
  workDate: string;
  add: { kind: PunchKind; time: string }[];
  voidPunchIds: string[];
  reason: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  direct: boolean;
  createdAt: string;
}
