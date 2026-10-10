import { PERMISSION_KEYS, type PermissionKey, type ScopeType } from './permissions.js';

/**
 * Seeded system roles (RBAC-01). System roles are locked: their permissions are
 * managed by code and synced on migration. Administrators customise by copying a
 * system role into a custom role.
 */
export interface SystemRoleDef {
  key: string;
  name: { ar: string; en: string };
  defaultScope: ScopeType;
  permissions: readonly PermissionKey[];
}

export const SYSTEM_ROLES: readonly SystemRoleDef[] = [
  {
    key: 'system_admin',
    name: { ar: 'مدير النظام', en: 'System Administrator' },
    defaultScope: 'GROUP',
    // Separation of duties: future sensitive HR/payroll permissions are NOT
    // automatically included here; they are granted explicitly.
    permissions: PERMISSION_KEYS,
  },
  {
    key: 'hr',
    name: { ar: 'موظف موارد بشرية', en: 'HR Employee' },
    defaultScope: 'COMPANY',
    permissions: [
      'org.company.view',
      'org.department.view',
      'org.department.manage',
      'org.location.view',
      'org.location.manage',
      'identity.user.view',
      'access.role.view',
      'access.assignment.view',
      'settings.view',
    ],
  },
  {
    key: 'senior_management',
    name: { ar: 'الإدارة العليا', en: 'Senior Management' },
    defaultScope: 'GROUP',
    permissions: [
      'org.company.view',
      'org.department.view',
      'org.location.view',
      'identity.user.view',
      'settings.view',
    ],
  },
  {
    key: 'company_manager',
    name: { ar: 'مدير شركة', en: 'Company Manager' },
    defaultScope: 'COMPANY',
    permissions: ['org.company.view', 'org.department.view', 'org.location.view'],
  },
  {
    key: 'department_manager',
    name: { ar: 'مدير قسم', en: 'Department Manager' },
    defaultScope: 'DEPARTMENT',
    permissions: ['org.company.view', 'org.department.view'],
  },
  {
    key: 'employee',
    name: { ar: 'موظف', en: 'Employee' },
    defaultScope: 'SELF',
    permissions: [],
  },
  {
    key: 'finance',
    name: { ar: 'محاسب / مالية', en: 'Accountant / Finance' },
    defaultScope: 'COMPANY',
    permissions: ['org.company.view', 'org.department.view'],
  },
  {
    key: 'timekeeping',
    name: { ar: 'مسؤول الحضور والانصراف', en: 'Attendance / Timekeeping Officer' },
    defaultScope: 'COMPANY',
    permissions: ['org.company.view', 'org.department.view', 'org.location.view'],
  },
];
