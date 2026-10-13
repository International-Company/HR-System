import { z } from 'zod';
import { SCOPE_TYPES } from './permissions.js';
import { DISABLE_POLICIES } from './modules.js';

/** Request/response schemas shared by the API (validation) and the web app (forms). */

const nameText = z.string().trim().min(1).max(200);
const code = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[A-Za-z0-9_-]+$/, 'Letters, digits, - and _ only');
const status = z.enum(['active', 'inactive']);

export const usernameSchema = z
  .string()
  .trim()
  .min(3)
  .max(64)
  .regex(/^[A-Za-z0-9._@-]+$/, 'Letters, digits and . _ @ - only');

export const loginInput = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(256),
});

export const changePasswordInput = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(1).max(256),
});

export const totpCodeInput = z.object({
  code: z.string().trim().regex(/^\d{6}$/),
});

export const mfaVerifyInput = z.union([
  z.object({ code: z.string().trim().regex(/^\d{6}$/) }),
  z.object({
    // Spaces, dashes, lower case and Arabic-Indic digits are accepted and normalised by the server.
    recoveryCode: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9\-\s\u0660-\u0669\u06f0-\u06f9]{8,40}$/),
  }),
]);

export const disableMfaInput = z.object({
  password: z.string().min(1).max(256),
  code: z.string().trim().regex(/^\d{6}$/),
});

export const companyCreateInput = z.object({
  code,
  nameAr: nameText,
  nameEn: nameText,
});
export const companyUpdateInput = z.object({
  nameAr: nameText.optional(),
  nameEn: nameText.optional(),
  status: status.optional(),
  version: z.number().int().positive(),
});

export const departmentCreateInput = z.object({
  code,
  nameAr: nameText,
  nameEn: nameText,
  parentId: z.uuid().nullable().optional(),
});
export const departmentUpdateInput = z.object({
  nameAr: nameText.optional(),
  nameEn: nameText.optional(),
  parentId: z.uuid().nullable().optional(),
  status: status.optional(),
  version: z.number().int().positive(),
});

export const locationCreateInput = z.object({
  code,
  nameAr: nameText,
  nameEn: nameText,
  address: z.string().trim().max(500).optional(),
});
export const locationUpdateInput = z.object({
  nameAr: nameText.optional(),
  nameEn: nameText.optional(),
  address: z.string().trim().max(500).nullable().optional(),
  status: status.optional(),
  version: z.number().int().positive(),
});

export const groupUpdateInput = z.object({
  nameAr: nameText.optional(),
  nameEn: nameText.optional(),
  version: z.number().int().positive(),
});

export const userCreateInput = z.object({
  username: usernameSchema,
  displayName: nameText,
  email: z.email().max(254).optional(),
  temporaryPassword: z.string().min(1).max(256),
});
export const userUpdateInput = z.object({
  displayName: nameText.optional(),
  email: z.email().max(254).nullable().optional(),
  version: z.number().int().positive(),
});
export const userStatusInput = z.object({
  status: z.enum(['active', 'disabled']),
  reason: z.string().trim().min(1).max(500),
});
export const resetPasswordInput = z.object({
  temporaryPassword: z.string().min(1).max(256),
});

export const roleCreateInput = z.object({
  key: z
    .string()
    .trim()
    .min(2)
    .max(64)
    .regex(/^[a-z][a-z0-9_]*$/, 'lowercase letters, digits and _'),
  nameAr: nameText,
  nameEn: nameText,
  description: z.string().trim().max(1000).optional(),
  permissions: z.array(z.string().min(1).max(100)).max(500),
});
export const roleUpdateInput = z.object({
  nameAr: nameText.optional(),
  nameEn: nameText.optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  permissions: z.array(z.string().min(1).max(100)).max(500).optional(),
  version: z.number().int().positive(),
});

export const assignmentCreateInput = z.object({
  roleId: z.uuid(),
  scopeType: z.enum(SCOPE_TYPES),
  companyId: z.uuid().nullable().optional(),
  departmentId: z.uuid().nullable().optional(),
  validFrom: z.iso.date().optional(),
  validTo: z.iso.date().nullable().optional(),
});

export const settingUpdateInput = z.object({
  value: z.unknown(),
  companyId: z.uuid().nullable().optional(),
});

export const moduleUpdateInput = z.object({
  groupEnabled: z.boolean().optional(),
  disablePolicy: z.enum(DISABLE_POLICIES).optional(),
});
export const moduleCompanyInput = z.object({
  enabled: z.boolean(),
});

export const auditQueryInput = z.object({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  actorUserId: z.uuid().optional(),
  action: z.string().max(100).optional(),
  entityType: z.string().max(100).optional(),
  entityId: z.string().max(100).optional(),
  companyId: z.uuid().optional(),
  outcome: z.enum(['success', 'denied', 'failure']).optional(),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export type LoginInput = z.infer<typeof loginInput>;
export type CompanyCreateInput = z.infer<typeof companyCreateInput>;
export type AssignmentCreateInput = z.infer<typeof assignmentCreateInput>;
export type AuditQueryInput = z.infer<typeof auditQueryInput>;
