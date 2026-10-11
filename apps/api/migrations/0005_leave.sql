-- 0005 Leave & in-day permissions (Phase 5): types, append-only ledger, requests, permissions.

-- Fix (found in Phase 5): employees could not read their own company's schedules and
-- holidays, so workdays resolved under their own session were "unscheduled" (DL-037).
-- Companies of the signed-in user's own employment, owner-run to avoid policy recursion.
create or replace function app_own_company_ids() returns uuid[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(distinct a.company_id), '{}'::uuid[])
  from employment_assignment a
  where app_employee_id() is not null and a.employee_id = app_employee_id()
$$;

-- Company- and department-wide assignments of one's own company (not colleagues' personal ones).
alter policy schedule_assignment_isolation on schedule_assignment
  using (
    app_can_see_company(company_id)
    or employee_id = app_employee_id()
    or (target_type in ('company', 'department') and company_id = any(app_own_company_ids()))
  );
alter policy work_schedule_isolation on work_schedule
  using (company_id is null or app_can_see_company(company_id) or company_id = any(app_own_company_ids()));
alter policy holiday_isolation on holiday
  using (company_id is null or app_can_see_company(company_id) or company_id = any(app_own_company_ids()));

-- Leave types (LEV-01). company_id null = group-wide; a company type with the same code
-- replaces the group type for that company. Rules are validated by the application (Zod).
create table leave_type (
  id uuid primary key,
  company_id uuid references company (id),
  code citext not null,
  name_ar text not null,
  name_en text not null,
  paid boolean not null,
  rules jsonb not null,
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1
);
create unique index leave_type_code on leave_type (coalesce(company_id, '00000000-0000-0000-0000-000000000000'::uuid), code);
create trigger leave_type_touch before update on leave_type for each row execute function touch_row();

-- Balance ledger (LEV-02): balance = sum(amount). Append-only; corrections are new rows.
-- period_key makes job-generated rows idempotent (accrual per year/month, carryover expiry).
create table leave_ledger (
  id uuid primary key,
  employee_id uuid not null references employee (id),
  company_id uuid not null references company (id),
  leave_type_id uuid not null references leave_type (id),
  effective_date date not null,
  kind text not null check (kind in ('opening', 'accrual', 'usage', 'refund', 'adjustment', 'carryover_expiry', 'expiry')),
  amount numeric(7, 2) not null,
  period_key text,
  source_id uuid,
  note text,
  created_at timestamptz not null default now(),
  created_by uuid
);
create index leave_ledger_employee on leave_ledger (employee_id, leave_type_id, effective_date);
create unique index leave_ledger_period on leave_ledger (employee_id, leave_type_id, kind, period_key)
  where period_key is not null;
create trigger leave_ledger_no_update before update or delete on leave_ledger
for each row execute function audit_event_immutable();

-- Full-day leave requests (LEV-03, LEV-04). Active requests of one employee never overlap.
create table leave_request (
  id uuid primary key,
  employee_id uuid not null references employee (id),
  company_id uuid not null references company (id),
  leave_type_id uuid not null references leave_type (id),
  start_date date not null,
  end_date date not null,
  days numeric(6, 2) not null check (days > 0),
  reason text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  deducted boolean not null default false,
  document_id uuid references document (id),
  requested_by uuid not null references user_account (id),
  workflow_instance_id uuid references workflow_instance (id),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  cancelled_at timestamptz,
  cancelled_by uuid references user_account (id),
  cancel_reason text,
  check (end_date >= start_date),
  constraint leave_request_no_overlap exclude using gist (
    employee_id with =,
    daterange(start_date, end_date, '[]') with &&
  ) where (status in ('pending', 'approved'))
);
create index leave_request_company on leave_request (company_id, start_date);

-- In-day permissions (LEV-05): a time window on one workday.
create table leave_permission (
  id uuid primary key,
  employee_id uuid not null references employee (id),
  company_id uuid not null references company (id),
  work_date date not null,
  start_time time not null,
  end_time time not null,
  minutes integer not null check (minutes > 0),
  reason text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  requested_by uuid not null references user_account (id),
  workflow_instance_id uuid references workflow_instance (id),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  check (end_time > start_time)
);
create index leave_permission_employee on leave_permission (employee_id, work_date);

-- Permission route (configurable, not locked): direct manager (skippable) → HR.
insert into workflow_definition (id, key, subject_type, name_ar, name_en, locked)
values ('00000000-0000-7000-8000-000000000003', 'leave.permission', 'leave_permission', 'طلب استئذان', 'In-day permission', false);
insert into workflow_step (id, definition_id, seq, approver_rule, role_key, skip_if_unresolved, name_ar, name_en) values
  (gen_random_uuid(), '00000000-0000-7000-8000-000000000003', 1, 'direct_manager', null, true, 'المدير المباشر', 'Direct manager'),
  (gen_random_uuid(), '00000000-0000-7000-8000-000000000003', 2, 'role_in_company', 'hr', false, 'الموارد البشرية', 'Human resources');

-- Default group leave types (editable). Rules follow DEFAULT_LEAVE_RULES in @hrms/shared.
insert into leave_type (id, company_id, code, name_ar, name_en, paid, rules) values
  (gen_random_uuid(), null, 'ANNUAL', 'إجازة سنوية', 'Annual leave', true,
   '{"entitlementDays":21,"serviceTiers":[],"accrual":"yearly","countDays":"workdays","deductWhen":"approval","allowNegativeDays":0,"maxDaysPerYear":null,"maxDaysPerRequest":null,"minNoticeDays":0,"retroactiveDays":7,"carryoverMaxDays":null,"carryoverExpiryMonths":null,"attachment":"none","attachmentCategoryId":null,"eligibleContractTypeIds":[],"eligibleCategoryIds":[]}'),
  (gen_random_uuid(), null, 'SICK', 'إجازة مرضية', 'Sick leave', true,
   '{"entitlementDays":0,"serviceTiers":[],"accrual":"none","countDays":"workdays","deductWhen":"approval","allowNegativeDays":0,"maxDaysPerYear":null,"maxDaysPerRequest":null,"minNoticeDays":0,"retroactiveDays":14,"carryoverMaxDays":null,"carryoverExpiryMonths":null,"attachment":"optional","attachmentCategoryId":null,"eligibleContractTypeIds":[],"eligibleCategoryIds":[]}'),
  (gen_random_uuid(), null, 'UNPAID', 'إجازة بدون راتب', 'Unpaid leave', false,
   '{"entitlementDays":0,"serviceTiers":[],"accrual":"none","countDays":"workdays","deductWhen":"approval","allowNegativeDays":0,"maxDaysPerYear":null,"maxDaysPerRequest":null,"minNoticeDays":0,"retroactiveDays":7,"carryoverMaxDays":null,"carryoverExpiryMonths":null,"attachment":"none","attachmentCategoryId":null,"eligibleContractTypeIds":[],"eligibleCategoryIds":[]}');
-- Sick-leave attachments go to the restricted medical category (C-12).
update leave_type set rules = jsonb_set(rules, '{attachmentCategoryId}', to_jsonb((select id::text from document_category where code = 'medical')))
where code = 'SICK' and company_id is null;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table leave_type enable row level security;
alter table leave_type force row level security;
-- Type definitions are not personal data: everyone may read them; writes follow scope.
create policy leave_type_read on leave_type for select using (true);
create policy leave_type_insert on leave_type for insert
  with check ((company_id is null and app_group_scope()) or (company_id is not null and app_can_see_company(company_id)));
create policy leave_type_update on leave_type for update
  using ((company_id is null and app_group_scope()) or (company_id is not null and app_can_see_company(company_id)))
  with check ((company_id is null and app_group_scope()) or (company_id is not null and app_can_see_company(company_id)));

-- Ledger and requests follow the employee (balances survive transfers between companies)
-- and are visible to the participants of their approval.
alter table leave_ledger enable row level security;
alter table leave_ledger force row level security;
create policy leave_ledger_access on leave_ledger
  using (app_can_see_employee(employee_id)) with check (app_can_see_employee(employee_id));

alter table leave_request enable row level security;
alter table leave_request force row level security;
create policy leave_request_access on leave_request
  using (app_can_see_employee(employee_id) or exists (select 1 from workflow_instance i where i.id = workflow_instance_id))
  with check (app_can_see_employee(employee_id) or exists (select 1 from workflow_instance i where i.id = workflow_instance_id));

alter table leave_permission enable row level security;
alter table leave_permission force row level security;
create policy leave_permission_access on leave_permission
  using (app_can_see_employee(employee_id) or exists (select 1 from workflow_instance i where i.id = workflow_instance_id))
  with check (app_can_see_employee(employee_id) or exists (select 1 from workflow_instance i where i.id = workflow_instance_id));

grant select, insert, update on leave_type, leave_request, leave_permission to hrms_app;
grant select, insert on leave_ledger to hrms_app;
