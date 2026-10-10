import { z } from 'zod';

/** Phase 2: employees, master lists (lookups) and documents. */

export const GENDERS = ['male', 'female'] as const;
export const MARITAL_STATUSES = ['single', 'married', 'divorced', 'widowed'] as const;
export const ID_TYPES = ['national_id', 'passport'] as const;
/** 'terminated' is reached only through the separation workflow (Phase 8). */
export const EMPLOYEE_STATUSES = ['probation', 'active', 'suspended', 'long_leave', 'terminated'] as const;
export const SETTABLE_STATUSES = ['probation', 'active', 'suspended', 'long_leave'] as const;
export const PAYMENT_METHODS = ['bank_transfer', 'cash', 'cheque'] as const;
export const QUALIFICATION_LEVELS = [
  'secondary',
  'diploma',
  'bachelor',
  'master',
  'doctorate',
  'professional',
  'other',
] as const;
export const LOOKUP_KINDS = [
  'job_title',
  'employment_category',
  'contract_type',
  'allowance_type',
  'deduction_type',
] as const;
export const ASSIGNMENT_EVENTS = [
  'transfer',
  'department_change',
  'job_change',
  'manager_change',
  'location_change',
  'contract_change',
  'promotion',
] as const;
export const COMPENSATION_EVENTS = ['salary_change', 'promotion'] as const;
export const DOCUMENT_TYPES = ['pdf', 'jpg', 'png', 'webp', 'docx', 'xlsx'] as const;
export const DOCUMENT_SENSITIVITIES = ['normal', 'restricted', 'medical'] as const;

export type EmployeeStatus = (typeof EMPLOYEE_STATUSES)[number];
export type LookupKind = (typeof LOOKUP_KINDS)[number];
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

const name = z.string().trim().min(1).max(200);
const optText = (max: number) => z.string().trim().max(max).nullable().optional();
const isoDate = z.iso.date();
const money = z
  .string()
  .trim()
  .regex(/^\d{1,14}(\.\d{1,4})?$/, 'Positive amount with up to 4 decimals');
const currency = z.string().regex(/^[A-Z]{3}$/);
const uuid = z.uuid();

export const personalInput = z.object({
  fullNameAr: name,
  fullNameEn: name,
  idType: z.enum(ID_TYPES).nullable().optional(),
  idNumber: z
    .string()
    .trim()
    .max(40)
    .regex(/^[A-Za-z0-9-]*$/)
    .nullable()
    .optional(),
  birthDate: isoDate.nullable().optional(),
  gender: z.enum(GENDERS).nullable().optional(),
  nationality: z
    .string()
    .regex(/^[A-Z]{2}$/, 'ISO 3166 country code')
    .nullable()
    .optional(),
  maritalStatus: z.enum(MARITAL_STATUSES).nullable().optional(),
  phone: z
    .string()
    .trim()
    .max(30)
    .regex(/^[+0-9 ()-]*$/)
    .nullable()
    .optional(),
  email: z.email().max(254).nullable().optional(),
});

export const assignmentFields = z.object({
  companyId: uuid,
  departmentId: uuid.nullable().optional(),
  jobTitleId: uuid.nullable().optional(),
  managerEmployeeId: uuid.nullable().optional(),
  workLocationId: uuid.nullable().optional(),
  employmentCategoryId: uuid.nullable().optional(),
  contractTypeId: uuid.nullable().optional(),
  contractStart: isoDate.nullable().optional(),
  contractEnd: isoDate.nullable().optional(),
});

export const compensationItemInput = z.object({
  kind: z.enum(['allowance', 'deduction']),
  typeId: uuid,
  calc: z.enum(['fixed', 'percent_of_base']).default('fixed'),
  amount: money,
});

export const compensationFields = z.object({
  baseSalary: money,
  currency,
  paymentMethod: z.enum(PAYMENT_METHODS),
  items: z.array(compensationItemInput).max(30).default([]),
});

export const bankAccountInput = z.object({
  bankName: z.string().trim().min(1).max(120),
  accountNumber: z
    .string()
    .trim()
    .max(40)
    .regex(/^[A-Za-z0-9 -]*$/)
    .nullable()
    .optional(),
  iban: z
    .string()
    .trim()
    .transform((v) => v.replace(/\s+/g, '').toUpperCase())
    .pipe(z.string().regex(/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/, 'Invalid IBAN'))
    .nullable()
    .optional(),
  isPrimary: z.boolean().default(true),
});

export const employeeCreateInput = z.object({
  personal: personalInput,
  hireDate: isoDate,
  actualStartDate: isoDate.nullable().optional(),
  probationEndDate: isoDate.nullable().optional(),
  assignment: assignmentFields,
  compensation: compensationFields.optional(),
  bankAccount: bankAccountInput.optional(),
});

export const personalUpdateInput = personalInput.partial().extend({
  actualStartDate: isoDate.nullable().optional(),
  probationEndDate: isoDate.nullable().optional(),
  version: z.number().int().positive(),
});

export const assignmentChangeInput = assignmentFields.extend({
  effectiveDate: isoDate,
  event: z.enum(ASSIGNMENT_EVENTS),
  reason: z.string().trim().min(1).max(1000),
});

export const compensationChangeInput = compensationFields.extend({
  effectiveDate: isoDate,
  event: z.enum(COMPENSATION_EVENTS),
  reason: z.string().trim().min(1).max(1000),
});

export const statusChangeInput = z.object({
  status: z.enum(SETTABLE_STATUSES),
  effectiveDate: isoDate,
  reason: z.string().trim().min(1).max(1000),
});

export const qualificationInput = z.object({
  level: z.enum(QUALIFICATION_LEVELS),
  specialization: optText(200),
  institution: optText(200),
  country: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .nullable()
    .optional(),
  graduationYear: z.number().int().min(1950).max(2100).nullable().optional(),
});

export const linkUserInput = z.object({ userId: uuid.nullable() });

export const lookupCreateInput = z.object({
  kind: z.enum(LOOKUP_KINDS),
  companyId: uuid.nullable().optional(),
  code: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .regex(/^[A-Za-z0-9_-]+$/),
  nameAr: name,
  nameEn: name,
});
export const lookupUpdateInput = z.object({
  nameAr: name.optional(),
  nameEn: name.optional(),
  status: z.enum(['active', 'inactive']).optional(),
  version: z.number().int().positive(),
});

export const documentCategoryInput = z.object({
  code: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .regex(/^[a-z0-9_-]+$/),
  nameAr: name,
  nameEn: name,
  allowedTypes: z.array(z.enum(DOCUMENT_TYPES)).min(1),
  maxSizeMb: z.number().int().min(1).max(50),
  sensitivity: z.enum(DOCUMENT_SENSITIVITIES),
  employeeVisible: z.boolean(),
  allowReplace: z.boolean(),
  allowDelete: z.boolean(),
  hasExpiry: z.boolean(),
  retentionYears: z.number().int().min(1).max(100).nullable().optional(),
});
export const documentCategoryUpdateInput = documentCategoryInput
  .omit({ code: true })
  .partial()
  .extend({
    status: z.enum(['active', 'inactive']).optional(),
    version: z.number().int().positive(),
  });

/** Multipart form fields accompanying an uploaded file. */
export const documentUploadFields = z.object({
  categoryId: uuid,
  title: z.string().trim().min(1).max(200),
  expiryDate: isoDate.optional().or(z.literal('').transform(() => undefined)),
});

export const employeeListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  companyId: uuid.optional(),
  departmentId: uuid.optional(),
  status: z.enum(EMPLOYEE_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

// --- DTOs -------------------------------------------------------------------------

export interface LookupDto {
  id: string;
  kind: LookupKind;
  companyId: string | null;
  code: string;
  nameAr: string;
  nameEn: string;
  status: 'active' | 'inactive';
  version: number;
}

export interface AssignmentRecordDto {
  id: string;
  companyId: string;
  departmentId: string | null;
  jobTitleId: string | null;
  managerEmployeeId: string | null;
  workLocationId: string | null;
  employmentCategoryId: string | null;
  contractTypeId: string | null;
  contractStart: string | null;
  contractEnd: string | null;
  validFrom: string;
  validTo: string | null;
  changeReason: string | null;
}

export interface CompensationDto {
  id: string;
  companyId: string;
  baseSalary: string;
  currency: string;
  paymentMethod: (typeof PAYMENT_METHODS)[number];
  items: { kind: 'allowance' | 'deduction'; typeId: string; calc: 'fixed' | 'percent_of_base'; amount: string }[];
  validFrom: string;
  validTo: string | null;
  changeReason: string | null;
}

export interface BankAccountDto {
  id: string;
  bankName: string;
  accountNumber: string | null;
  iban: string | null;
  isPrimary: boolean;
  status: 'active' | 'inactive';
  version: number;
}

export interface QualificationDto {
  id: string;
  level: (typeof QUALIFICATION_LEVELS)[number];
  specialization: string | null;
  institution: string | null;
  country: string | null;
  graduationYear: number | null;
  version: number;
}

export interface EmployeeSummaryDto {
  id: string;
  employeeNo: string;
  fullNameAr: string;
  fullNameEn: string;
  status: EmployeeStatus;
  companyId: string | null;
  departmentId: string | null;
  jobTitleId: string | null;
  hireDate: string;
  hasPhoto: boolean;
}

export interface EmployeeDto extends EmployeeSummaryDto {
  idType: (typeof ID_TYPES)[number] | null;
  /** Full number only with employee.identity.view; otherwise masked (last 3 characters). */
  idNumber: string | null;
  idNumberMasked: boolean;
  birthDate: string | null;
  gender: (typeof GENDERS)[number] | null;
  nationality: string | null;
  maritalStatus: (typeof MARITAL_STATUSES)[number] | null;
  phone: string | null;
  email: string | null;
  actualStartDate: string | null;
  probationEndDate: string | null;
  photoDocumentId: string | null;
  linkedUserId: string | null;
  current: AssignmentRecordDto | null;
  /** Present only with financial permission, or for the employee themself (current only). */
  compensation: CompensationDto | null;
  access: {
    financial: boolean;
    editPersonal: boolean;
    manageLifecycle: boolean;
    editFinancial: boolean;
    self: boolean;
  };
  version: number;
}

export interface LifecycleEventDto {
  id: string;
  type: string;
  companyId: string | null;
  effectiveDate: string;
  details: Record<string, unknown>;
  createdAt: string;
  createdBy: string | null;
}

export interface EmployeeHistoryDto {
  assignments: AssignmentRecordDto[];
  compensation: CompensationDto[] | null;
  events: LifecycleEventDto[];
  /** True when rows from other companies were hidden (cross-company permission missing). */
  partial: boolean;
}

export interface DocumentCategoryDto {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  allowedTypes: DocumentType[];
  maxSizeMb: number;
  sensitivity: (typeof DOCUMENT_SENSITIVITIES)[number];
  employeeVisible: boolean;
  allowReplace: boolean;
  allowDelete: boolean;
  hasExpiry: boolean;
  retentionYears: number | null;
  status: 'active' | 'inactive';
  version: number;
}

export interface DocumentDto {
  id: string;
  companyId: string;
  categoryId: string;
  title: string;
  originalName: string;
  mime: string;
  sizeBytes: number;
  expiryDate: string | null;
  status: 'active' | 'superseded' | 'deleted';
  supersedesId: string | null;
  createdAt: string;
  createdBy: string | null;
}
