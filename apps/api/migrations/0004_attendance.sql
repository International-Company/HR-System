-- 0004 Attendance (Phase 4): networks, devices, WebAuthn, punches, computed days, corrections.

-- Authorised networks per company (optionally per work location). ATT-01.
create table network_range (
  id uuid primary key,
  company_id uuid not null references company (id),
  work_location_id uuid,
  cidr cidr not null,
  label text not null,
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  created_by uuid,
  foreign key (company_id, work_location_id) references work_location (company_id, id)
);
create index network_range_company on network_range (company_id) where status = 'active';

-- Personal attendance devices (ATT-05). A device has either a WebAuthn credential or a
-- device-bound PIN (C-06: the PIN is only valid together with the device token).
create table attendance_device (
  id uuid primary key,
  user_id uuid not null references user_account (id),
  employee_id uuid references employee (id),
  company_id uuid references company (id),
  label text not null,
  kind text not null check (kind in ('webauthn', 'pin')),
  status text not null default 'approved' check (status in ('pending', 'approved', 'revoked')),
  token_hash bytea,
  pin_hash text,
  pin_failures integer not null default 0,
  user_agent text,
  created_at timestamptz not null default now(),
  approved_by uuid references user_account (id),
  approved_at timestamptz,
  revoked_by uuid references user_account (id),
  revoked_at timestamptz,
  last_used_at timestamptz,
  check (kind <> 'pin' or (token_hash is not null and pin_hash is not null))
);
create index attendance_device_user on attendance_device (user_id) where status <> 'revoked';

create table webauthn_credential (
  id uuid primary key,
  device_id uuid not null references attendance_device (id),
  user_id uuid not null references user_account (id),
  credential_id text not null unique,
  public_key bytea not null,
  counter bigint not null default 0,
  transports text[] not null default '{}',
  rp_id text not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

-- One-time WebAuthn challenges (5-minute validity).
create table auth_challenge (
  id uuid primary key,
  user_id uuid not null references user_account (id),
  purpose text not null check (purpose in ('register', 'authenticate')),
  challenge text not null,
  expires_at timestamptz not null,
  used_at timestamptz
);
create index auth_challenge_user on auth_challenge (user_id, purpose) where used_at is null;

-- Punches are append-only (server time only). Corrections add new rows and void old ones.
create table punch (
  id uuid primary key,
  employee_id uuid not null references employee (id),
  company_id uuid not null references company (id),
  work_date date not null,
  kind text not null check (kind in ('in', 'out', 'break_start', 'break_end')),
  at timestamptz not null,
  source text not null check (source in ('pwa', 'correction')),
  method text not null check (method in ('session', 'webauthn', 'pin', 'correction')),
  ip inet,
  device_id uuid references attendance_device (id),
  user_agent text,
  idempotency_key text unique,
  correction_id uuid,
  created_at timestamptz not null default now(),
  created_by uuid
);
create index punch_employee_date on punch (employee_id, work_date);

create trigger punch_no_update before update or delete on punch
for each row execute function audit_event_immutable();

create table punch_void (
  punch_id uuid primary key references punch (id),
  correction_id uuid not null,
  voided_at timestamptz not null default now(),
  voided_by uuid
);

-- Computed attendance per employee and work date (recalculated from punches; ATT-09).
create table attendance_day (
  id uuid primary key,
  employee_id uuid not null references employee (id),
  company_id uuid not null references company (id),
  work_date date not null,
  day_class text not null check (day_class in ('workday', 'rest', 'holiday', 'unscheduled', 'not_employed')),
  status text not null check (status in ('present', 'incomplete', 'absent_pending', 'absent_confirmed', 'excused', 'not_required', 'upcoming')),
  scheduled_start time,
  scheduled_end time,
  first_in timestamptz,
  last_out timestamptz,
  worked_minutes integer not null default 0,
  break_minutes integer not null default 0,
  late_minutes integer not null default 0,
  early_minutes integer not null default 0,
  overtime_minutes integer not null default 0,
  holiday_work_minutes integer not null default 0,
  closure text not null default 'none' check (closure in ('normal', 'administrative', 'open', 'none')),
  flags text[] not null default '{}',
  review_status text check (review_status in ('absent_confirmed', 'excused')),
  review_note text,
  reviewed_by uuid references user_account (id),
  reviewed_at timestamptz,
  calc_version integer not null default 1,
  computed_at timestamptz not null default now(),
  unique (employee_id, work_date)
);
create index attendance_day_company_date on attendance_day (company_id, work_date);

create table attendance_correction (
  id uuid primary key,
  employee_id uuid not null references employee (id),
  company_id uuid not null references company (id),
  work_date date not null,
  changes jsonb not null,
  reason text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  direct boolean not null default false,
  requested_by uuid not null references user_account (id),
  workflow_instance_id uuid references workflow_instance (id),
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
create index attendance_correction_employee on attendance_correction (employee_id, work_date);

-- Correction route (configurable, not locked): direct manager (skippable) → HR.
insert into workflow_definition (id, key, subject_type, name_ar, name_en, locked)
values ('00000000-0000-7000-8000-000000000002', 'attendance.correction', 'attendance_correction', 'تصحيح حضور', 'Attendance correction', false);
insert into workflow_step (id, definition_id, seq, approver_rule, role_key, skip_if_unresolved, name_ar, name_en) values
  (gen_random_uuid(), '00000000-0000-7000-8000-000000000002', 1, 'direct_manager', null, true, 'المدير المباشر', 'Direct manager'),
  (gen_random_uuid(), '00000000-0000-7000-8000-000000000002', 2, 'role_in_company', 'hr', false, 'الموارد البشرية', 'Human resources');

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table network_range enable row level security;
alter table network_range force row level security;
create policy network_range_isolation on network_range
  using (app_can_see_company(company_id)) with check (app_can_see_company(company_id));

alter table attendance_device enable row level security;
alter table attendance_device force row level security;
create policy attendance_device_access on attendance_device
  using (user_id = app_user_id() or (company_id is not null and app_can_see_company(company_id)) or app_group_scope())
  with check (user_id = app_user_id() or (company_id is not null and app_can_see_company(company_id)) or app_group_scope());

alter table webauthn_credential enable row level security;
alter table webauthn_credential force row level security;
create policy webauthn_credential_access on webauthn_credential
  using (user_id = app_user_id() or app_group_scope())
  with check (user_id = app_user_id());

alter table auth_challenge enable row level security;
alter table auth_challenge force row level security;
create policy auth_challenge_access on auth_challenge
  using (user_id = app_user_id()) with check (user_id = app_user_id());

alter table punch enable row level security;
alter table punch force row level security;
create policy punch_access on punch
  using (app_can_see_company(company_id) or employee_id = app_employee_id())
  with check (app_can_see_company(company_id) or employee_id = app_employee_id());

alter table punch_void enable row level security;
alter table punch_void force row level security;
create policy punch_void_access on punch_void
  using (exists (select 1 from punch p where p.id = punch_id))
  with check (exists (select 1 from punch p where p.id = punch_id));

alter table attendance_day enable row level security;
alter table attendance_day force row level security;
create policy attendance_day_access on attendance_day
  using (app_can_see_company(company_id) or employee_id = app_employee_id())
  with check (app_can_see_company(company_id) or employee_id = app_employee_id());

alter table attendance_correction enable row level security;
alter table attendance_correction force row level security;
create policy attendance_correction_access on attendance_correction
  using (app_can_see_company(company_id) or employee_id = app_employee_id() or exists (
    select 1 from workflow_instance i where i.id = workflow_instance_id))
  with check (app_can_see_company(company_id) or employee_id = app_employee_id() or exists (
    select 1 from workflow_instance i where i.id = workflow_instance_id));

grant select, insert, update on network_range, attendance_device, webauthn_credential, auth_challenge,
  attendance_day, attendance_correction to hrms_app;
grant select, insert on punch, punch_void to hrms_app;
