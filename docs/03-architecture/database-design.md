# Database Design & ERD (PostgreSQL 17)

Status: **Proposed**. This is a logical design. Exact columns are finalised in each phase's migration, reviewed against this document, and this document is then updated.

## 1. Conventions

| Topic | Rule |
|---|---|
| Keys | `uuid` primary keys (UUIDv7, time-ordered). Human-facing numbers (employee no., contract no.) are separate unique columns |
| Company scope | Every company-scoped table has `company_id NOT NULL` with an RLS policy (see authorization-model.md) |
| Group scope | Group-level reference tables (leave types, pay components, roles) carry `company_id NULL` = group default, or a value for a company override |
| History | Effective-dated tables have `valid_from date NOT NULL, valid_to date NULL` plus an `EXCLUDE USING gist (employee_id WITH =, daterange(valid_from, valid_to) WITH &&)` constraint, so periods cannot overlap |
| Audit columns | `created_at, created_by, updated_at, updated_by, version int` on mutable tables |
| Soft delete | `deleted_at` only where a recovery policy exists (documents, drafts). Core HR records are never hard-deleted by the application |
| Money | `numeric(18,4)` plus `currency char(3)` (ISO 4217) |
| Time | `timestamptz` (UTC). `date` for work dates and effective dates |
| Encrypted fields | `bytea` ciphertext + `key_id`. A deterministic HMAC "blind index" column where exact-match search is needed (for example national ID) |
| Enumerations | PostgreSQL `text` + CHECK constraint, or lookup tables when admins can configure them |
| Bilingual text | `name_ar`, `name_en` where Q-06 requires it |
| Locking | Immutability of locked rows (approved payroll, signed contracts, audit) enforced by triggers |

## 2. ERD — Platform (organisation, identity, access, settings, audit)

```mermaid
erDiagram
  COMPANY_GROUP ||--o{ COMPANY : has
  COMPANY ||--o{ DEPARTMENT : "has (optional)"
  DEPARTMENT ||--o{ DEPARTMENT : "parent (optional)"
  COMPANY ||--o{ WORK_LOCATION : has
  WORK_LOCATION ||--o{ NETWORK_ALLOWLIST : "allowed CIDRs"
  USER_ACCOUNT |o--o| EMPLOYEE : "linked to"
  USER_ACCOUNT ||--o{ SESSION : has
  USER_ACCOUNT ||--o{ DEVICE : registers
  DEVICE ||--o{ WEBAUTHN_CREDENTIAL : holds
  USER_ACCOUNT ||--o| TOTP_SECRET : has
  ROLE ||--o{ ROLE_PERMISSION : grants
  PERMISSION ||--o{ ROLE_PERMISSION : in
  USER_ACCOUNT ||--o{ ROLE_ASSIGNMENT : has
  ROLE ||--o{ ROLE_ASSIGNMENT : assigned
  MODULE ||--o{ MODULE_COMPANY_STATE : "enabled per company"
  SETTING_DEFINITION ||--o{ SETTING_VALUE : "group/company values"
  AUDIT_EVENT }o--|| USER_ACCOUNT : actor

  COMPANY { uuid id PK; text code UK; text name_ar; text name_en; char3 default_currency; text status }
  DEPARTMENT { uuid id PK; uuid company_id FK; uuid parent_id FK; text name_ar; text name_en; uuid manager_employee_id FK }
  USER_ACCOUNT { uuid id PK; citext username UK; text password_hash; text status; uuid employee_id FK; int failed_logins; timestamptz locked_until }
  SESSION { uuid id PK; uuid user_id FK; bytea token_hash; timestamptz created_at; timestamptz last_seen_at; timestamptz expires_at; inet ip; text user_agent; timestamptz revoked_at }
  DEVICE { uuid id PK; uuid user_id FK; text label; text status; bytea pin_hash; int pin_failures; timestamptz approved_at }
  ROLE { uuid id PK; text key UK; text name_ar; text name_en; bool is_system }
  PERMISSION { text key PK; text module; text action; text sensitivity }
  ROLE_ASSIGNMENT { uuid id PK; uuid user_id FK; uuid role_id FK; text scope_type; uuid scope_id; date valid_from; date valid_to }
  AUDIT_EVENT { bigint id PK; timestamptz at; uuid actor_user_id; text action; text entity_type; uuid entity_id; uuid company_id; jsonb before; jsonb after; inet ip; text device; text outcome; bytea prev_hash; bytea hash }
```

## 3. ERD — Employees, documents, contracts

```mermaid
erDiagram
  EMPLOYEE ||--o{ EMPLOYMENT_ASSIGNMENT : "effective-dated"
  EMPLOYEE ||--o{ COMPENSATION : "effective-dated"
  COMPENSATION ||--o{ COMPENSATION_COMPONENT : "allowances/deductions"
  EMPLOYEE ||--o{ BANK_ACCOUNT : has
  EMPLOYEE ||--o{ QUALIFICATION : has
  EMPLOYEE ||--o{ LIFECYCLE_EVENT : history
  COMPANY ||--o{ EMPLOYMENT_ASSIGNMENT : employs
  JOB_TITLE ||--o{ EMPLOYMENT_ASSIGNMENT : ""
  EMPLOYEE ||--o{ DOCUMENT_LINK : ""
  DOCUMENT ||--o{ DOCUMENT_LINK : "linked to entity"
  DOCUMENT_CATEGORY ||--o{ DOCUMENT : classifies
  STORED_OBJECT ||--|| DOCUMENT : content
  EMPLOYEE ||--o{ CONTRACT : has
  CONTRACT_TYPE ||--o{ CONTRACT : types
  CONTRACT_TEMPLATE ||--o{ CONTRACT : "generated from"
  CONTRACT ||--o{ CONTRACT_VERSION : "immutable versions/addenda"
  CONTRACT_VERSION ||--o{ SIGNATURE : signers
  CONTRACT ||--o| CONTRACT : "renewal_of"

  EMPLOYEE { uuid id PK; text employee_no UK "group-wide, immutable"; text full_name_ar; text full_name_en; bytea national_id_enc; bytea national_id_bidx; date birth_date; text gender; text nationality; text marital_status; text phone; citext email; uuid photo_object_id; text status }
  EMPLOYMENT_ASSIGNMENT { uuid id PK; uuid employee_id FK; uuid company_id FK; uuid department_id "nullable"; uuid job_title_id; uuid manager_employee_id; uuid work_location_id; text employment_category; text contract_type; date valid_from; date valid_to; text change_reason }
  COMPENSATION { uuid id PK; uuid employee_id FK; uuid company_id; numeric base_salary; char3 currency; text payment_method; date valid_from; date valid_to }
  BANK_ACCOUNT { uuid id PK; uuid employee_id; text bank_name; bytea account_no_enc; bytea iban_enc; bool is_primary }
  LIFECYCLE_EVENT { uuid id PK; uuid employee_id; uuid company_id; text type "hire, confirm, transfer, promotion, ..."; date effective_date; jsonb details; uuid workflow_instance_id }
  DOCUMENT { uuid id PK; uuid company_id; uuid category_id; text title; jsonb metadata; date expiry_date "data only, no alerts"; text status "active, superseded, deleted"; uuid supersedes_id }
  STORED_OBJECT { uuid id PK; text provider; text bucket; text key; text mime; bigint size; bytea sha256; text enc_key_id; text scan_status }
  CONTRACT { uuid id PK; uuid company_id; uuid employee_id; text contract_no UK; uuid type_id; text status; date start_date; date end_date; date probation_end; uuid renewal_of_id }
  CONTRACT_VERSION { uuid id PK; uuid contract_id; int version_no; text kind "original, addendum, amendment"; text body_rendered; bytea body_sha256; uuid pdf_object_id; timestamptz locked_at }
  SIGNATURE { uuid id PK; uuid contract_version_id; uuid signer_user_id; text role; text status; timestamptz signed_at; inet ip; text device; text method; bytea doc_hash }
```

## 4. ERD — Time (calendar, attendance, leave)

```mermaid
erDiagram
  WORK_SCHEDULE ||--o{ SCHEDULE_DAY : defines
  SCHEDULE_DAY ||--o{ SCHEDULE_BREAK : has
  WORK_SCHEDULE ||--o{ SCHEDULE_ASSIGNMENT : "assigned (effective-dated)"
  EMPLOYEE ||--o{ SCHEDULE_ASSIGNMENT : ""
  HOLIDAY_CALENDAR ||--o{ HOLIDAY : contains
  EMPLOYEE ||--o{ PUNCH : records
  EMPLOYEE ||--o{ ATTENDANCE_DAY : "computed per work date"
  ATTENDANCE_DAY ||--o{ PUNCH : uses
  ATTENDANCE_DAY ||--o{ ATTENDANCE_CORRECTION : corrected_by
  LEAVE_TYPE ||--o{ LEAVE_POLICY : "rules (group/company)"
  EMPLOYEE ||--o{ LEAVE_LEDGER_ENTRY : balance
  EMPLOYEE ||--o{ LEAVE_REQUEST : submits
  LEAVE_REQUEST ||--o{ LEAVE_LEDGER_ENTRY : "usage/refund"
  EMPLOYEE ||--o{ INDAY_PERMISSION : submits

  WORK_SCHEDULE { uuid id PK; uuid company_id "null = group"; text name; int grace_in_min; int grace_out_min; text early_checkin_policy; text overtime_policy }
  SCHEDULE_DAY { uuid id PK; uuid schedule_id; int iso_weekday; bool is_workday; time start_time; time end_time }
  HOLIDAY_CALENDAR { uuid id PK; uuid company_id "null = group-wide"; int year }
  PUNCH { uuid id PK; uuid employee_id; uuid company_id; text kind "in, out, break_start, break_end"; timestamptz at; text source "pwa, admin, auto"; inet ip; uuid device_id; text method "password, webauthn, pin"; text idempotency_key UK }
  ATTENDANCE_DAY { uuid id PK; uuid employee_id; uuid company_id; date work_date; text day_class "workday, rest, holiday, leave"; int late_min; int early_min; int worked_min; int break_min; int overtime_min; int holiday_work_min; text status "present, absent_pending, absent_confirmed, ..."; text closure_type "normal, administrative"; int calc_version }
  ATTENDANCE_CORRECTION { uuid id PK; uuid attendance_day_id; jsonb requested_change; text reason; text status; uuid workflow_instance_id }
  LEAVE_TYPE { uuid id PK; text key; text name_ar; text name_en; bool paid; text unit "day" }
  LEAVE_POLICY { uuid id PK; uuid leave_type_id; uuid company_id; jsonb rules "typed: accrual, carryover, deduction timing ..."; date valid_from }
  LEAVE_LEDGER_ENTRY { uuid id PK; uuid employee_id; uuid leave_type_id; date effective_date; text kind "opening, accrual, usage, refund, adjustment, carryover, expiry"; numeric amount; uuid source_id; text note }
  LEAVE_REQUEST { uuid id PK; uuid employee_id; uuid company_id; uuid leave_type_id; date start_date; date end_date; numeric days; text status; uuid workflow_instance_id }
  INDAY_PERMISSION { uuid id PK; uuid employee_id; date work_date; time start_time; time end_time; int minutes; text status }
```

## 5. ERD — Payroll, evaluation, separation, recruitment

```mermaid
erDiagram
  PAY_COMPONENT ||--o{ PAYROLL_LINE : "typed lines"
  PAYROLL_PERIOD ||--o{ PAYROLL_RUN : "per company"
  PAYROLL_RUN ||--o{ PAYROLL_ITEM : "one per employee"
  PAYROLL_ITEM ||--o{ PAYROLL_LINE : lines
  PAYROLL_ITEM ||--o| PAYSLIP : renders
  PAYROLL_ITEM ||--o{ PAYMENT : paid_by
  PAYROLL_RUN ||--o{ PAYROLL_RUN : "revision_of"
  EVALUATION_POLICY ||--o{ EVALUATION_RESULT : produces
  EMPLOYEE ||--o{ TERMINATION_CASE : ""
  TERMINATION_CASE ||--o| SETTLEMENT : ""
  VACANCY ||--o{ APPLICATION : receives
  CANDIDATE ||--o{ APPLICATION : submits
  APPLICATION ||--o{ INTERVIEW : has
  APPLICATION ||--o| OFFER : ""
  APPLICATION |o--o| EMPLOYEE : "converted_to"

  PAY_COMPONENT { uuid id PK; uuid company_id; text key; text kind "earning, deduction"; text method "fixed, pct_of_base, per_hour_x_multiplier, ..."; jsonb params }
  PAYROLL_RUN { uuid id PK; uuid company_id; uuid period_id; int revision; text status "draft, calculated, in_approval, approved_locked, reopened, paid"; timestamptz locked_at; jsonb fx_rates }
  PAYROLL_ITEM { uuid id PK; uuid run_id; uuid employee_id; char3 currency; numeric gross; numeric deductions; numeric net; jsonb input_snapshot }
  PAYROLL_LINE { uuid id PK; uuid item_id; uuid component_id; numeric quantity; numeric rate; numeric amount; text explanation }
  PAYMENT { uuid id PK; uuid item_id; text status; text method; text bank_ref; text transaction_ref; date paid_on; numeric amount; char3 currency; numeric fx_rate; text notes }
  EVALUATION_RESULT { uuid id PK; uuid employee_id; uuid company_id; date period_start; date period_end; jsonb components; numeric score; int calc_version }
  TERMINATION_CASE { uuid id PK; uuid employee_id; uuid company_id; text type; text reason; date last_working_day; text status; uuid workflow_instance_id }
  CANDIDATE { uuid id PK; text full_name; citext email; text phone; text status }
  OFFER { uuid id PK; uuid application_id; numeric salary; char3 currency; text status }
```

## 6. ERD — Workflow, notifications, reporting

```mermaid
erDiagram
  WORKFLOW_DEFINITION ||--o{ WORKFLOW_STEP : ordered
  WORKFLOW_DEFINITION ||--o{ WORKFLOW_INSTANCE : runs
  WORKFLOW_INSTANCE ||--o{ WORKFLOW_TASK : "pending/decided"
  NOTIFICATION ||--o{ NOTIFICATION_RECIPIENT : to
  USER_ACCOUNT ||--o{ PUSH_SUBSCRIPTION : has
  REPORT_DATASET ||--o{ SAVED_REPORT : base
  SAVED_REPORT ||--o{ REPORT_SCHEDULE : ""
  DASHBOARD_WIDGET ||--o{ DASHBOARD_LAYOUT_ITEM : placed
  OUTBOX_EVENT { bigint id PK; text type; jsonb payload; timestamptz created_at; timestamptz dispatched_at }
  WORKFLOW_STEP { uuid id PK; uuid definition_id; int seq; text approver_rule "direct_manager, role_in_company, specific_user"; jsonb params; int sla_hours }
  WORKFLOW_INSTANCE { uuid id PK; uuid company_id; text subject_type; uuid subject_id; text status; int current_seq }
  WORKFLOW_TASK { uuid id PK; uuid instance_id; uuid assignee_user_id; uuid delegated_from; text decision; text comment; timestamptz decided_at }
  NOTIFICATION { uuid id PK; uuid company_id; text event_type; jsonb params; text link }
  NOTIFICATION_RECIPIENT { uuid notification_id; uuid user_id; timestamptz read_at }
```

## 7. Integrity rules enforced in the database (not only in code)

| Rule | Mechanism |
|---|---|
| Employee number unique and never updated | `UNIQUE` + trigger rejecting UPDATE of `employee_no` |
| No overlapping assignments, compensation or schedule assignments | `EXCLUDE USING gist` |
| One active company assignment at a time (A-09) | Same exclusion constraint on `employee_id` |
| Locked payroll is immutable | Trigger: no UPDATE/DELETE on items/lines when the run's `status = approved_locked` |
| Signed contract versions are immutable | Trigger on `contract_version` when `locked_at IS NOT NULL` |
| Audit is append-only | Trigger blocks UPDATE/DELETE. The app role lacks the privilege. Hash chain |
| Leave ledger is append-only | Same pattern. Corrections are new `adjustment` rows |
| Punches are append-only | Corrections create new rows/flags. Originals are never altered |
| Company isolation | RLS policies on every company-scoped table |
| Positive amounts and valid ranges | CHECK constraints (`end_date >= start_date`, `minutes >= 0`) |

## 8. Migrations

- Forward-only, numbered SQL migrations, reviewed in PRs. **Expand → migrate → contract** pattern, so the previous app version keeps working during a rollback.
- Migrations run as a Railway **pre-deploy command**, after a backup check (railway-deployment.md).
- Destructive migrations (drop/rename column, data rewrites) require explicit owner approval and a fresh verified backup.

## 9. Indicative volumes (A-05: 500 employees)

Punches: ~500 × 4 × 22 ≈ 44k rows/month. Attendance days: ~11k/month. Audit events: ~100–300k/month. That is comfortably within a small PostgreSQL instance. Monthly partitioning of `audit_event` and `punch` is planned once they pass ~10 M rows.
