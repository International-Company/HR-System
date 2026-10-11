/**
 * Permission catalogue — the single source of truth (RBAC-03, RBAC-07).
 * Synced into the `permission` table on every migration run.
 * New phases add their permissions here.
 */

/** normal | security (account/system control) | financial | identity | medical (personal data classes). */
export type Sensitivity = 'normal' | 'security' | 'financial' | 'identity' | 'medical';

export interface PermissionDef {
  key: string;
  module: string;
  sensitivity: Sensitivity;
  /** Only effective when granted through a GROUP-scoped role assignment. */
  groupOnly: boolean;
  label: { ar: string; en: string };
}

const p = (
  key: string,
  module: string,
  en: string,
  ar: string,
  opts: { sensitivity?: Sensitivity; groupOnly?: boolean } = {},
): PermissionDef => ({
  key,
  module,
  sensitivity: opts.sensitivity ?? 'normal',
  groupOnly: opts.groupOnly ?? false,
  label: { en, ar },
});

export const PERMISSIONS = [
  // Organisation
  p('org.company.view', 'org', 'View companies', 'عرض الشركات'),
  p('org.company.create', 'org', 'Create companies', 'إنشاء الشركات', { groupOnly: true }),
  p('org.company.edit', 'org', 'Edit companies', 'تعديل الشركات', { groupOnly: true }),
  p('org.department.view', 'org', 'View departments', 'عرض الأقسام'),
  p('org.department.manage', 'org', 'Manage departments', 'إدارة الأقسام'),
  p('org.location.view', 'org', 'View work locations', 'عرض مواقع العمل'),
  p('org.location.manage', 'org', 'Manage work locations', 'إدارة مواقع العمل'),

  // Identity & accounts
  p('identity.user.view', 'identity', 'View user accounts', 'عرض حسابات المستخدمين'),
  p('identity.user.create', 'identity', 'Create user accounts', 'إنشاء حسابات المستخدمين', {
    sensitivity: 'security',
    groupOnly: true,
  }),
  p('identity.user.edit', 'identity', 'Edit user accounts', 'تعديل حسابات المستخدمين', {
    sensitivity: 'security',
    groupOnly: true,
  }),
  p('identity.user.disable', 'identity', 'Disable/enable accounts', 'تعطيل/تفعيل الحسابات', {
    sensitivity: 'security',
    groupOnly: true,
  }),
  p(
    'identity.user.reset_credentials',
    'identity',
    'Reset passwords, MFA, unlock',
    'إعادة تعيين كلمات المرور والتحقق الثنائي وفك القفل',
    { sensitivity: 'security', groupOnly: true },
  ),
  p('identity.session.view', 'identity', 'View user sessions', 'عرض جلسات المستخدمين', {
    sensitivity: 'security',
    groupOnly: true,
  }),
  p('identity.session.revoke', 'identity', 'Terminate user sessions', 'إنهاء جلسات المستخدمين', {
    sensitivity: 'security',
    groupOnly: true,
  }),

  // Access control
  p('access.role.view', 'access', 'View roles', 'عرض الأدوار'),
  p('access.role.manage', 'access', 'Manage roles and permissions', 'إدارة الأدوار والصلاحيات', {
    sensitivity: 'security',
    groupOnly: true,
  }),
  p('access.assignment.view', 'access', 'View role assignments', 'عرض إسناد الأدوار'),
  p('access.assignment.manage', 'access', 'Assign roles to users', 'إسناد الأدوار للمستخدمين', {
    sensitivity: 'security',
    groupOnly: true,
  }),

  // Settings & modules
  p('settings.view', 'settings', 'View settings', 'عرض الإعدادات'),
  p('settings.manage.general', 'settings', 'Manage general settings', 'إدارة الإعدادات العامة', {
    groupOnly: true,
  }),
  p('settings.manage.security', 'settings', 'Manage security policies', 'إدارة سياسات الأمان', {
    sensitivity: 'security',
    groupOnly: true,
  }),
  p('settings.manage.modules', 'settings', 'Enable/disable modules', 'تفعيل/تعطيل الوحدات', {
    groupOnly: true,
  }),
  p('settings.manage.backup', 'settings', 'Manage backup settings', 'إدارة إعدادات النسخ الاحتياطي', {
    sensitivity: 'security',
    groupOnly: true,
  }),

  // Audit
  p('audit.view', 'audit', 'View audit log', 'عرض سجل التدقيق'),
  p('audit.view.security', 'audit', 'View security audit events', 'عرض أحداث الأمان في سجل التدقيق', {
    sensitivity: 'security',
    groupOnly: true,
  }),
  p('audit.verify', 'audit', 'Verify audit integrity', 'التحقق من سلامة سجل التدقيق', {
    groupOnly: true,
  }),

  // Employees (Phase 2)
  p('employee.profile.view', 'employees', 'View employee profiles', 'عرض ملفات الموظفين'),
  p('employee.profile.create', 'employees', 'Hire / create employees', 'تعيين / إنشاء موظفين'),
  p('employee.profile.edit', 'employees', 'Edit personal data and qualifications', 'تعديل البيانات الشخصية والمؤهلات'),
  p('employee.lifecycle.manage', 'employees', 'Transfers, job changes, status changes', 'النقل وتغيير الوظيفة والحالة'),
  p('employee.financial.view', 'employees', 'View salary and bank data', 'عرض الراتب والبيانات البنكية', {
    sensitivity: 'financial',
  }),
  p('employee.financial.edit', 'employees', 'Change salary and bank data', 'تعديل الراتب والبيانات البنكية', {
    sensitivity: 'financial',
  }),
  p('employee.identity.view', 'employees', 'View national ID / passport numbers', 'عرض أرقام الهوية / الجواز', {
    sensitivity: 'identity',
  }),
  p(
    'employee.history.crosscompany.view',
    'employees',
    'View employment history from other companies',
    'عرض السجل الوظيفي في الشركات الأخرى',
  ),
  p('employee.account.link', 'employees', 'Link user accounts to employees', 'ربط حسابات المستخدمين بالموظفين', {
    sensitivity: 'security',
    groupOnly: true,
  }),
  p('lookups.manage', 'employees', 'Manage job titles and other lists', 'إدارة المسميات الوظيفية والقوائم'),

  // Documents (Phase 2)
  p('documents.view', 'documents', 'View documents', 'عرض المستندات'),
  p('documents.upload', 'documents', 'Upload and replace documents', 'رفع واستبدال المستندات'),
  p('documents.delete', 'documents', 'Delete and restore documents', 'حذف واستعادة المستندات'),
  p('documents.view.restricted', 'documents', 'View restricted documents', 'عرض المستندات المقيدة', {
    sensitivity: 'identity',
  }),
  p('documents.view.medical', 'documents', 'View medical documents', 'عرض المستندات الطبية', {
    sensitivity: 'medical',
  }),
  p('documents.categories.manage', 'documents', 'Manage document categories', 'إدارة تصنيفات المستندات', {
    groupOnly: true,
  }),

  // Workflow (Phase 3). Deciding one's own tasks needs no permission: tasks are personal.
  p('workflow.instances.view', 'workflow', 'View approval requests of the company', 'عرض طلبات الموافقة في الشركة'),
  p('workflow.definitions.manage', 'workflow', 'Configure approval workflows', 'ضبط مسارات الموافقة', {
    groupOnly: true,
  }),

  // Calendar (Phase 3)
  p('schedules.view', 'calendar', 'View work schedules', 'عرض جداول الدوام'),
  p('schedules.manage', 'calendar', 'Manage and assign work schedules', 'إدارة جداول الدوام وإسنادها'),
  p('holidays.manage', 'calendar', 'Manage official holidays', 'إدارة العطل الرسمية'),

  // Attendance (Phase 4)
  p('attendance.punch', 'attendance', 'Record own attendance', 'تسجيل الحضور الشخصي'),
  p('attendance.record.view', 'attendance', 'View attendance records', 'عرض سجلات الحضور'),
  p('attendance.record.correct', 'attendance', 'Correct attendance directly', 'تصحيح الحضور مباشرة'),
  p('attendance.review', 'attendance', 'Review absences and exceptions', 'مراجعة الغياب والاستثناءات'),
  p('attendance.network.manage', 'attendance', 'Manage authorised networks', 'إدارة الشبكات المسموح بها', {
    sensitivity: 'security',
  }),
  p('attendance.device.manage', 'attendance', 'Approve and revoke attendance devices', 'اعتماد وإلغاء أجهزة الحضور', {
    sensitivity: 'security',
  }),
  p('attendance.policy.manage', 'attendance', 'Configure attendance policies', 'ضبط سياسات الحضور', {
    groupOnly: true,
  }),

  // Leave & in-day permissions (Phase 5). Approving is a workflow task and needs no permission.
  p('leave.request.create', 'leave', 'Submit leave and permission requests', 'تقديم طلبات الإجازة والاستئذان'),
  p('leave.request.view', 'leave', 'View leave requests and balances', 'عرض طلبات الإجازة والأرصدة'),
  p('leave.request.manage', 'leave', 'Cancel approved leave and record leave for employees', 'إلغاء الإجازات المعتمدة وتسجيل الإجازات للموظفين'),
  p('leave.balance.adjust', 'leave', 'Set opening balances and adjust leave balances', 'إدخال الأرصدة الافتتاحية وتعديل أرصدة الإجازات'),
  p('leave.types.manage', 'leave', 'Configure leave types and rules', 'ضبط أنواع الإجازات وقواعدها', {
    groupOnly: true,
  }),

  // System backup
  p('system.backup.view', 'system', 'View backups', 'عرض النسخ الاحتياطية', {
    sensitivity: 'security',
    groupOnly: true,
  }),
  p('system.backup.create', 'system', 'Create a backup now', 'إنشاء نسخة احتياطية الآن', {
    sensitivity: 'security',
    groupOnly: true,
  }),
  // BKP-06: restoring replaces ALL data. System Administrator role only; refused in custom roles.
  p('system.backup.restore', 'system', 'Restore the system from a backup', 'استعادة النظام من نسخة احتياطية', {
    sensitivity: 'security',
    groupOnly: true,
  }),
] as const satisfies readonly PermissionDef[];

/** Permissions that can never be placed in custom roles. */
export const SYSTEM_ROLE_ONLY_PERMISSIONS: readonly string[] = ['system.backup.restore'];

export type PermissionKey = (typeof PERMISSIONS)[number]['key'];

export const PERMISSION_KEYS: readonly PermissionKey[] = PERMISSIONS.map((x) => x.key);

export const PERMISSION_BY_KEY: ReadonlyMap<string, PermissionDef> = new Map(
  PERMISSIONS.map((x) => [x.key, x]),
);

export const SCOPE_TYPES = ['GROUP', 'COMPANY', 'DEPARTMENT', 'SELF'] as const;
export type ScopeType = (typeof SCOPE_TYPES)[number];
