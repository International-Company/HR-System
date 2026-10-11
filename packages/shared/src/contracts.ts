import { z } from 'zod';

/** Phase 6: contracts (CON-01..11). */

export const CONTRACT_STATUSES = ['draft', 'awaiting_signature', 'active', 'expired', 'ended', 'renewed', 'cancelled'] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

export const VERSION_KINDS = ['original', 'addendum', 'extension', 'auto_renewal'] as const;
export type VersionKind = (typeof VERSION_KINDS)[number];

export const VERSION_STATUSES = ['draft', 'awaiting_signature', 'signed', 'cancelled'] as const;
export type VersionStatus = (typeof VERSION_STATUSES)[number];

export const SIGNER_ROLES = ['employee', 'company'] as const;
export type SignerRole = (typeof SIGNER_ROLES)[number];

/** Merge fields filled from the employee, company and contract (CON-02). */
export const MERGE_FIELDS = [
  'employee.number',
  'employee.nameAr',
  'employee.nameEn',
  'employee.nationality',
  'employee.hireDate',
  'company.nameAr',
  'company.nameEn',
  'job.nameAr',
  'job.nameEn',
  'department.nameAr',
  'department.nameEn',
  'contract.number',
  'contract.startDate',
  'contract.endDate',
  'contract.probationEnd',
  'salary.base',
  'salary.currency',
  'today',
] as const;

const date = z.iso.date();
const code = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{2,30}$/);
const body = z.string().max(50_000);

/** Per contract type (CON-04): how renewals work and who signs. */
export const contractTypePolicySchema = z.object({
  /** extend = an extension version of the same contract; new_contract = a new linked contract. */
  renewal: z.enum(['extend', 'new_contract']),
  /** Automatic renewal on the end date, only when allowed for the type (CON-04). */
  autoRenew: z.boolean(),
  autoRenewMonths: z.number().int().min(1).max(60),
  /** Signers required on every version. */
  signers: z.array(z.enum(SIGNER_ROLES)).min(1).max(2),
  defaultDurationMonths: z.number().int().min(1).max(120).nullable(),
  probationDays: z.number().int().min(0).max(365).nullable(),
  /** Retention after the contract ends (CON-07); records are never deleted automatically. */
  retentionYears: z.number().int().min(1).max(100),
});
export type ContractTypePolicy = z.infer<typeof contractTypePolicySchema>;

export const DEFAULT_CONTRACT_TYPE_POLICY: ContractTypePolicy = {
  renewal: 'extend',
  autoRenew: false,
  autoRenewMonths: 12,
  signers: ['employee', 'company'],
  defaultDurationMonths: 12,
  probationDays: 90,
  retentionYears: 10,
};

export const contractTypePolicyInput = z.object({ contractTypeId: z.uuid(), policy: contractTypePolicySchema });

export const templateFieldSchema = z.object({
  key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/),
  label: z.string().trim().min(1).max(120),
  required: z.boolean(),
});

export const contractTemplateInput = z.object({
  companyId: z.uuid().nullable(),
  contractTypeId: z.uuid(),
  code,
  name: z.string().trim().min(1).max(200),
  /** Templates are per language (Q-22). */
  language: z.enum(['ar', 'en']),
  /** Plain text: blank line = new paragraph, "# " = heading; {{merge.field}}, {{field.key}}, {{clause.CODE}}. */
  body,
  fields: z.array(templateFieldSchema).max(30).default([]),
});
export const contractTemplateUpdateInput = contractTemplateInput.omit({ companyId: true, code: true }).extend({
  status: z.enum(['active', 'inactive']),
});

export const contractClauseInput = z.object({
  companyId: z.uuid().nullable(),
  code,
  title: z.string().trim().min(1).max(200),
  language: z.enum(['ar', 'en']),
  body,
});
export const contractClauseUpdateInput = contractClauseInput.omit({ companyId: true, code: true, language: true }).extend({
  status: z.enum(['active', 'inactive']),
});

export const contractCreateInput = z.object({
  employeeId: z.uuid(),
  templateId: z.uuid(),
  startDate: date,
  endDate: date.nullable(),
  probationEnd: date.nullable(),
  fieldValues: z.record(z.string(), z.string().max(2000)).default({}),
});

/** Draft only (CON-06): regenerate from the template or edit the text where permitted. */
export const contractDraftUpdateInput = z.object({
  startDate: date,
  endDate: date.nullable(),
  probationEnd: date.nullable(),
  fieldValues: z.record(z.string(), z.string().max(2000)).default({}),
  /** Manual text instead of the generated one (needs contracts.manual_edit). */
  bodyOverride: body.nullable().default(null),
});

export const addendumInput = z.object({
  templateId: z.uuid().nullable(),
  effectiveDate: date,
  body: body.nullable(),
  fieldValues: z.record(z.string(), z.string().max(2000)).default({}),
});

export const renewInput = z.object({
  newEndDate: date,
  /** For new-contract renewals: template of the new contract (defaults to the current one). */
  templateId: z.uuid().nullable().default(null),
});

export const signInput = z.object({
  /** sha256 (hex) of the text the signer saw; must match the stored version. */
  documentHash: z.string().regex(/^[0-9a-f]{64}$/),
  typedName: z.string().trim().min(3).max(200),
  consent: z.literal(true),
});

export const endContractInput = z.object({ endDate: date, reason: z.string().trim().min(3).max(500) });
export const probationOutcomeInput = z.object({
  outcome: z.enum(['confirmed', 'extended', 'not_confirmed']),
  newProbationEnd: date.nullable().default(null),
  note: z.string().trim().min(3).max(500),
});

export const contractSearchQuery = z.object({
  companyId: z.uuid().optional(),
  status: z.enum(CONTRACT_STATUSES).optional(),
  contractTypeId: z.uuid().optional(),
  /** Active contracts ending within N days. */
  expiringWithin: z.coerce.number().int().min(1).max(365).optional(),
  q: z.string().trim().max(100).optional(),
});

export interface ContractTemplateDto {
  id: string;
  companyId: string | null;
  contractTypeId: string;
  code: string;
  name: string;
  language: 'ar' | 'en';
  body: string;
  fields: z.infer<typeof templateFieldSchema>[];
  status: 'active' | 'inactive';
}

export interface ContractClauseDto {
  id: string;
  companyId: string | null;
  code: string;
  title: string;
  language: 'ar' | 'en';
  body: string;
  status: 'active' | 'inactive';
}

export interface SignatureDto {
  id: string;
  role: SignerRole;
  status: 'pending' | 'signed';
  method: 'in_app' | 'upload' | 'system' | null;
  signerName: string | null;
  typedName: string | null;
  signedAt: string | null;
  ip: string | null;
  userAgent: string | null;
  documentHash: string | null;
  /** May the current user sign this now? */
  canSign: boolean;
}

export interface ContractVersionDto {
  id: string;
  versionNo: number;
  kind: VersionKind;
  status: VersionStatus;
  language: 'ar' | 'en';
  body: string;
  bodySha256: string;
  effectiveDate: string;
  endDate: string | null;
  signedCopyId: string | null;
  lockedAt: string | null;
  createdAt: string;
  signatures: SignatureDto[];
}

export interface ContractSummaryDto {
  id: string;
  contractNo: string;
  companyId: string;
  employeeId: string;
  employeeNo: string;
  employeeName: { ar: string; en: string };
  contractTypeId: string;
  status: ContractStatus;
  startDate: string;
  endDate: string | null;
  probationEnd: string | null;
  probationOutcome: string | null;
  renewalOfId: string | null;
  renewedById: string | null;
}

export interface ContractDto extends ContractSummaryDto {
  templateId: string | null;
  endReason: string | null;
  versions: ContractVersionDto[];
}

