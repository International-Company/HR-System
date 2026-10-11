import { z } from 'zod';
import type { PermissionKey } from './permissions.js';

/**
 * Typed settings (D-10, SET-01, SET-02). Each setting has a schema, a default,
 * whether companies may override it, and the permission needed to change it.
 */

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const languageSchema = z.enum(['ar', 'en']);
const timezoneSchema = z.string().min(1).max(64).refine(isValidTimeZone, 'Invalid time zone');
const dateFormatSchema = z.enum(['DD/MM/YYYY', 'YYYY-MM-DD', 'MM/DD/YYYY']);
const timeFormatSchema = z.enum(['24h', '12h']);
const numeralsSchema = z.enum(['latn', 'arab']);
const currencySchema = z.string().regex(/^[A-Z]{3}$/, 'ISO 4217 code expected');

const passwordPolicySchema = z.object({
  minLength: z.number().int().min(8).max(128),
});
const lockoutSchema = z.object({
  maxFailures: z.number().int().min(3).max(20),
  lockMinutes: z.number().int().min(1).max(1440),
});
const sessionSchema = z.object({
  idleMinutes: z.number().int().min(5).max(480),
  absoluteHours: z.number().int().min(1).max(72),
});
const mfaSchema = z.object({
  requiredForRoles: z.array(z.string().min(1).max(64)).max(100),
});
// Retention of off-site backups is enforced by the bucket's lifecycle/object-lock rules,
// because the application's backup credentials deliberately cannot delete (DL-010).
const backupSchema = z.object({
  enabled: z.boolean(),
  dailyAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
});

// Employee numbers are group-wide and never contain mutable attributes such as the company
// (C-01). Changing the format only affects numbers created afterwards.
const employeeNumberSchema = z.object({
  prefix: z
    .string()
    .max(10)
    .regex(/^[A-Za-z0-9-]*$/),
  padding: z.number().int().min(1).max(10),
});
const restoreSchema = z.object({
  /** When true and another active System Administrator exists, a second one must approve. */
  requireSecondApprover: z.boolean(),
});
/** In-day permissions (LEV-05). Company-overridable. */
const leavePermissionsSchema = z.object({
  enabled: z.boolean(),
  /** Input granularity: whole hours, minutes, or both. */
  unit: z.enum(['hours', 'minutes', 'both']),
  maxMinutesPerDay: z.number().int().min(15).max(720),
  /** 0 = no monthly limit. */
  maxMinutesPerMonth: z.number().int().min(0).max(10_000),
  /** How many days back an employee may still ask (staff may record later). */
  retroactiveDays: z.number().int().min(0).max(60),
});
/** Attendance rules (ATT-10, ATT-11, ATT-12, ATT-16). Company-overridable. */
const attendancePolicySchema = z.object({
  /** Punching only from the company's authorised networks (ATT-01). */
  requireNetwork: z.boolean(),
  /** Extra proof at punch time: device biometrics (WebAuthn) and/or a device-bound PIN. */
  verification: z.enum(['none', 'webauthn', 'pin', 'webauthn_or_pin']),
  /** Devices must be approved by HR/timekeeping before they can be used. */
  deviceApproval: z.boolean(),
  /** Administrative check-out at scheduled end when the employee forgot (C-02: never overtime). */
  autoCheckout: z.boolean(),
  /** Overtime after the scheduled end counts only from this many minutes on (0 = every minute). */
  overtimeMinMinutes: z.number().int().min(0).max(240),
  /** Arriving before the scheduled start: ignored, or counted as overtime. */
  earlyArrival: z.enum(['ignore', 'overtime']),
  /** Work on a rest/unscheduled day: recorded and flagged, or counted as overtime. */
  restDayWork: z.enum(['flag', 'overtime']),
  /** Employees may request corrections up to this many days back. */
  correctionWindowDays: z.number().int().min(0).max(365),
});
const documentLimitsSchema = z.object({
  maxUploadMb: z.number().int().min(1).max(50),
});

export const SETTINGS = {
  'employee.numberFormat': {
    schema: employeeNumberSchema,
    default: { prefix: 'EMP-', padding: 6 },
    companyOverride: false,
    permission: 'settings.manage.general',
    public: false,
  },
  'attendance.policy': {
    schema: attendancePolicySchema,
    default: {
      requireNetwork: true,
      verification: 'none' as const,
      deviceApproval: false,
      autoCheckout: false,
      overtimeMinMinutes: 15,
      earlyArrival: 'ignore' as const,
      restDayWork: 'flag' as const,
      correctionWindowDays: 30,
    },
    companyOverride: true,
    permission: 'attendance.policy.manage',
    public: false,
  },
  'leave.permissions': {
    schema: leavePermissionsSchema,
    default: { enabled: true, unit: 'both' as const, maxMinutesPerDay: 240, maxMinutesPerMonth: 480, retroactiveDays: 7 },
    companyOverride: true,
    permission: 'leave.types.manage',
    public: false,
  },
  'documents.limits': {
    schema: documentLimitsSchema,
    default: { maxUploadMb: 20 },
    companyOverride: false,
    permission: 'settings.manage.general',
    public: false,
  },
  'general.language': {
    schema: languageSchema,
    default: 'ar' as z.infer<typeof languageSchema>,
    companyOverride: false,
    permission: 'settings.manage.general',
    public: true,
  },
  'general.timezone': {
    schema: timezoneSchema,
    default: 'UTC',
    companyOverride: false,
    permission: 'settings.manage.general',
    public: true,
  },
  'general.dateFormat': {
    schema: dateFormatSchema,
    default: 'DD/MM/YYYY' as z.infer<typeof dateFormatSchema>,
    companyOverride: false,
    permission: 'settings.manage.general',
    public: true,
  },
  'general.timeFormat': {
    schema: timeFormatSchema,
    default: '24h' as z.infer<typeof timeFormatSchema>,
    companyOverride: false,
    permission: 'settings.manage.general',
    public: true,
  },
  'general.numerals': {
    schema: numeralsSchema,
    default: 'latn' as z.infer<typeof numeralsSchema>,
    companyOverride: false,
    permission: 'settings.manage.general',
    public: true,
  },
  'general.defaultCurrency': {
    schema: currencySchema,
    default: 'EUR',
    companyOverride: true,
    permission: 'settings.manage.general',
    public: false,
  },
  'security.passwordPolicy': {
    schema: passwordPolicySchema,
    default: { minLength: 12 },
    companyOverride: false,
    permission: 'settings.manage.security',
    public: false,
  },
  'security.lockout': {
    schema: lockoutSchema,
    default: { maxFailures: 5, lockMinutes: 15 },
    companyOverride: false,
    permission: 'settings.manage.security',
    public: false,
  },
  'security.session': {
    schema: sessionSchema,
    default: { idleMinutes: 30, absoluteHours: 12 },
    companyOverride: false,
    permission: 'settings.manage.security',
    public: false,
  },
  'security.mfa': {
    schema: mfaSchema,
    default: { requiredForRoles: ['system_admin', 'hr', 'finance', 'senior_management'] },
    companyOverride: false,
    permission: 'settings.manage.security',
    public: false,
  },
  'backup.restore': {
    schema: restoreSchema,
    default: { requireSecondApprover: true },
    companyOverride: false,
    permission: 'settings.manage.backup',
    public: false,
  },
  'backup.policy': {
    schema: backupSchema,
    default: { enabled: true, dailyAt: '02:00' },
    companyOverride: false,
    permission: 'settings.manage.backup',
    public: false,
  },
} as const satisfies Record<
  string,
  {
    schema: z.ZodType;
    default: unknown;
    companyOverride: boolean;
    permission: PermissionKey;
    public: boolean;
  }
>;

export type SettingKey = keyof typeof SETTINGS;
export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTINGS)[K]['schema']>;
export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];

export function isSettingKey(key: string): key is SettingKey {
  return Object.prototype.hasOwnProperty.call(SETTINGS, key);
}
