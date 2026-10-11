import { z } from 'zod';

/** Phase 7: payroll (PAY-01..11). Predefined calculation methods with parameters (D-10). */

export const RUN_STATUSES = ['draft', 'submitted', 'approved', 'superseded'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const ITEM_SOURCES = ['base', 'recurring', 'attendance', 'leave', 'manual'] as const;
export type ItemSource = (typeof ITEM_SOURCES)[number];

export const PAYMENT_STATUSES = ['pending', 'paid', 'failed', 'cancelled'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** Company payroll rules (PAY-08). Company-overridable. */
export const payrollPolicySchema = z.object({
  /** Day rate = monthly amount ÷ (30 | calendar days of the month | scheduled workdays of the month). */
  dayRateBasis: z.enum(['fixed_30', 'calendar_days', 'working_days']),
  hoursPerDay: z.number().min(1).max(24),
  /** Overtime after the scheduled end (ATT-12): paid as hourly rate × multiplier (0 = not paid). */
  overtimeMultiplier: z.number().min(0).max(5),
  /** Work on official holidays (ATT-17). */
  holidayWorkMultiplier: z.number().min(0).max(5),
  /** Lateness deduction: none, or per minute after a monthly tolerance. */
  latenessDeduction: z.enum(['none', 'per_minute']),
  latenessToleranceMinutes: z.number().int().min(0).max(10_000),
  /** Absence deduction: confirmed absences only, or also unreviewed possible absences. */
  absenceDeduction: z.enum(['none', 'confirmed', 'confirmed_and_pending']),
  /** Unpaid leave types deduct a day rate per leave day. */
  unpaidLeaveDeduction: z.boolean(),
  /** Day of the month on which salaries are due (shown on payslips). */
  payDay: z.number().int().min(1).max(31),
  /** Payslips are visible to employees once the run is approved. */
  notifyEmployees: z.boolean(),
});
export type PayrollPolicy = z.infer<typeof payrollPolicySchema>;

/** End-of-service settlement (PAY-11): predefined methods; country rules are not assumed (Q-01). */
export const endOfServiceSchema = z.object({
  method: z.enum(['none', 'days_per_year', 'months_per_year']),
  /** days_per_year: days of the last monthly base per year of service, by service bands. */
  bands: z
    .array(z.object({ fromYears: z.number().min(0).max(60), daysPerYear: z.number().min(0).max(365) }))
    .max(5)
    .default([]),
  /** months_per_year: months of base per year of service. */
  monthsPerYear: z.number().min(0).max(12).default(0),
  /** Minimum service (years) before anything is due. */
  minYears: z.number().min(0).max(10).default(0),
  /** Cap in months of base (null = no cap). */
  capMonths: z.number().min(0).max(120).nullable().default(null),
});
export type EndOfServicePolicy = z.infer<typeof endOfServiceSchema>;

export const runCreateInput = z.object({
  companyId: z.uuid(),
  /** YYYY-MM; the period is the calendar month. */
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
});

export const manualItemInput = z.object({
  kind: z.enum(['earning', 'deduction']),
  label: z.string().trim().min(2).max(120),
  amount: z.number().positive().max(1e9),
  note: z.string().trim().max(500).optional(),
});

export const fxRatesInput = z.object({
  /** Display currency of the group summary and rates to it, e.g. { "EUR": 1, "USD": 0.92 }. */
  rates: z.record(z.string().regex(/^[A-Z]{3}$/), z.number().positive().max(1e6)),
});

export const reopenInput = z.object({ reason: z.string().trim().min(5).max(500) });

export const paymentInput = z.object({
  status: z.enum(PAYMENT_STATUSES),
  method: z.enum(['bank_transfer', 'cash', 'cheque']),
  reference: z.string().trim().max(120).optional(),
  paidOn: z.iso.date().optional(),
  amount: z.number().positive().max(1e9),
  note: z.string().trim().max(500).optional(),
});

export const eosQuery = z.object({ endDate: z.iso.date() });

export interface PayItemDto {
  id: string;
  kind: 'earning' | 'deduction';
  source: ItemSource;
  code: string;
  label: string;
  quantity: number | null;
  rate: number | null;
  amount: number;
  /** How the amount was obtained, e.g. "8.5 h × 15.00 × 1.25". */
  explanation: string;
}

export interface PayLineDto {
  id: string;
  employeeId: string;
  employeeNo: string;
  employeeName: { ar: string; en: string };
  currency: string;
  daysPaid: number;
  periodDays: number;
  gross: number;
  deductions: number;
  net: number;
  items: PayItemDto[];
  payments: PaymentDto[];
  warnings: string[];
}

export interface PaymentDto {
  id: string;
  status: PaymentStatus;
  method: string;
  reference: string | null;
  paidOn: string | null;
  amount: number;
  currency: string;
  note: string | null;
  createdAt: string;
}

export interface PayRunDto {
  id: string;
  companyId: string;
  period: string;
  periodStart: string;
  periodEnd: string;
  revision: number;
  revisionOfId: string | null;
  status: RunStatus;
  lockedAt: string | null;
  reopenReason: string | null;
  workflowInstanceId: string | null;
  fxRates: Record<string, number>;
  /** Totals per currency (C-04). */
  totals: { currency: string; gross: number; deductions: number; net: number; employees: number }[];
  createdAt: string;
  calculatedAt: string | null;
}

export interface PayRunDetailDto extends PayRunDto {
  lines: PayLineDto[];
}

export interface PayslipDto {
  runId: string;
  lineId: string;
  companyId: string;
  companyName: { ar: string; en: string };
  period: string;
  payDay: string;
  employeeNo: string;
  employeeName: { ar: string; en: string };
  currency: string;
  daysPaid: number;
  gross: number;
  deductions: number;
  net: number;
  items: PayItemDto[];
  paymentStatus: PaymentStatus | null;
}

export interface GroupSummaryDto {
  period: string;
  companies: { companyId: string; runId: string | null; status: RunStatus | null; totals: PayRunDto['totals'] }[];
  /** Per-currency group totals, plus a converted total when rates were given (Q-13). */
  totals: { currency: string; gross: number; deductions: number; net: number; employees: number }[];
  converted: { currency: string; net: number; missingRates: string[] } | null;
}

export interface EndOfServiceDto {
  employeeId: string;
  endDate: string;
  serviceYears: number;
  monthlyBase: number;
  currency: string;
  amount: number;
  explanation: string[];
}
