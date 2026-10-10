import type { ScopeType } from './permissions.js';
import type { DisablePolicy } from './modules.js';

/** Stable error codes returned in problem+json responses. */
export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'AUTH_REQUIRED',
  'AUTH_INVALID_CREDENTIALS',
  'AUTH_LOCKED',
  'AUTH_DISABLED',
  'AUTH_RATE_LIMITED',
  'SESSION_STATE',
  'CSRF_INVALID',
  'MFA_INVALID',
  'MFA_REQUIRED_BY_POLICY',
  'PASSWORD_POLICY',
  'PASSWORD_INCORRECT',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'VERSION_CONFLICT',
  'MODULE_DISABLED',
  'NOT_CONFIGURED',
  'INTERNAL',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  code: ErrorCode;
  detail?: string;
  errors?: { path: string; message: string }[];
  meta?: Record<string, unknown>;
}

export type SessionState =
  | 'active'
  | 'mfa_required'
  | 'password_change_required'
  | 'mfa_setup_required';

export interface SessionInfo {
  state: SessionState;
  csrfToken: string;
  user: {
    id: string;
    username: string;
    displayName: string;
    email: string | null;
    mfaEnabled: boolean;
    /** Linked employee record, if any (enables "My profile"). */
    employeeId: string | null;
  };
  permissions: string[];
  roles: { key: string; scopeType: ScopeType; companyId: string | null }[];
  expiresAt: string;
}

export interface PublicSettings {
  language: 'ar' | 'en';
  timezone: string;
  dateFormat: string;
  timeFormat: '24h' | '12h';
  numerals: 'latn' | 'arab';
  groupName: { ar: string; en: string } | null;
}

export interface CompanyDto {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  status: 'active' | 'inactive';
  version: number;
}

export interface DepartmentDto {
  id: string;
  companyId: string;
  parentId: string | null;
  code: string;
  nameAr: string;
  nameEn: string;
  status: 'active' | 'inactive';
  version: number;
}

export interface LocationDto {
  id: string;
  companyId: string;
  code: string;
  nameAr: string;
  nameEn: string;
  address: string | null;
  status: 'active' | 'inactive';
  version: number;
}

export interface UserDto {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  status: 'active' | 'disabled';
  mfaEnabled: boolean;
  locked: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  version: number;
}

export interface RoleDto {
  id: string;
  key: string;
  nameAr: string;
  nameEn: string;
  description: string | null;
  isSystem: boolean;
  permissions: string[];
  version: number;
}

export interface AssignmentDto {
  id: string;
  userId: string;
  roleId: string;
  roleKey: string;
  scopeType: ScopeType;
  companyId: string | null;
  departmentId: string | null;
  validFrom: string;
  validTo: string | null;
  endedAt: string | null;
}

export interface SessionDto {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  ip: string | null;
  userAgent: string | null;
  current: boolean;
}

export interface SettingDto {
  key: string;
  value: unknown;
  groupValue: unknown;
  companyValue: unknown;
  isDefault: boolean;
  companyOverride: boolean;
  permission: string;
  updatedAt: string | null;
}

export interface ModuleDto {
  key: string;
  groupEnabled: boolean;
  disablePolicy: DisablePolicy;
  companies: { companyId: string; enabled: boolean }[];
}

export interface AuditEventDto {
  id: number;
  at: string;
  actorUserId: string | null;
  actorUsername: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  companyId: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  outcome: 'success' | 'denied' | 'failure';
  details: unknown;
}

export interface BackupRunDto {
  id: string;
  kind: 'manual' | 'scheduled' | 'restore_test';
  status: 'requested' | 'running' | 'succeeded' | 'failed';
  requestedBy: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  sizeBytes: number | null;
  objectKey: string | null;
  error: string | null;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
