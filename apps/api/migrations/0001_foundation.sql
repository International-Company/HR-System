-- 0001 Foundation: organisation, identity, access control, settings, modules, audit, backups.
-- Design: docs/03-architecture/database-design.md, authorization-model.md (D-03, D-15).

create extension if not exists citext;
create extension if not exists btree_gist;

-- Application role used for all runtime queries. It is NOT the table owner and has
-- no BYPASSRLS, so row-level security always applies to it.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'hrms_app') then
    create role hrms_app nologin;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- RLS context helpers. Values are set per transaction with set_config(..., true).
-- ---------------------------------------------------------------------------
create or replace function app_group_scope() returns boolean
language sql stable as $$
  select coalesce(current_setting('app.group_scope', true), '') = 'on'
$$;

create or replace function app_company_ids() returns uuid[]
language sql stable as $$
  select coalesce(nullif(current_setting('app.company_ids', true), '')::uuid[], '{}'::uuid[])
$$;

create or replace function app_can_see_company(c uuid) returns boolean
language sql stable as $$
  select app_group_scope() or c = any(app_company_ids())
$$;

-- Generic optimistic-concurrency + updated_at maintenance.
create or replace function touch_row() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  new.version := old.version + 1;
  return new;
end
$$;

-- ---------------------------------------------------------------------------
-- Organisation
-- ---------------------------------------------------------------------------
create table company_group (
  id uuid primary key,
  name_ar text not null,
  name_en text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1
);
-- Exactly one group per deployment (A-01).
create unique index company_group_singleton on company_group ((true));

create table company (
  id uuid primary key,
  group_id uuid not null references company_group (id),
  code citext not null unique,
  name_ar text not null,
  name_en text not null,
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1
);

create table department (
  id uuid primary key,
  company_id uuid not null references company (id),
  parent_id uuid,
  code citext not null,
  name_ar text not null,
  name_en text not null,
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  unique (company_id, code),
  unique (company_id, id),
  -- A parent department must belong to the same company.
  foreign key (company_id, parent_id) references department (company_id, id),
  check (parent_id is null or parent_id <> id)
);

create table work_location (
  id uuid primary key,
  company_id uuid not null references company (id),
  code citext not null,
  name_ar text not null,
  name_en text not null,
  address text,
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  unique (company_id, code)
);

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------
create table user_account (
  id uuid primary key,
  username citext not null unique,
  display_name text not null,
  email citext,
  status text not null default 'active' check (status in ('active', 'disabled')),
  password_hash text not null,
  password_changed_at timestamptz not null default now(),
  must_change_password boolean not null default false,
  failed_login_count integer not null default 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  totp_secret_enc bytea,
  totp_pending_enc bytea,
  totp_enabled_at timestamptz,
  totp_last_step bigint,
  -- Linked employee (FK added in Phase 2 when the employee table exists).
  employee_id uuid,
  -- Synthetic seed/test accounts. Production refuses to start if any exist (QA-05).
  is_seed boolean not null default false,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1
);

create table mfa_recovery_code (
  id uuid primary key,
  user_id uuid not null references user_account (id),
  code_hash bytea not null,
  created_at timestamptz not null default now(),
  used_at timestamptz
);
create index mfa_recovery_code_user on mfa_recovery_code (user_id) where used_at is null;

create table session (
  id uuid primary key,
  user_id uuid not null references user_account (id),
  token_hash bytea not null unique,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ip inet,
  user_agent text,
  mfa_verified_at timestamptz,
  mfa_failed_attempts integer not null default 0,
  revoked_at timestamptz,
  revoked_reason text
);
create index session_user_active on session (user_id) where revoked_at is null;

-- ---------------------------------------------------------------------------
-- Access control
-- ---------------------------------------------------------------------------
create table permission (
  key text primary key,
  module text not null,
  sensitivity text not null check (sensitivity in ('normal', 'security')),
  group_only boolean not null,
  label_ar text not null,
  label_en text not null
);

create table role (
  id uuid primary key,
  key citext not null unique,
  name_ar text not null,
  name_en text not null,
  description text,
  is_system boolean not null default false,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1
);

create table role_permission (
  role_id uuid not null references role (id),
  permission_key text not null references permission (key),
  primary key (role_id, permission_key)
);

create table role_assignment (
  id uuid primary key,
  user_id uuid not null references user_account (id),
  role_id uuid not null references role (id),
  scope_type text not null check (scope_type in ('GROUP', 'COMPANY', 'DEPARTMENT', 'SELF')),
  company_id uuid references company (id),
  department_id uuid,
  valid_from date not null default current_date,
  valid_to date,
  created_at timestamptz not null default now(),
  created_by uuid,
  ended_at timestamptz,
  ended_by uuid,
  foreign key (company_id, department_id) references department (company_id, id),
  check (valid_to is null or valid_to >= valid_from),
  check (
    (scope_type in ('GROUP', 'SELF') and company_id is null and department_id is null)
    or (scope_type = 'COMPANY' and company_id is not null and department_id is null)
    or (scope_type = 'DEPARTMENT' and company_id is not null and department_id is not null)
  )
);
create index role_assignment_user on role_assignment (user_id) where ended_at is null;

-- ---------------------------------------------------------------------------
-- Settings & modules
-- ---------------------------------------------------------------------------
create table setting_value (
  id uuid primary key,
  key text not null,
  company_id uuid references company (id),
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1
);
create unique index setting_value_key_company on setting_value (key, company_id) nulls not distinct;

create table module (
  key text primary key,
  group_enabled boolean not null default true,
  disable_policy text not null default 'read_only' check (disable_policy in ('read_only', 'hidden')),
  updated_at timestamptz not null default now(),
  updated_by uuid
);

create table module_company_state (
  module_key text not null references module (key),
  company_id uuid not null references company (id),
  enabled boolean not null,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  primary key (module_key, company_id)
);

-- ---------------------------------------------------------------------------
-- Audit (append-only, hash-chained) — AUD-01..04, D-15
-- ---------------------------------------------------------------------------
create sequence audit_event_id_seq;

create table audit_event (
  id bigint primary key,
  at timestamptz not null default clock_timestamp(),
  actor_user_id uuid,
  actor_username text,
  session_id uuid,
  action text not null,
  entity_type text,
  entity_id text,
  company_id uuid,
  before jsonb,
  after jsonb,
  ip inet,
  user_agent text,
  outcome text not null check (outcome in ('success', 'denied', 'failure')),
  details jsonb,
  prev_hash bytea,
  hash bytea not null
);
create index audit_event_at on audit_event (at);
create index audit_event_company_at on audit_event (company_id, at);
create index audit_event_actor_at on audit_event (actor_user_id, at);
create index audit_event_entity on audit_event (entity_type, entity_id);

create or replace function audit_event_digest(e audit_event, prev bytea) returns bytea
language sql immutable as $$
  select sha256(convert_to(concat_ws('|',
    e.id::text,
    (extract(epoch from e.at))::text,
    coalesce(e.actor_user_id::text, ''),
    coalesce(e.actor_username, ''),
    coalesce(e.session_id::text, ''),
    e.action,
    coalesce(e.entity_type, ''),
    coalesce(e.entity_id, ''),
    coalesce(e.company_id::text, ''),
    coalesce(e.before::text, ''),
    coalesce(e.after::text, ''),
    coalesce(host(e.ip), ''),
    coalesce(e.user_agent, ''),
    e.outcome,
    coalesce(e.details::text, ''),
    coalesce(encode(prev, 'hex'), '')
  ), 'UTF8'))
$$;

-- Runs as the owner so it can see the previous row regardless of the caller's RLS scope.
-- The advisory lock serialises inserts so id order == chain order.
create or replace function audit_event_chain() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  prev bytea;
begin
  perform pg_advisory_xact_lock(7745001);
  new.id := nextval('audit_event_id_seq');
  new.at := clock_timestamp();
  select hash into prev from audit_event order by id desc limit 1;
  new.prev_hash := prev;
  new.hash := audit_event_digest(new, prev);
  return new;
end
$$;

create trigger audit_event_chain before insert on audit_event
for each row execute function audit_event_chain();

create or replace function audit_event_immutable() returns trigger
language plpgsql as $$
begin
  raise exception 'audit_event is append-only' using errcode = 'insufficient_privilege';
end
$$;

create trigger audit_event_no_update before update or delete on audit_event
for each row execute function audit_event_immutable();
create trigger audit_event_no_truncate before truncate on audit_event
for each statement execute function audit_event_immutable();

create or replace function audit_verify_chain()
returns table (checked bigint, first_bad_id bigint)
language plpgsql security definer set search_path = public as $$
declare
  r audit_event;
  prev bytea := null;
  n bigint := 0;
begin
  for r in select * from audit_event order by id loop
    n := n + 1;
    if r.prev_hash is distinct from prev or r.hash <> audit_event_digest(r, prev) then
      checked := n;
      first_bad_id := r.id;
      return next;
      return;
    end if;
    prev := r.hash;
  end loop;
  checked := n;
  first_bad_id := null;
  return next;
end
$$;

-- ---------------------------------------------------------------------------
-- Backups (BKP-01..05)
-- ---------------------------------------------------------------------------
create table backup_run (
  id uuid primary key,
  kind text not null check (kind in ('manual', 'scheduled', 'restore_test')),
  status text not null check (status in ('requested', 'running', 'succeeded', 'failed')),
  requested_by uuid references user_account (id),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  object_key text,
  size_bytes bigint,
  sha256 bytea,
  schema_version text,
  details jsonb,
  error text
);
create index backup_run_created on backup_run (created_at desc);

-- ---------------------------------------------------------------------------
-- Optimistic concurrency triggers
-- ---------------------------------------------------------------------------
create trigger company_group_touch before update on company_group for each row execute function touch_row();
create trigger company_touch before update on company for each row execute function touch_row();
create trigger department_touch before update on department for each row execute function touch_row();
create trigger work_location_touch before update on work_location for each row execute function touch_row();
create trigger user_account_touch before update on user_account for each row execute function touch_row();
create trigger role_touch before update on role for each row execute function touch_row();
create trigger setting_value_touch before update on setting_value for each row execute function touch_row();

-- ---------------------------------------------------------------------------
-- Row-level security (company isolation, second layer behind the policy service)
-- ---------------------------------------------------------------------------
alter table company enable row level security;
alter table company force row level security;
create policy company_isolation on company
  using (app_can_see_company(id))
  with check (app_group_scope());

alter table department enable row level security;
alter table department force row level security;
create policy department_isolation on department
  using (app_can_see_company(company_id))
  with check (app_can_see_company(company_id));

alter table work_location enable row level security;
alter table work_location force row level security;
create policy work_location_isolation on work_location
  using (app_can_see_company(company_id))
  with check (app_can_see_company(company_id));

alter table module_company_state enable row level security;
alter table module_company_state force row level security;
create policy module_company_state_isolation on module_company_state
  using (app_can_see_company(company_id))
  with check (app_can_see_company(company_id));

alter table setting_value enable row level security;
alter table setting_value force row level security;
create policy setting_value_isolation on setting_value
  using (company_id is null or app_can_see_company(company_id))
  with check ((company_id is null and app_group_scope()) or app_can_see_company(company_id));

alter table role_assignment enable row level security;
alter table role_assignment force row level security;
create policy role_assignment_isolation on role_assignment
  using (company_id is null or app_can_see_company(company_id))
  with check (app_group_scope() or (company_id is not null and app_can_see_company(company_id)));

-- Not FORCEd: the owner-run chain trigger and verifier must see every row.
alter table audit_event enable row level security;
create policy audit_event_read on audit_event for select
  using (app_group_scope() or (company_id is not null and company_id = any(app_company_ids())));
create policy audit_event_insert on audit_event for insert
  with check (true);

-- ---------------------------------------------------------------------------
-- Privileges for the runtime role (least privilege; no DELETE except where noted)
-- ---------------------------------------------------------------------------
grant usage on schema public to hrms_app;
grant select, insert, update on
  company_group, company, department, work_location,
  user_account, mfa_recovery_code, session,
  role, role_assignment, module, module_company_state, setting_value, backup_run
  to hrms_app;
grant select on permission to hrms_app;
grant select, insert, delete on role_permission to hrms_app;
grant delete on setting_value, module_company_state to hrms_app;
grant select, insert on audit_event to hrms_app;
grant execute on function audit_verify_chain() to hrms_app;
