/**
 * Drizzle table definitions mirroring migrations/*.sql (the SQL files are the source of
 * truth; test/schema-drift.test.ts checks that both agree).
 */
import {
  bigint,
  boolean,
  char,
  customType,
  date,
  inet,
  integer,
  jsonb,
  numeric,
  pgTable,
  pgView,
  primaryKey,
  text,
  time,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

export const citext = customType<{ data: string }>({ dataType: () => 'citext' });
export const bytea = customType<{ data: Buffer; driverData: Buffer | Uint8Array }>({
  dataType: () => 'bytea',
  fromDriver: (v) => (Buffer.isBuffer(v) ? v : Buffer.from(v)),
  toDriver: (v) => v,
});

const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

const audited = {
  createdAt: tstz('created_at').notNull().defaultNow(),
  createdBy: uuid('created_by'),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
  updatedBy: uuid('updated_by'),
  version: integer('version').notNull().default(1),
};

export const companyGroup = pgTable('company_group', {
  id: uuid('id').primaryKey(),
  nameAr: text('name_ar').notNull(),
  nameEn: text('name_en').notNull(),
  createdAt: tstz('created_at').notNull().defaultNow(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
  updatedBy: uuid('updated_by'),
  version: integer('version').notNull().default(1),
});

export const company = pgTable('company', {
  id: uuid('id').primaryKey(),
  groupId: uuid('group_id').notNull(),
  code: citext('code').notNull(),
  nameAr: text('name_ar').notNull(),
  nameEn: text('name_en').notNull(),
  status: text('status').$type<'active' | 'inactive'>().notNull().default('active'),
  ...audited,
});

export const department = pgTable('department', {
  id: uuid('id').primaryKey(),
  companyId: uuid('company_id').notNull(),
  parentId: uuid('parent_id'),
  code: citext('code').notNull(),
  nameAr: text('name_ar').notNull(),
  nameEn: text('name_en').notNull(),
  status: text('status').$type<'active' | 'inactive'>().notNull().default('active'),
  ...audited,
});

export const workLocation = pgTable('work_location', {
  id: uuid('id').primaryKey(),
  companyId: uuid('company_id').notNull(),
  code: citext('code').notNull(),
  nameAr: text('name_ar').notNull(),
  nameEn: text('name_en').notNull(),
  address: text('address'),
  status: text('status').$type<'active' | 'inactive'>().notNull().default('active'),
  ...audited,
});

export const userAccount = pgTable('user_account', {
  id: uuid('id').primaryKey(),
  username: citext('username').notNull(),
  displayName: text('display_name').notNull(),
  email: citext('email'),
  status: text('status').$type<'active' | 'disabled'>().notNull().default('active'),
  passwordHash: text('password_hash').notNull(),
  passwordChangedAt: tstz('password_changed_at').notNull().defaultNow(),
  mustChangePassword: boolean('must_change_password').notNull().default(false),
  failedLoginCount: integer('failed_login_count').notNull().default(0),
  lockedUntil: tstz('locked_until'),
  lastLoginAt: tstz('last_login_at'),
  totpSecretEnc: bytea('totp_secret_enc'),
  totpPendingEnc: bytea('totp_pending_enc'),
  totpEnabledAt: tstz('totp_enabled_at'),
  totpLastStep: bigint('totp_last_step', { mode: 'number' }),
  employeeId: uuid('employee_id'),
  isSeed: boolean('is_seed').notNull().default(false),
  ...audited,
});

export const mfaRecoveryCode = pgTable('mfa_recovery_code', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull(),
  codeHash: bytea('code_hash').notNull(),
  createdAt: tstz('created_at').notNull().defaultNow(),
  usedAt: tstz('used_at'),
});

export const session = pgTable('session', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull(),
  tokenHash: bytea('token_hash').notNull(),
  createdAt: tstz('created_at').notNull().defaultNow(),
  lastSeenAt: tstz('last_seen_at').notNull().defaultNow(),
  expiresAt: tstz('expires_at').notNull(),
  ip: inet('ip'),
  userAgent: text('user_agent'),
  mfaVerifiedAt: tstz('mfa_verified_at'),
  mfaFailedAttempts: integer('mfa_failed_attempts').notNull().default(0),
  revokedAt: tstz('revoked_at'),
  revokedReason: text('revoked_reason'),
});

export const permission = pgTable('permission', {
  key: text('key').primaryKey(),
  module: text('module').notNull(),
  sensitivity: text('sensitivity').$type<'normal' | 'security'>().notNull(),
  groupOnly: boolean('group_only').notNull(),
  labelAr: text('label_ar').notNull(),
  labelEn: text('label_en').notNull(),
});

export const role = pgTable('role', {
  id: uuid('id').primaryKey(),
  key: citext('key').notNull(),
  nameAr: text('name_ar').notNull(),
  nameEn: text('name_en').notNull(),
  description: text('description'),
  isSystem: boolean('is_system').notNull().default(false),
  ...audited,
});

export const rolePermission = pgTable(
  'role_permission',
  {
    roleId: uuid('role_id').notNull(),
    permissionKey: text('permission_key').notNull(),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.permissionKey] })],
);

export const roleAssignment = pgTable('role_assignment', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull(),
  roleId: uuid('role_id').notNull(),
  scopeType: text('scope_type').$type<'GROUP' | 'COMPANY' | 'DEPARTMENT' | 'SELF'>().notNull(),
  companyId: uuid('company_id'),
  departmentId: uuid('department_id'),
  validFrom: date('valid_from', { mode: 'string' }).notNull().defaultNow(),
  validTo: date('valid_to', { mode: 'string' }),
  createdAt: tstz('created_at').notNull().defaultNow(),
  createdBy: uuid('created_by'),
  endedAt: tstz('ended_at'),
  endedBy: uuid('ended_by'),
});

export const settingValue = pgTable('setting_value', {
  id: uuid('id').primaryKey(),
  key: text('key').notNull(),
  companyId: uuid('company_id'),
  value: jsonb('value').notNull(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
  updatedBy: uuid('updated_by'),
  version: integer('version').notNull().default(1),
});

export const moduleTable = pgTable('module', {
  key: text('key').primaryKey(),
  groupEnabled: boolean('group_enabled').notNull().default(true),
  disablePolicy: text('disable_policy').$type<'read_only' | 'hidden'>().notNull().default('read_only'),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
  updatedBy: uuid('updated_by'),
});

export const moduleCompanyState = pgTable(
  'module_company_state',
  {
    moduleKey: text('module_key').notNull(),
    companyId: uuid('company_id').notNull(),
    enabled: boolean('enabled').notNull(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
    updatedBy: uuid('updated_by'),
  },
  (t) => [primaryKey({ columns: [t.moduleKey, t.companyId] })],
);

export const auditEvent = pgTable('audit_event', {
  id: bigint('id', { mode: 'number' }).primaryKey(),
  at: tstz('at').notNull(),
  actorUserId: uuid('actor_user_id'),
  actorUsername: text('actor_username'),
  sessionId: uuid('session_id'),
  action: text('action').notNull(),
  entityType: text('entity_type'),
  entityId: text('entity_id'),
  companyId: uuid('company_id'),
  before: jsonb('before'),
  after: jsonb('after'),
  ip: inet('ip'),
  userAgent: text('user_agent'),
  outcome: text('outcome').$type<'success' | 'denied' | 'failure'>().notNull(),
  details: jsonb('details'),
  prevHash: bytea('prev_hash'),
  hash: bytea('hash').notNull(),
});

export const backupRun = pgTable('backup_run', {
  id: uuid('id').primaryKey(),
  kind: text('kind').$type<'manual' | 'scheduled' | 'restore_test'>().notNull(),
  status: text('status').$type<'requested' | 'running' | 'succeeded' | 'failed'>().notNull(),
  requestedBy: uuid('requested_by'),
  createdAt: tstz('created_at').notNull().defaultNow(),
  startedAt: tstz('started_at'),
  finishedAt: tstz('finished_at'),
  objectKey: text('object_key'),
  sizeBytes: bigint('size_bytes', { mode: 'number' }),
  sha256: bytea('sha256'),
  schemaVersion: text('schema_version'),
  details: jsonb('details'),
  error: text('error'),
});

// --- Phase 2: employees & documents -----------------------------------------------

export const lookupValue = pgTable('lookup_value', {
  id: uuid('id').primaryKey(),
  kind: text('kind')
    .$type<'job_title' | 'employment_category' | 'contract_type' | 'allowance_type' | 'deduction_type'>()
    .notNull(),
  companyId: uuid('company_id'),
  code: citext('code').notNull(),
  nameAr: text('name_ar').notNull(),
  nameEn: text('name_en').notNull(),
  status: text('status').$type<'active' | 'inactive'>().notNull().default('active'),
  ...audited,
});

export const employeeNumberSequence = pgTable('employee_number_sequence', {
  singleton: boolean('singleton').primaryKey(),
  nextValue: bigint('next_value', { mode: 'number' }).notNull(),
});

export const employee = pgTable('employee', {
  id: uuid('id').primaryKey(),
  employeeNo: text('employee_no').notNull(),
  fullNameAr: text('full_name_ar').notNull(),
  fullNameEn: text('full_name_en').notNull(),
  idType: text('id_type').$type<'national_id' | 'passport'>(),
  idNumberEnc: bytea('id_number_enc'),
  idNumberBidx: bytea('id_number_bidx'),
  birthDate: date('birth_date', { mode: 'string' }),
  gender: text('gender').$type<'male' | 'female'>(),
  nationality: text('nationality'),
  maritalStatus: text('marital_status').$type<'single' | 'married' | 'divorced' | 'widowed'>(),
  phone: text('phone'),
  email: citext('email'),
  hireDate: date('hire_date', { mode: 'string' }).notNull(),
  actualStartDate: date('actual_start_date', { mode: 'string' }),
  probationEndDate: date('probation_end_date', { mode: 'string' }),
  status: text('status')
    .$type<'probation' | 'active' | 'suspended' | 'long_leave' | 'terminated'>()
    .notNull()
    .default('active'),
  photoDocumentId: uuid('photo_document_id'),
  isSeed: boolean('is_seed').notNull().default(false),
  ...audited,
});

const assignmentColumns = () => ({
  id: uuid('id').primaryKey(),
  employeeId: uuid('employee_id').notNull(),
  companyId: uuid('company_id').notNull(),
  departmentId: uuid('department_id'),
  jobTitleId: uuid('job_title_id'),
  managerEmployeeId: uuid('manager_employee_id'),
  workLocationId: uuid('work_location_id'),
  employmentCategoryId: uuid('employment_category_id'),
  contractTypeId: uuid('contract_type_id'),
  contractStart: date('contract_start', { mode: 'string' }),
  contractEnd: date('contract_end', { mode: 'string' }),
  validFrom: date('valid_from', { mode: 'string' }).notNull(),
  validTo: date('valid_to', { mode: 'string' }),
  changeReason: text('change_reason'),
  createdAt: tstz('created_at').notNull().defaultNow(),
  createdBy: uuid('created_by'),
});

export const employmentAssignment = pgTable('employment_assignment', assignmentColumns());

/** Current (or upcoming) assignment per employee (security_invoker view). */
export const employeeCurrentAssignment = pgView('employee_current_assignment', assignmentColumns()).existing();

export const compensation = pgTable('compensation', {
  id: uuid('id').primaryKey(),
  employeeId: uuid('employee_id').notNull(),
  companyId: uuid('company_id').notNull(),
  baseSalary: numeric('base_salary', { precision: 18, scale: 4 }).notNull(),
  currency: char('currency', { length: 3 }).notNull(),
  paymentMethod: text('payment_method').$type<'bank_transfer' | 'cash' | 'cheque'>().notNull(),
  validFrom: date('valid_from', { mode: 'string' }).notNull(),
  validTo: date('valid_to', { mode: 'string' }),
  changeReason: text('change_reason'),
  createdAt: tstz('created_at').notNull().defaultNow(),
  createdBy: uuid('created_by'),
});

export const compensationItem = pgTable('compensation_item', {
  id: uuid('id').primaryKey(),
  compensationId: uuid('compensation_id').notNull(),
  kind: text('kind').$type<'allowance' | 'deduction'>().notNull(),
  typeId: uuid('type_id').notNull(),
  calc: text('calc').$type<'fixed' | 'percent_of_base'>().notNull().default('fixed'),
  amount: numeric('amount', { precision: 18, scale: 4 }).notNull(),
});

export const bankAccount = pgTable('bank_account', {
  id: uuid('id').primaryKey(),
  employeeId: uuid('employee_id').notNull(),
  bankName: text('bank_name').notNull(),
  accountNoEnc: bytea('account_no_enc'),
  ibanEnc: bytea('iban_enc'),
  isPrimary: boolean('is_primary').notNull().default(true),
  status: text('status').$type<'active' | 'inactive'>().notNull().default('active'),
  ...audited,
});

export const qualification = pgTable('qualification', {
  id: uuid('id').primaryKey(),
  employeeId: uuid('employee_id').notNull(),
  level: text('level')
    .$type<'secondary' | 'diploma' | 'bachelor' | 'master' | 'doctorate' | 'professional' | 'other'>()
    .notNull(),
  specialization: text('specialization'),
  institution: text('institution'),
  country: text('country'),
  graduationYear: integer('graduation_year'),
  status: text('status').$type<'active' | 'deleted'>().notNull().default('active'),
  ...audited,
});

export const lifecycleEvent = pgTable('lifecycle_event', {
  id: uuid('id').primaryKey(),
  employeeId: uuid('employee_id').notNull(),
  companyId: uuid('company_id'),
  type: text('type').notNull(),
  effectiveDate: date('effective_date', { mode: 'string' }).notNull(),
  details: jsonb('details').$type<Record<string, unknown>>().notNull(),
  createdAt: tstz('created_at').notNull().defaultNow(),
  createdBy: uuid('created_by'),
});

export const documentCategory = pgTable('document_category', {
  id: uuid('id').primaryKey(),
  code: citext('code').notNull(),
  nameAr: text('name_ar').notNull(),
  nameEn: text('name_en').notNull(),
  allowedTypes: text('allowed_types').array().notNull(),
  maxSizeMb: integer('max_size_mb').notNull(),
  sensitivity: text('sensitivity').$type<'normal' | 'restricted' | 'medical'>().notNull(),
  employeeVisible: boolean('employee_visible').notNull(),
  allowReplace: boolean('allow_replace').notNull(),
  allowDelete: boolean('allow_delete').notNull(),
  hasExpiry: boolean('has_expiry').notNull(),
  retentionYears: integer('retention_years'),
  status: text('status').$type<'active' | 'inactive'>().notNull().default('active'),
  ...audited,
});

export const storedObject = pgTable('stored_object', {
  id: uuid('id').primaryKey(),
  provider: text('provider').notNull(),
  objectKey: text('object_key').notNull(),
  mime: text('mime').notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
  sha256: bytea('sha256').notNull(),
  encKeyId: text('enc_key_id').notNull(),
  createdAt: tstz('created_at').notNull().defaultNow(),
  createdBy: uuid('created_by'),
});

export const document = pgTable('document', {
  id: uuid('id').primaryKey(),
  companyId: uuid('company_id').notNull(),
  categoryId: uuid('category_id').notNull(),
  objectId: uuid('object_id').notNull(),
  title: text('title').notNull(),
  originalName: text('original_name').notNull(),
  expiryDate: date('expiry_date', { mode: 'string' }),
  status: text('status').$type<'active' | 'superseded' | 'deleted'>().notNull().default('active'),
  supersedesId: uuid('supersedes_id'),
  deletedAt: tstz('deleted_at'),
  deletedBy: uuid('deleted_by'),
  ...audited,
});

export const documentLink = pgTable(
  'document_link',
  {
    documentId: uuid('document_id').notNull(),
    entityType: text('entity_type').$type<'employee'>().notNull(),
    entityId: uuid('entity_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.documentId, t.entityType, t.entityId] })],
);

// --- Phase 3: workflow, notifications, calendar, restore -----------------------------

export const workflowDefinition = pgTable('workflow_definition', {
  id: uuid('id').primaryKey(),
  key: text('key').notNull(),
  subjectType: text('subject_type').notNull(),
  nameAr: text('name_ar').notNull(),
  nameEn: text('name_en').notNull(),
  locked: boolean('locked').notNull().default(false),
  createdAt: tstz('created_at').notNull().defaultNow(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
  updatedBy: uuid('updated_by'),
  version: integer('version').notNull().default(1),
});

export const workflowStep = pgTable('workflow_step', {
  id: uuid('id').primaryKey(),
  definitionId: uuid('definition_id').notNull(),
  seq: integer('seq').notNull(),
  approverRule: text('approver_rule').$type<'direct_manager' | 'role_in_company' | 'specific_user'>().notNull(),
  roleKey: text('role_key'),
  userId: uuid('user_id'),
  skipIfUnresolved: boolean('skip_if_unresolved').notNull().default(true),
  nameAr: text('name_ar').notNull(),
  nameEn: text('name_en').notNull(),
});

export const workflowInstance = pgTable('workflow_instance', {
  id: uuid('id').primaryKey(),
  definitionId: uuid('definition_id').notNull(),
  companyId: uuid('company_id').notNull(),
  subjectType: text('subject_type').notNull(),
  subjectId: uuid('subject_id').notNull(),
  subjectEmployeeId: uuid('subject_employee_id'),
  requesterUserId: uuid('requester_user_id').notNull(),
  summary: jsonb('summary').$type<Record<string, unknown>>().notNull(),
  status: text('status').$type<'pending' | 'approved' | 'rejected' | 'cancelled'>().notNull().default('pending'),
  currentSeq: integer('current_seq').notNull().default(1),
  createdAt: tstz('created_at').notNull().defaultNow(),
  completedAt: tstz('completed_at'),
});

export const workflowTask = pgTable('workflow_task', {
  id: uuid('id').primaryKey(),
  instanceId: uuid('instance_id').notNull(),
  seq: integer('seq').notNull(),
  assigneeUserId: uuid('assignee_user_id'),
  delegatedFromUserId: uuid('delegated_from_user_id'),
  status: text('status').$type<'pending' | 'approved' | 'rejected' | 'skipped' | 'cancelled'>().notNull().default('pending'),
  decidedAt: tstz('decided_at'),
  decidedBy: uuid('decided_by'),
  comment: text('comment'),
  createdAt: tstz('created_at').notNull().defaultNow(),
});

export const workflowDelegation = pgTable('workflow_delegation', {
  id: uuid('id').primaryKey(),
  fromUserId: uuid('from_user_id').notNull(),
  toUserId: uuid('to_user_id').notNull(),
  validFrom: date('valid_from', { mode: 'string' }).notNull(),
  validTo: date('valid_to', { mode: 'string' }).notNull(),
  createdAt: tstz('created_at').notNull().defaultNow(),
  revokedAt: tstz('revoked_at'),
});

export const notification = pgTable('notification', {
  id: uuid('id').primaryKey(),
  companyId: uuid('company_id'),
  eventType: text('event_type').notNull(),
  titleAr: text('title_ar').notNull(),
  titleEn: text('title_en').notNull(),
  bodyAr: text('body_ar').notNull().default(''),
  bodyEn: text('body_en').notNull().default(''),
  link: text('link'),
  entityType: text('entity_type'),
  entityId: uuid('entity_id'),
  createdAt: tstz('created_at').notNull().defaultNow(),
});

export const notificationRecipient = pgTable(
  'notification_recipient',
  {
    notificationId: uuid('notification_id').notNull(),
    userId: uuid('user_id').notNull(),
    readAt: tstz('read_at'),
    pushSentAt: tstz('push_sent_at'),
  },
  (t) => [primaryKey({ columns: [t.notificationId, t.userId] })],
);

export const pushSubscription = pgTable('push_subscription', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull(),
  endpoint: text('endpoint').notNull(),
  p256dh: text('p256dh').notNull(),
  auth: text('auth').notNull(),
  userAgent: text('user_agent'),
  createdAt: tstz('created_at').notNull().defaultNow(),
  lastSuccessAt: tstz('last_success_at'),
  failureCount: integer('failure_count').notNull().default(0),
  revokedAt: tstz('revoked_at'),
});

export const systemSecret = pgTable('system_secret', {
  key: text('key').primaryKey(),
  valueEnc: bytea('value_enc').notNull(),
  createdAt: tstz('created_at').notNull().defaultNow(),
});

export const workSchedule = pgTable('work_schedule', {
  id: uuid('id').primaryKey(),
  companyId: uuid('company_id'),
  code: citext('code').notNull(),
  nameAr: text('name_ar').notNull(),
  nameEn: text('name_en').notNull(),
  graceInMinutes: integer('grace_in_minutes').notNull().default(0),
  graceOutMinutes: integer('grace_out_minutes').notNull().default(0),
  status: text('status').$type<'active' | 'inactive'>().notNull().default('active'),
  ...audited,
});

export const scheduleDay = pgTable(
  'schedule_day',
  {
    scheduleId: uuid('schedule_id').notNull(),
    isoWeekday: integer('iso_weekday').notNull(),
    isWorkday: boolean('is_workday').notNull(),
    startTime: time('start_time'),
    endTime: time('end_time'),
    breaks: jsonb('breaks').$type<{ startTime: string; endTime: string; paid: boolean }[]>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.scheduleId, t.isoWeekday] })],
);

export const scheduleAssignment = pgTable('schedule_assignment', {
  id: uuid('id').primaryKey(),
  scheduleId: uuid('schedule_id').notNull(),
  targetType: text('target_type').$type<'company' | 'department' | 'employee'>().notNull(),
  companyId: uuid('company_id').notNull(),
  departmentId: uuid('department_id'),
  employeeId: uuid('employee_id'),
  validFrom: date('valid_from', { mode: 'string' }).notNull(),
  validTo: date('valid_to', { mode: 'string' }),
  createdAt: tstz('created_at').notNull().defaultNow(),
  createdBy: uuid('created_by'),
  endedAt: tstz('ended_at'),
  endedBy: uuid('ended_by'),
});

export const holiday = pgTable('holiday', {
  id: uuid('id').primaryKey(),
  companyId: uuid('company_id'),
  date: date('date', { mode: 'string' }).notNull(),
  nameAr: text('name_ar').notNull(),
  nameEn: text('name_en').notNull(),
  createdAt: tstz('created_at').notNull().defaultNow(),
  createdBy: uuid('created_by'),
});

export const restoreRequest = pgTable('restore_request', {
  id: uuid('id').primaryKey(),
  backupRunId: uuid('backup_run_id').notNull(),
  status: text('status')
    .$type<'awaiting_approval' | 'requested' | 'preparing' | 'ready' | 'switching' | 'completed' | 'failed' | 'cancelled'>()
    .notNull(),
  requestedBy: uuid('requested_by').notNull(),
  approvedBy: uuid('approved_by'),
  switchConfirmedBy: uuid('switch_confirmed_by'),
  scratchDatabase: text('scratch_database'),
  preRestoreBackupId: uuid('pre_restore_backup_id'),
  details: jsonb('details').$type<Record<string, unknown>>().notNull(),
  error: text('error'),
  createdAt: tstz('created_at').notNull().defaultNow(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
});

export const schema = {
  companyGroup,
  company,
  department,
  workLocation,
  userAccount,
  mfaRecoveryCode,
  session,
  permission,
  role,
  rolePermission,
  roleAssignment,
  settingValue,
  moduleTable,
  moduleCompanyState,
  auditEvent,
  backupRun,
  lookupValue,
  employeeNumberSequence,
  employee,
  employmentAssignment,
  compensation,
  compensationItem,
  bankAccount,
  qualification,
  lifecycleEvent,
  documentCategory,
  storedObject,
  document,
  documentLink,
  workflowDefinition,
  workflowStep,
  workflowInstance,
  workflowTask,
  workflowDelegation,
  notification,
  notificationRecipient,
  pushSubscription,
  systemSecret,
  workSchedule,
  scheduleDay,
  scheduleAssignment,
  holiday,
  restoreRequest,
};
