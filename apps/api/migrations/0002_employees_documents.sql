-- 0002 Employees & documents (Phase 2).
-- Design: docs/03-architecture/database-design.md §3, authorization-model.md §4.

-- ---------------------------------------------------------------------------
-- RLS helpers for employee visibility
-- ---------------------------------------------------------------------------
-- Personal-data sensitivity classes for permissions (financial, identity, medical).
alter table permission drop constraint permission_sensitivity_check;
alter table permission add constraint permission_sensitivity_check
  check (sensitivity in ('normal', 'security', 'financial', 'identity', 'medical'));

create or replace function app_employee_id() returns uuid
language sql stable as $$
  select nullif(current_setting('app.employee_id', true), '')::uuid
$$;

-- ---------------------------------------------------------------------------
-- Master lists (job titles, categories, contract types, allowance/deduction types)
-- company_id null = group-wide value.
-- ---------------------------------------------------------------------------
create table lookup_value (
  id uuid primary key,
  kind text not null check (kind in ('job_title', 'employment_category', 'contract_type', 'allowance_type', 'deduction_type')),
  company_id uuid references company (id),
  code citext not null,
  name_ar text not null,
  name_en text not null,
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1
);
create unique index lookup_value_unique on lookup_value (kind, company_id, code) nulls not distinct;
create trigger lookup_value_touch before update on lookup_value for each row execute function touch_row();

insert into lookup_value (id, kind, company_id, code, name_ar, name_en) values
  (gen_random_uuid(), 'employment_category', null, 'full_time', 'دوام كامل', 'Full time'),
  (gen_random_uuid(), 'employment_category', null, 'part_time', 'دوام جزئي', 'Part time'),
  (gen_random_uuid(), 'contract_type', null, 'fixed_term', 'محدد المدة', 'Fixed term'),
  (gen_random_uuid(), 'contract_type', null, 'open_ended', 'غير محدد المدة', 'Open-ended');

-- ---------------------------------------------------------------------------
-- Employees
-- ---------------------------------------------------------------------------
create table employee_number_sequence (
  singleton boolean primary key default true check (singleton),
  next_value bigint not null default 1 check (next_value > 0)
);
insert into employee_number_sequence (singleton, next_value) values (true, 1);

-- Allocate the next free group-wide employee number in the given format. Runs as owner so
-- numbers used in companies the caller cannot see are still skipped.
create or replace function next_employee_no(prefix text, padding integer) returns text
language plpgsql security definer set search_path = public as $$
declare
  n bigint;
  candidate text;
begin
  loop
    update employee_number_sequence set next_value = next_value + 1
      where singleton returning next_value - 1 into n;
    candidate := prefix || lpad(n::text, greatest(padding, length(n::text)), '0');
    exit when not exists (select 1 from employee where employee_no = candidate);
  end loop;
  return candidate;
end
$$;

create table employee (
  id uuid primary key,
  employee_no text not null unique,
  full_name_ar text not null,
  full_name_en text not null,
  id_type text check (id_type in ('national_id', 'passport')),
  id_number_enc bytea,
  -- HMAC "blind index" for exact-match duplicate detection without decrypting.
  id_number_bidx bytea,
  birth_date date,
  gender text check (gender in ('male', 'female')),
  nationality text check (nationality ~ '^[A-Z]{2}$'),
  marital_status text check (marital_status in ('single', 'married', 'divorced', 'widowed')),
  phone text,
  email citext,
  hire_date date not null,
  actual_start_date date,
  probation_end_date date,
  status text not null default 'active'
    check (status in ('probation', 'active', 'suspended', 'long_leave', 'terminated')),
  photo_document_id uuid,
  is_seed boolean not null default false,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  check (actual_start_date is null or actual_start_date >= hire_date - 365),
  check ((id_number_enc is null) = (id_number_bidx is null))
);
create unique index employee_id_number_unique on employee (id_number_bidx) where id_number_bidx is not null;
create trigger employee_touch before update on employee for each row execute function touch_row();

-- EMP-06 / CF-03: the employee number never changes (not on transfer, not ever).
create or replace function employee_no_immutable() returns trigger
language plpgsql as $$
begin
  if new.employee_no is distinct from old.employee_no then
    raise exception 'employee_no is immutable' using errcode = 'check_violation';
  end if;
  return new;
end
$$;
create trigger employee_no_immutable before update on employee
for each row execute function employee_no_immutable();

alter table work_location add constraint work_location_company_id_id unique (company_id, id);

-- Effective-dated employment assignment (D-04). valid_to is inclusive; null = open-ended.
create table employment_assignment (
  id uuid primary key,
  employee_id uuid not null references employee (id),
  company_id uuid not null references company (id),
  department_id uuid,
  job_title_id uuid references lookup_value (id),
  manager_employee_id uuid references employee (id),
  work_location_id uuid,
  employment_category_id uuid references lookup_value (id),
  contract_type_id uuid references lookup_value (id),
  contract_start date,
  contract_end date,
  valid_from date not null,
  valid_to date,
  change_reason text,
  created_at timestamptz not null default now(),
  created_by uuid,
  foreign key (company_id, department_id) references department (company_id, id),
  foreign key (company_id, work_location_id) references work_location (company_id, id),
  check (valid_to is null or valid_to >= valid_from),
  check (contract_end is null or contract_start is null or contract_end >= contract_start),
  check (manager_employee_id is null or manager_employee_id <> employee_id),
  -- One assignment at a time per employee (A-09); no overlapping history.
  constraint employment_assignment_no_overlap exclude using gist (
    employee_id with =, daterange(valid_from, valid_to, '[]') with &&
  )
);
create index employment_assignment_company on employment_assignment (company_id, valid_to);

-- Who may see an employee: group scope, the employee themself, or anyone whose companies
-- contain the employee's current (or upcoming) assignment. SECURITY DEFINER so the check
-- itself is not filtered by the assignment table's own policy.
create or replace function app_can_see_employee(eid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select app_group_scope()
      or eid = app_employee_id()
      or exists (
        select 1 from employment_assignment a
        where a.employee_id = eid
          and a.company_id = any(app_company_ids())
          and (a.valid_to is null or a.valid_to >= current_date)
      )
$$;

create table compensation (
  id uuid primary key,
  employee_id uuid not null references employee (id),
  company_id uuid not null references company (id),
  base_salary numeric(18, 4) not null check (base_salary >= 0),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  payment_method text not null check (payment_method in ('bank_transfer', 'cash', 'cheque')),
  valid_from date not null,
  valid_to date,
  change_reason text,
  created_at timestamptz not null default now(),
  created_by uuid,
  check (valid_to is null or valid_to >= valid_from),
  constraint compensation_no_overlap exclude using gist (
    employee_id with =, daterange(valid_from, valid_to, '[]') with &&
  )
);

create table compensation_item (
  id uuid primary key,
  compensation_id uuid not null references compensation (id),
  kind text not null check (kind in ('allowance', 'deduction')),
  type_id uuid not null references lookup_value (id),
  calc text not null default 'fixed' check (calc in ('fixed', 'percent_of_base')),
  amount numeric(18, 4) not null check (amount >= 0),
  check (calc <> 'percent_of_base' or amount <= 100)
);

create table bank_account (
  id uuid primary key,
  employee_id uuid not null references employee (id),
  bank_name text not null,
  account_no_enc bytea,
  iban_enc bytea,
  is_primary boolean not null default true,
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1
);
create unique index bank_account_one_primary on bank_account (employee_id)
  where is_primary and status = 'active';
create trigger bank_account_touch before update on bank_account for each row execute function touch_row();

create table qualification (
  id uuid primary key,
  employee_id uuid not null references employee (id),
  level text not null check (level in ('secondary', 'diploma', 'bachelor', 'master', 'doctorate', 'professional', 'other')),
  specialization text,
  institution text,
  country text check (country ~ '^[A-Z]{2}$'),
  graduation_year integer check (graduation_year between 1950 and 2100),
  status text not null default 'active' check (status in ('active', 'deleted')),
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1
);
create trigger qualification_touch before update on qualification for each row execute function touch_row();

-- Append-only employment history events (EMP-07, EMP-08).
create table lifecycle_event (
  id uuid primary key,
  employee_id uuid not null references employee (id),
  company_id uuid references company (id),
  type text not null,
  effective_date date not null,
  details jsonb not null default '{}',
  created_at timestamptz not null default now(),
  created_by uuid
);
create index lifecycle_event_employee on lifecycle_event (employee_id, effective_date);

create trigger lifecycle_event_no_update before update or delete on lifecycle_event
for each row execute function audit_event_immutable();

-- One account per employee; one employee per account (AUTH-08).
alter table user_account add constraint user_account_employee_fk foreign key (employee_id) references employee (id);
create unique index user_account_employee_unique on user_account (employee_id) where employee_id is not null;

-- ---------------------------------------------------------------------------
-- Documents (DOC-01..06). Metadata here; encrypted content in object storage.
-- ---------------------------------------------------------------------------
create table document_category (
  id uuid primary key,
  code citext not null unique,
  name_ar text not null,
  name_en text not null,
  allowed_types text[] not null check (cardinality(allowed_types) > 0),
  max_size_mb integer not null check (max_size_mb between 1 and 50),
  sensitivity text not null default 'normal' check (sensitivity in ('normal', 'restricted', 'medical')),
  employee_visible boolean not null default false,
  allow_replace boolean not null default true,
  allow_delete boolean not null default true,
  has_expiry boolean not null default false,
  retention_years integer check (retention_years between 1 and 100),
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1
);
create trigger document_category_touch before update on document_category for each row execute function touch_row();

insert into document_category (id, code, name_ar, name_en, allowed_types, max_size_mb, sensitivity, employee_visible, has_expiry) values
  (gen_random_uuid(), 'photo', 'الصورة الشخصية', 'Profile photo', '{jpg,png,webp}', 5, 'normal', true, false),
  (gen_random_uuid(), 'identity', 'وثائق الهوية', 'Identity documents', '{pdf,jpg,png}', 20, 'restricted', true, true),
  (gen_random_uuid(), 'qualifications', 'الشهادات والمؤهلات', 'Certificates & qualifications', '{pdf,jpg,png}', 20, 'normal', true, false),
  (gen_random_uuid(), 'employment', 'وثائق التوظيف', 'Employment documents', '{pdf,docx,jpg,png}', 20, 'normal', true, false),
  (gen_random_uuid(), 'medical', 'وثائق طبية', 'Medical documents', '{pdf,jpg,png}', 20, 'medical', false, false),
  (gen_random_uuid(), 'other', 'أخرى', 'Other', '{pdf,docx,xlsx,jpg,png}', 20, 'normal', false, false);

create table stored_object (
  id uuid primary key,
  provider text not null,
  object_key text not null unique,
  mime text not null,
  size_bytes bigint not null check (size_bytes >= 0),
  sha256 bytea not null,
  enc_key_id text not null,
  created_at timestamptz not null default now(),
  created_by uuid
);

create table document (
  id uuid primary key,
  company_id uuid not null references company (id),
  category_id uuid not null references document_category (id),
  object_id uuid not null references stored_object (id),
  title text not null,
  original_name text not null,
  expiry_date date,
  status text not null default 'active' check (status in ('active', 'superseded', 'deleted')),
  supersedes_id uuid references document (id),
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  deleted_by uuid,
  version integer not null default 1
);
create trigger document_touch before update on document for each row execute function touch_row();

create table document_link (
  document_id uuid not null references document (id),
  entity_type text not null check (entity_type in ('employee')),
  entity_id uuid not null,
  primary key (document_id, entity_type, entity_id)
);
create index document_link_entity on document_link (entity_type, entity_id);

alter table employee add constraint employee_photo_fk foreign key (photo_document_id) references document (id);

-- Current (or upcoming) assignment per employee. security_invoker keeps RLS in force.
create view employee_current_assignment with (security_invoker = true) as
select distinct on (a.employee_id) a.*
from employment_assignment a
order by a.employee_id,
  (a.valid_to is null or a.valid_to >= current_date) desc,
  (a.valid_from <= current_date) desc,
  a.valid_from desc;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
alter table lookup_value enable row level security;
alter table lookup_value force row level security;
create policy lookup_value_isolation on lookup_value
  using (company_id is null or app_can_see_company(company_id))
  with check ((company_id is null and app_group_scope()) or app_can_see_company(company_id));

alter table employee enable row level security;
alter table employee force row level security;
create policy employee_read on employee for select using (app_can_see_employee(id));
-- A new employee has no assignment yet; the assignment insert below is company-checked.
create policy employee_insert on employee for insert with check (true);
create policy employee_update on employee for update using (app_can_see_employee(id)) with check (true);

alter table employment_assignment enable row level security;
alter table employment_assignment force row level security;
create policy employment_assignment_isolation on employment_assignment
  using (app_can_see_company(company_id) or employee_id = app_employee_id())
  with check (app_can_see_company(company_id));

alter table compensation enable row level security;
alter table compensation force row level security;
create policy compensation_isolation on compensation
  using (app_can_see_company(company_id) or employee_id = app_employee_id())
  with check (app_can_see_company(company_id));

alter table compensation_item enable row level security;
alter table compensation_item force row level security;
create policy compensation_item_isolation on compensation_item
  using (exists (select 1 from compensation c where c.id = compensation_id))
  with check (exists (select 1 from compensation c where c.id = compensation_id));

alter table bank_account enable row level security;
alter table bank_account force row level security;
create policy bank_account_isolation on bank_account
  using (app_can_see_employee(employee_id))
  with check (app_can_see_employee(employee_id));

alter table qualification enable row level security;
alter table qualification force row level security;
create policy qualification_isolation on qualification
  using (app_can_see_employee(employee_id))
  with check (app_can_see_employee(employee_id));

alter table lifecycle_event enable row level security;
alter table lifecycle_event force row level security;
create policy lifecycle_event_isolation on lifecycle_event
  using ((company_id is not null and app_can_see_company(company_id)) or employee_id = app_employee_id() or app_group_scope())
  with check (app_can_see_employee(employee_id));

alter table document enable row level security;
alter table document force row level security;
create policy document_isolation on document
  using (
    app_can_see_company(company_id)
    or exists (
      select 1 from document_link l
      where l.document_id = id and l.entity_type = 'employee' and l.entity_id = app_employee_id()
    )
  )
  with check (app_can_see_company(company_id));

-- document_link holds only identifiers and is always read through `document` (whose policy
-- consults it); giving it its own policy on `document` would recurse.

-- ---------------------------------------------------------------------------
-- Privileges (no DELETE anywhere: history is never removed by the application)
-- ---------------------------------------------------------------------------
grant select, insert, update on
  lookup_value, employee, employment_assignment, compensation, bank_account,
  qualification, document_category, stored_object, document
  to hrms_app;
grant select, insert on compensation_item, lifecycle_event, document_link to hrms_app;
grant select, update on employee_number_sequence to hrms_app;
grant select on employee_current_assignment to hrms_app;
