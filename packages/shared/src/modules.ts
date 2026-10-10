/**
 * Business modules that can be activated per group and enabled per company
 * (ORG-07, ORG-08). Platform modules (org, access, settings, audit, notifications)
 * are always on and are not listed here.
 */
export const BUSINESS_MODULES = [
  { key: 'documents', name: { ar: 'إدارة المستندات', en: 'Documents' } },
  { key: 'attendance', name: { ar: 'الحضور والانصراف', en: 'Attendance' } },
  { key: 'leave', name: { ar: 'الإجازات والاستئذانات', en: 'Leave & permissions' } },
  { key: 'payroll', name: { ar: 'الرواتب', en: 'Payroll' } },
  { key: 'contracts', name: { ar: 'العقود', en: 'Contracts' } },
  { key: 'recruitment', name: { ar: 'التوظيف', en: 'Recruitment' } },
  { key: 'separation', name: { ar: 'إنهاء الخدمة وإعادة التعيين', en: 'Separation & rehire' } },
  { key: 'evaluation', name: { ar: 'تقييم الالتزام', en: 'Commitment evaluation' } },
  { key: 'reports', name: { ar: 'التقارير', en: 'Reports' } },
] as const;

export type ModuleKey = (typeof BUSINESS_MODULES)[number]['key'];
export const MODULE_KEYS: readonly ModuleKey[] = BUSINESS_MODULES.map((m) => m.key);
export const DISABLE_POLICIES = ['read_only', 'hidden'] as const;
export type DisablePolicy = (typeof DISABLE_POLICIES)[number];
