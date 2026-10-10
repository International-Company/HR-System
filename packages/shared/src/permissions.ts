/**
 * Permission catalogue — the single source of truth (RBAC-03, RBAC-07).
 * Synced into the `permission` table on every migration run.
 * New phases add their permissions here.
 */

export type Sensitivity = 'normal' | 'security';

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

  // System backup
  p('system.backup.view', 'system', 'View backups', 'عرض النسخ الاحتياطية', {
    sensitivity: 'security',
    groupOnly: true,
  }),
  p('system.backup.create', 'system', 'Create a backup now', 'إنشاء نسخة احتياطية الآن', {
    sensitivity: 'security',
    groupOnly: true,
  }),
] as const satisfies readonly PermissionDef[];

export type PermissionKey = (typeof PERMISSIONS)[number]['key'];

export const PERMISSION_KEYS: readonly PermissionKey[] = PERMISSIONS.map((x) => x.key);

export const PERMISSION_BY_KEY: ReadonlyMap<string, PermissionDef> = new Map(
  PERMISSIONS.map((x) => [x.key, x]),
);

export const SCOPE_TYPES = ['GROUP', 'COMPANY', 'DEPARTMENT', 'SELF'] as const;
export type ScopeType = (typeof SCOPE_TYPES)[number];
