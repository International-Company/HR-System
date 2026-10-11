import { PERMISSIONS, type PermissionKey, type ScopeType } from './permissions.js';

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

/** Personal-data permissions are granted explicitly, never implied by system administration. */
const ADMIN_PERMISSIONS: PermissionKey[] = PERMISSIONS.filter(
  (p) => p.sensitivity === 'normal' || p.sensitivity === 'security',
).map((p) => p.key);

export const SYSTEM_ROLES: readonly SystemRoleDef[] = [
  {
    key: 'system_admin',
    name: { ar: 'مدير النظام', en: 'System Administrator' },
    defaultScope: 'GROUP',
    // Separation of duties: salary, identity and medical data are NOT included;
    // they are granted explicitly (for example by also assigning the HR role).
    permissions: ADMIN_PERMISSIONS,
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
      'employee.profile.view',
      'employee.profile.create',
      'employee.profile.edit',
      'employee.lifecycle.manage',
      'employee.financial.view',
      'employee.financial.edit',
      'employee.identity.view',
      'lookups.manage',
      'documents.view',
      'documents.upload',
      'documents.delete',
      'documents.view.restricted',
      'workflow.instances.view',
      'schedules.view',
      'schedules.manage',
      'holidays.manage',
      'attendance.record.view',
      'attendance.record.correct',
      'attendance.review',
      'attendance.network.manage',
      'attendance.device.manage',
      'leave.request.create',
      'leave.request.view',
      'leave.request.manage',
      'leave.balance.adjust',
      'contracts.view',
      'contracts.manage',
      'contracts.manual_edit',
      'separation.request',
      'separation.view',
      'separation.manage',
      'recruitment.view',
      'recruitment.manage',
      'recruitment.offers',
      'evaluation.view',
      'evaluation.manage',
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
      'employee.profile.view',
      'employee.financial.view',
      'documents.view',
      'workflow.instances.view',
      'schedules.view',
      'attendance.record.view',
      'leave.request.view',
      'contracts.view',
      'payroll.view',
      'payroll.summary.view',
      'separation.view',
      'recruitment.view',
      'evaluation.view',
    ],
  },
  {
    key: 'company_manager',
    name: { ar: 'مدير شركة', en: 'Company Manager' },
    defaultScope: 'COMPANY',
    permissions: [
      'org.company.view',
      'org.department.view',
      'org.location.view',
      'employee.profile.view',
      'documents.view',
      'workflow.instances.view',
      'schedules.view',
      'attendance.record.view',
      'leave.request.view',
      'contracts.view',
      'contracts.sign',
      'payroll.view',
      'separation.view',
      'recruitment.view',
      'evaluation.view',
    ],
  },
  {
    key: 'department_manager',
    name: { ar: 'مدير قسم', en: 'Department Manager' },
    defaultScope: 'DEPARTMENT',
    permissions: [
      'org.company.view',
      'org.department.view',
      'employee.profile.view',
      'attendance.record.view',
      'leave.request.view',
      'evaluation.view',
    ],
  },
  {
    key: 'employee',
    name: { ar: 'موظف', en: 'Employee' },
    defaultScope: 'SELF',
    // SELF scope: own profile, own current salary and own documents in employee-visible
    // categories (EMP-10).
    permissions: [
      'employee.profile.view',
      'documents.view',
      'attendance.punch',
      'attendance.record.view',
      'leave.request.create',
      'leave.request.view',
      'contracts.view',
      'payroll.payslip.view',
      'separation.request',
      'separation.view',
      'evaluation.view',
    ],
  },
  {
    key: 'finance',
    name: { ar: 'محاسب / مالية', en: 'Accountant / Finance' },
    defaultScope: 'COMPANY',
    permissions: [
      'org.company.view',
      'org.department.view',
      'employee.profile.view',
      'employee.financial.view',
      'payroll.view',
      'payroll.prepare',
      'payroll.payments.manage',
      'payroll.payslip.view',
    ],
  },
  {
    key: 'timekeeping',
    name: { ar: 'مسؤول الحضور والانصراف', en: 'Attendance / Timekeeping Officer' },
    defaultScope: 'COMPANY',
    permissions: [
      'org.company.view',
      'org.department.view',
      'org.location.view',
      'employee.profile.view',
      'schedules.view',
      'schedules.manage',
      'attendance.record.view',
      'attendance.record.correct',
      'attendance.review',
      'attendance.network.manage',
      'attendance.device.manage',
      'leave.request.view',
    ],
  },
];
