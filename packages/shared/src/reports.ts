import { z } from 'zod';
import type { PermissionKey } from './permissions.js';

/**
 * Phase 11: reports on curated datasets (RPT-01..05, C-10). Each field has a sensitivity;
 * fields the user may not see are not offered and are stripped on the server.
 */

export type FieldType = 'text' | 'number' | 'date' | 'money' | 'percent';
/** normal = the dataset permission is enough; financial/identity need that permission too. */
export type FieldSensitivity = 'normal' | 'financial' | 'identity';

export interface ReportField {
  key: string;
  ar: string;
  en: string;
  type: FieldType;
  sensitivity: FieldSensitivity;
}

export type FilterKind = 'company' | 'department' | 'dateRange' | 'month' | 'status' | 'withinDays';

export interface DatasetDef {
  key: string;
  ar: string;
  en: string;
  /** Needed (company or department scope) to run the dataset. */
  permission: PermissionKey;
  filters: FilterKind[];
  /** Allowed values of the status filter. */
  statuses?: string[];
  fields: ReportField[];
}

const f = (key: string, en: string, ar: string, type: FieldType = 'text', sensitivity: FieldSensitivity = 'normal'): ReportField => ({ key, en, ar, type, sensitivity });
const person = [f('employeeNo', 'Employee no.', 'الرقم الوظيفي'), f('nameAr', 'Name (Arabic)', 'الاسم (عربي)'), f('nameEn', 'Name (English)', 'الاسم (إنجليزي)'), f('company', 'Company', 'الشركة'), f('department', 'Department', 'القسم')];

export const DATASETS: DatasetDef[] = [
  {
    key: 'employees',
    en: 'Employees',
    ar: 'الموظفون',
    permission: 'employee.profile.view',
    filters: ['company', 'department', 'status'],
    statuses: ['probation', 'active', 'suspended', 'long_leave', 'terminated'],
    fields: [
      ...person,
      f('jobTitle', 'Job title', 'المسمى الوظيفي'),
      f('status', 'Status', 'الحالة'),
      f('hireDate', 'Hire date', 'تاريخ التعيين', 'date'),
      f('nationality', 'Nationality', 'الجنسية'),
      f('gender', 'Gender', 'الجنس'),
      f('email', 'E-mail', 'البريد الإلكتروني'),
      f('phone', 'Phone', 'الهاتف'),
      f('birthDate', 'Birth date', 'تاريخ الميلاد', 'date', 'identity'),
      f('baseSalary', 'Base salary', 'الراتب الأساسي', 'money', 'financial'),
      f('currency', 'Currency', 'العملة', 'text', 'financial'),
    ],
  },
  {
    key: 'attendance_days',
    en: 'Attendance by day',
    ar: 'الحضور اليومي',
    permission: 'attendance.record.view',
    filters: ['company', 'department', 'dateRange', 'status'],
    statuses: ['present', 'incomplete', 'absent_pending', 'absent_confirmed', 'excused'],
    fields: [
      ...person,
      f('date', 'Date', 'التاريخ', 'date'),
      f('status', 'Status', 'الحالة'),
      f('firstIn', 'First in', 'أول حضور'),
      f('lastOut', 'Last out', 'آخر انصراف'),
      f('workedMinutes', 'Worked (min)', 'العمل (دقيقة)', 'number'),
      f('lateMinutes', 'Late (min)', 'التأخير (دقيقة)', 'number'),
      f('earlyMinutes', 'Early leave (min)', 'الخروج المبكر (دقيقة)', 'number'),
      f('overtimeMinutes', 'Overtime (min)', 'الإضافي (دقيقة)', 'number'),
      f('flags', 'Notes', 'ملاحظات'),
    ],
  },
  {
    key: 'attendance_summary',
    en: 'Lateness, absence and overtime',
    ar: 'التأخير والغياب والعمل الإضافي',
    permission: 'attendance.record.view',
    filters: ['company', 'department', 'dateRange'],
    fields: [
      ...person,
      f('presentDays', 'Days present', 'أيام الحضور', 'number'),
      f('absentDays', 'Days absent (confirmed)', 'أيام الغياب المؤكد', 'number'),
      f('possibleAbsences', 'Possible absences', 'غياب محتمل', 'number'),
      f('lateDays', 'Late days', 'أيام التأخير', 'number'),
      f('lateMinutes', 'Late (min)', 'التأخير (دقيقة)', 'number'),
      f('earlyDays', 'Early departures', 'مرات الخروج المبكر', 'number'),
      f('overtimeMinutes', 'Overtime (min)', 'الإضافي (دقيقة)', 'number'),
      f('workedHours', 'Worked hours', 'ساعات العمل', 'number'),
    ],
  },
  {
    key: 'leave_balances',
    en: 'Leave balances',
    ar: 'أرصدة الإجازات',
    permission: 'leave.request.view',
    filters: ['company', 'department'],
    fields: [...person, f('leaveType', 'Leave type', 'نوع الإجازة'), f('balance', 'Balance', 'الرصيد', 'number'), f('pending', 'Pending', 'قيد الموافقة', 'number'), f('available', 'Available', 'المتاح', 'number'), f('usedThisYear', 'Taken this year', 'المأخوذ هذا العام', 'number')],
  },
  {
    key: 'leave_requests',
    en: 'Leave taken',
    ar: 'الإجازات',
    permission: 'leave.request.view',
    filters: ['company', 'department', 'dateRange', 'status'],
    statuses: ['pending', 'approved', 'rejected', 'cancelled'],
    fields: [...person, f('leaveType', 'Leave type', 'نوع الإجازة'), f('startDate', 'From', 'من', 'date'), f('endDate', 'To', 'إلى', 'date'), f('days', 'Days', 'الأيام', 'number'), f('status', 'Status', 'الحالة')],
  },
  {
    key: 'payroll',
    en: 'Payroll',
    ar: 'الرواتب',
    permission: 'payroll.view',
    filters: ['company', 'month'],
    fields: [
      ...person,
      f('runStatus', 'Run status', 'حالة المسير'),
      f('currency', 'Currency', 'العملة', 'text', 'financial'),
      f('daysPaid', 'Days paid', 'أيام الاستحقاق', 'number', 'financial'),
      f('gross', 'Gross', 'الإجمالي', 'money', 'financial'),
      f('deductions', 'Deductions', 'الاستقطاعات', 'money', 'financial'),
      f('net', 'Net', 'الصافي', 'money', 'financial'),
      f('paymentStatus', 'Payment', 'الصرف', 'text', 'financial'),
    ],
  },
  {
    key: 'employee_costs',
    en: 'Employee costs',
    ar: 'تكاليف الموظفين',
    permission: 'payroll.view',
    filters: ['company', 'month'],
    fields: [f('company', 'Company', 'الشركة'), f('department', 'Department', 'القسم'), f('currency', 'Currency', 'العملة', 'text', 'financial'), f('employees', 'Employees', 'الموظفون', 'number'), f('gross', 'Gross', 'الإجمالي', 'money', 'financial'), f('deductions', 'Deductions', 'الاستقطاعات', 'money', 'financial'), f('net', 'Net', 'الصافي', 'money', 'financial')],
  },
  {
    key: 'contracts',
    en: 'Contracts and expiry',
    ar: 'العقود وانتهاؤها',
    permission: 'contracts.view',
    filters: ['company', 'status', 'withinDays'],
    statuses: ['draft', 'awaiting_signature', 'active', 'expired', 'ended', 'renewed', 'cancelled'],
    fields: [...person, f('contractNo', 'Contract no.', 'رقم العقد'), f('contractType', 'Type', 'النوع'), f('status', 'Status', 'الحالة'), f('startDate', 'Start', 'البداية', 'date'), f('endDate', 'End', 'النهاية', 'date'), f('daysLeft', 'Days left', 'الأيام المتبقية', 'number'), f('probationEnd', 'Probation ends', 'نهاية التجربة', 'date')],
  },
  {
    key: 'recruitment',
    en: 'Recruitment',
    ar: 'التوظيف',
    permission: 'recruitment.view',
    filters: ['company', 'dateRange'],
    fields: [f('company', 'Company', 'الشركة'), f('vacancy', 'Vacancy', 'الوظيفة'), f('vacancyStatus', 'Vacancy status', 'حالة الوظيفة'), f('candidate', 'Candidate', 'المرشح'), f('source', 'Source', 'المصدر'), f('stage', 'Stage', 'المرحلة'), f('outcome', 'Outcome', 'النتيجة'), f('hired', 'Hired', 'عُيّن'), f('appliedOn', 'Applied on', 'تاريخ التقديم', 'date')],
  },
  {
    key: 'separations',
    en: 'Separations',
    ar: 'إنهاء الخدمة',
    permission: 'separation.view',
    filters: ['company', 'dateRange', 'status'],
    statuses: ['pending', 'approved', 'completed', 'cancelled', 'rejected'],
    fields: [...person, f('type', 'Type', 'النوع'), f('status', 'Status', 'الحالة'), f('lastWorkingDay', 'Last working day', 'آخر يوم عمل', 'date'), f('reason', 'Reason', 'السبب'), f('rehireEligible', 'Eligible for rehire', 'مؤهل لإعادة التوظيف'), f('settlement', 'Settlement', 'المكافأة', 'money', 'financial')],
  },
  {
    key: 'turnover',
    en: 'Turnover',
    ar: 'دوران الموظفين',
    permission: 'separation.view',
    filters: ['company', 'dateRange'],
    fields: [f('company', 'Company', 'الشركة'), f('headcountStart', 'Headcount at start', 'العدد في البداية', 'number'), f('hires', 'Hires', 'التعيينات', 'number'), f('leavers', 'Leavers', 'المغادرون', 'number'), f('headcountEnd', 'Headcount at end', 'العدد في النهاية', 'number'), f('turnoverRate', 'Turnover rate', 'معدل الدوران', 'percent')],
  },
  {
    key: 'evaluation',
    en: 'Commitment evaluation',
    ar: 'تقييم الالتزام',
    permission: 'evaluation.view',
    filters: ['company', 'department', 'status'],
    statuses: ['draft', 'final'],
    fields: [...person, f('period', 'Period', 'الفترة'), f('score', 'Score', 'الدرجة', 'number'), f('band', 'Band', 'التصنيف'), f('status', 'Status', 'الحالة')],
  },
];

export const DATASET_KEYS = DATASETS.map((d) => d.key);

export const reportFiltersSchema = z.object({
  companyId: z.uuid(),
  departmentId: z.uuid().nullable().optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
    .optional(),
  status: z.string().max(40).optional(),
  withinDays: z.number().int().min(1).max(730).optional(),
});
export type ReportFilters = z.infer<typeof reportFiltersSchema>;

export const reportRunInput = z.object({
  dataset: z.string().refine((k) => DATASET_KEYS.includes(k), 'Unknown dataset'),
  fields: z.array(z.string().max(40)).min(1).max(40),
  filters: reportFiltersSchema,
});

export const savedReportInput = reportRunInput.extend({
  name: z.string().trim().min(2).max(120),
  /** In-app delivery to the owner (C-03); null = not scheduled. */
  schedule: z
    .object({ frequency: z.enum(['daily', 'weekly', 'monthly']), hour: z.number().int().min(0).max(23) })
    .nullable()
    .default(null),
});

export interface ReportResultDto {
  columns: ReportField[];
  rows: Record<string, string | number | null>[];
  truncated: boolean;
}

export interface SavedReportDto {
  id: string;
  name: string;
  dataset: string;
  fields: string[];
  filters: ReportFilters;
  schedule: { frequency: 'daily' | 'weekly' | 'monthly'; hour: number } | null;
  lastRunAt: string | null;
  createdAt: string;
}

export interface SearchResultDto {
  kind: 'employee' | 'contract' | 'candidate' | 'vacancy';
  id: string;
  title: string;
  subtitle: string;
  link: string;
}

// --- dashboards (DASH-01, DASH-02) -------------------------------------------------------

export const WIDGETS = [
  'my_attendance',
  'my_leave',
  'my_tasks',
  'headcount',
  'attendance_today',
  'on_leave_today',
  'pending_approvals',
  'contracts_expiring',
  'open_vacancies',
  'payroll_status',
  'system_health',
] as const;
export type WidgetKey = (typeof WIDGETS)[number];

export const dashboardLayoutsSchema = z.object({
  /** Widgets per role key, in display order. A user sees the union of their roles' widgets. */
  roles: z.record(z.string().max(60), z.array(z.object({ widget: z.enum(WIDGETS), size: z.enum(['small', 'large']) })).max(12)),
});
export type DashboardLayouts = z.infer<typeof dashboardLayoutsSchema>;

export const DEFAULT_DASHBOARD_LAYOUTS: DashboardLayouts = {
  roles: {
    employee: [
      { widget: 'my_attendance', size: 'small' },
      { widget: 'my_leave', size: 'small' },
      { widget: 'my_tasks', size: 'small' },
    ],
    hr: [
      { widget: 'headcount', size: 'small' },
      { widget: 'attendance_today', size: 'small' },
      { widget: 'on_leave_today', size: 'small' },
      { widget: 'pending_approvals', size: 'small' },
      { widget: 'contracts_expiring', size: 'large' },
      { widget: 'open_vacancies', size: 'small' },
    ],
    company_manager: [
      { widget: 'headcount', size: 'small' },
      { widget: 'attendance_today', size: 'small' },
      { widget: 'pending_approvals', size: 'small' },
    ],
    department_manager: [
      { widget: 'attendance_today', size: 'small' },
      { widget: 'pending_approvals', size: 'small' },
    ],
    senior_management: [
      { widget: 'headcount', size: 'large' },
      { widget: 'payroll_status', size: 'large' },
    ],
    finance: [{ widget: 'payroll_status', size: 'large' }],
    timekeeping: [
      { widget: 'attendance_today', size: 'large' },
      { widget: 'on_leave_today', size: 'small' },
    ],
    system_admin: [{ widget: 'system_health', size: 'large' }],
  },
};

export interface WidgetDto {
  widget: WidgetKey;
  size: 'small' | 'large';
  data: Record<string, unknown>;
}
