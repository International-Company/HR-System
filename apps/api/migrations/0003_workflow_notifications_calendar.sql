-- 0003 Workflow engine, notifications, work schedules, holidays, in-app restore (Phase 3).

create or replace function app_user_id() returns uuid
language sql stable as $$
  select nullif(current_setting('app.user_id', true), '')::uuid
$$;

-- ---------------------------------------------------------------------------
-- Workflow engine (D-17)
-- ---------------------------------------------------------------------------
create table workflow_definition (
  id uuid primary key,
  key text not null unique,
  subject_type text not null,
  name_ar text not null,
  name_en text not null,
  -- Locked definitions (e.g. leave, CF-06/C-05) cannot have their steps changed in the UI.
  locked boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1
);
create trigger workflow_definition_touch before update on workflow_definition for each row execute function touch_row();

create table workflow_step (
  id uuid primary key,
  definition_id uuid not null references workflow_definition (id),
  seq integer not null check (seq between 1 and 10),
  approver_rule text not null check (approver_rule in ('direct_manager', 'role_in_company', 'specific_user')),
  role_key text,
  user_id uuid references user_account (id),
  skip_if_unresolved boolean not null default true,
  name_ar text not null,
  name_en text not null,
  unique (definition_id, seq),
  check (approver_rule <> 'role_in_company' or role_key is not null),
  check (approver_rule <> 'specific_user' or user_id is not null)
);

create table workflow_instance (
  id uuid primary key,
  definition_id uuid not null references workflow_definition (id),
  company_id uuid not null references company (id),
  subject_type text not null,
  subject_id uuid not null,
  subject_employee_id uuid references employee (id),
  requester_user_id uuid not null references user_account (id),
  summary jsonb not null default '{}',
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  current_seq integer not null default 1,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index workflow_instance_subject on workflow_instance (subject_type, subject_id);
create index workflow_instance_company on workflow_instance (company_id, status);

create table workflow_task (
  id uuid primary key,
  instance_id uuid not null references workflow_instance (id),
  seq integer not null,
  assignee_user_id uuid references user_account (id),
  delegated_from_user_id uuid references user_account (id),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'skipped', 'cancelled')),
  decided_at timestamptz,
  decided_by uuid references user_account (id),
  comment text,
  created_at timestamptz not null default now()
);
create index workflow_task_assignee on workflow_task (assignee_user_id) where status = 'pending';
create index workflow_task_instance on workflow_task (instance_id, seq);

create table workflow_delegation (
  id uuid primary key,
  from_user_id uuid not null references user_account (id),
  to_user_id uuid not null references user_account (id),
  valid_from date not null,
  valid_to date not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  check (valid_to >= valid_from),
  check (from_user_id <> to_user_id)
);
create index workflow_delegation_from on workflow_delegation (from_user_id) where revoked_at is null;

-- Seeded definition for leave (Phase 5 uses it): Employee → Direct Manager → HR, locked (CF-06).
insert into workflow_definition (id, key, subject_type, name_ar, name_en, locked)
values ('00000000-0000-7000-8000-000000000001', 'leave.standard', 'leave_request', 'طلب إجازة', 'Leave request', true);
insert into workflow_step (id, definition_id, seq, approver_rule, role_key, skip_if_unresolved, name_ar, name_en) values
  (gen_random_uuid(), '00000000-0000-7000-8000-000000000001', 1, 'direct_manager', null, true, 'المدير المباشر', 'Direct manager'),
  (gen_random_uuid(), '00000000-0000-7000-8000-000000000001', 2, 'role_in_company', 'hr', false, 'الموارد البشرية', 'Human resources');

-- Is the current user assigned to (or delegated) a task of this instance? Owner-run so that
-- the instance and task policies do not reference each other recursively.
create or replace function app_is_workflow_participant(iid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from workflow_task t
    where t.instance_id = iid
      and (t.assignee_user_id = app_user_id() or t.delegated_from_user_id = app_user_id() or t.decided_by = app_user_id())
  )
$$;

-- Approver resolution runs as owner: deciders often cannot see the next approver's company
-- (e.g. a department manager routing to HR), and requesters never can.
create or replace function workflow_resolve_approvers(
  p_rule text, p_role text, p_user uuid, p_company uuid, p_employee uuid
) returns setof uuid
language sql stable security definer set search_path = public as $$
  select u.id from user_account u
  where u.status = 'active' and (
    (p_rule = 'specific_user' and u.id = p_user)
    or (p_rule = 'direct_manager' and u.employee_id is not null and u.employee_id = (
          select a.manager_employee_id from employee_current_assignment a where a.employee_id = p_employee))
    or (p_rule = 'role_in_company' and exists (
          select 1 from role_assignment ra join role r on r.id = ra.role_id
          where ra.user_id = u.id and r.key = p_role and ra.ended_at is null
            and ra.valid_from <= current_date and (ra.valid_to is null or ra.valid_to >= current_date)
            and (ra.scope_type = 'GROUP' or (ra.scope_type = 'COMPANY' and ra.company_id = p_company))))
  )
$$;

-- ---------------------------------------------------------------------------
-- Notifications (NOT-01..06). In-app + Web Push; e-mail prepared but disabled.
-- ---------------------------------------------------------------------------
create table notification (
  id uuid primary key,
  company_id uuid references company (id),
  event_type text not null,
  title_ar text not null,
  title_en text not null,
  body_ar text not null default '',
  body_en text not null default '',
  link text,
  entity_type text,
  entity_id uuid,
  created_at timestamptz not null default now()
);

create table notification_recipient (
  notification_id uuid not null references notification (id),
  user_id uuid not null references user_account (id),
  read_at timestamptz,
  push_sent_at timestamptz,
  primary key (notification_id, user_id)
);
create index notification_recipient_unread on notification_recipient (user_id) where read_at is null;
create index notification_recipient_push on notification_recipient (push_sent_at) where push_sent_at is null;

create table push_subscription (
  id uuid primary key,
  user_id uuid not null references user_account (id),
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_success_at timestamptz,
  failure_count integer not null default 0,
  revoked_at timestamptz
);

-- Application-generated secrets (e.g. Web Push VAPID keys), stored encrypted.
create table system_secret (
  key text primary key,
  value_enc bytea not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Work schedules & holidays (SCH-01..04)
-- ---------------------------------------------------------------------------
create table work_schedule (
  id uuid primary key,
  company_id uuid references company (id),
  code citext not null,
  name_ar text not null,
  name_en text not null,
  grace_in_minutes integer not null default 0 check (grace_in_minutes between 0 and 240),
  grace_out_minutes integer not null default 0 check (grace_out_minutes between 0 and 240),
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1
);
create unique index work_schedule_code on work_schedule (company_id, code) nulls not distinct;
create trigger work_schedule_touch before update on work_schedule for each row execute function touch_row();

-- Times are local times in the group time zone. end_time <= start_time means the shift
-- ends the next day (overnight).
create table schedule_day (
  schedule_id uuid not null references work_schedule (id),
  iso_weekday integer not null check (iso_weekday between 1 and 7),
  is_workday boolean not null,
  start_time time,
  end_time time,
  breaks jsonb not null default '[]',
  primary key (schedule_id, iso_weekday),
  check (not is_workday or (start_time is not null and end_time is not null and start_time <> end_time))
);

create table schedule_assignment (
  id uuid primary key,
  schedule_id uuid not null references work_schedule (id),
  target_type text not null check (target_type in ('company', 'department', 'employee')),
  company_id uuid not null references company (id),
  department_id uuid,
  employee_id uuid references employee (id),
  valid_from date not null,
  valid_to date,
  created_at timestamptz not null default now(),
  created_by uuid,
  ended_at timestamptz,
  ended_by uuid,
  foreign key (company_id, department_id) references department (company_id, id),
  check (valid_to is null or valid_to >= valid_from),
  check (
    (target_type = 'company' and department_id is null and employee_id is null)
    or (target_type = 'department' and department_id is not null and employee_id is null)
    or (target_type = 'employee' and employee_id is not null)
  ),
  -- One schedule per target at any date (history kept by closing periods, SCH-02).
  constraint schedule_assignment_no_overlap exclude using gist (
    target_type with =,
    (coalesce(employee_id, department_id, company_id)) with =,
    daterange(valid_from, valid_to, '[]') with &&
  )
);

create table holiday (
  id uuid primary key,
  company_id uuid references company (id),
  date date not null,
  name_ar text not null,
  name_en text not null,
  created_at timestamptz not null default now(),
  created_by uuid
);
create unique index holiday_unique on holiday (company_id, date) nulls not distinct;

-- ---------------------------------------------------------------------------
-- In-app restore (BKP-06, D-16b)
-- ---------------------------------------------------------------------------
create table restore_request (
  id uuid primary key,
  backup_run_id uuid not null references backup_run (id),
  status text not null check (status in ('awaiting_approval', 'requested', 'preparing', 'ready', 'switching', 'completed', 'failed', 'cancelled')),
  requested_by uuid not null references user_account (id),
  approved_by uuid references user_account (id),
  switch_confirmed_by uuid references user_account (id),
  scratch_database text,
  pre_restore_backup_id uuid references backup_run (id),
  details jsonb not null default '{}',
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (approved_by is null or approved_by <> requested_by)
);
-- Only one restore can be in progress.
create unique index restore_request_single_active on restore_request ((true))
  where status in ('awaiting_approval', 'requested', 'preparing', 'ready', 'switching');

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table workflow_instance enable row level security;
alter table workflow_instance force row level security;
create policy workflow_instance_access on workflow_instance
  using (
    app_can_see_company(company_id)
    or requester_user_id = app_user_id()
    or app_is_workflow_participant(id)
  )
  with check (
    app_can_see_company(company_id)
    or requester_user_id = app_user_id()
    or app_is_workflow_participant(id)
  );

alter table workflow_task enable row level security;
alter table workflow_task force row level security;
create policy workflow_task_access on workflow_task
  using (exists (select 1 from workflow_instance i where i.id = instance_id))
  with check (exists (select 1 from workflow_instance i where i.id = instance_id));

alter table notification enable row level security;
alter table notification force row level security;
-- A notification is readable by its recipients (and the group scope for system jobs).
create policy notification_access on notification
  using (
    app_group_scope()
    or exists (select 1 from notification_recipient r where r.notification_id = id and r.user_id = app_user_id())
  )
  with check (true);

alter table notification_recipient enable row level security;
alter table notification_recipient force row level security;
create policy notification_recipient_access on notification_recipient
  using (user_id = app_user_id() or app_group_scope())
  with check (true);

alter table push_subscription enable row level security;
alter table push_subscription force row level security;
create policy push_subscription_access on push_subscription
  using (user_id = app_user_id() or app_group_scope())
  with check (user_id = app_user_id() or app_group_scope());

alter table work_schedule enable row level security;
alter table work_schedule force row level security;
create policy work_schedule_isolation on work_schedule
  using (company_id is null or app_can_see_company(company_id))
  with check ((company_id is null and app_group_scope()) or app_can_see_company(company_id));

alter table schedule_assignment enable row level security;
alter table schedule_assignment force row level security;
create policy schedule_assignment_isolation on schedule_assignment
  using (app_can_see_company(company_id) or employee_id = app_employee_id())
  with check (app_can_see_company(company_id));

alter table holiday enable row level security;
alter table holiday force row level security;
create policy holiday_isolation on holiday
  using (company_id is null or app_can_see_company(company_id))
  with check ((company_id is null and app_group_scope()) or app_can_see_company(company_id));

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
grant select, update on workflow_definition to hrms_app;
grant select, insert, delete on workflow_step to hrms_app;
grant select, insert, update on workflow_instance, workflow_task, workflow_delegation to hrms_app;
grant select, insert on notification to hrms_app;
grant select, insert, update on notification_recipient, push_subscription to hrms_app;
grant select, insert on system_secret to hrms_app;
grant select, insert, update on work_schedule, schedule_assignment to hrms_app;
grant select, insert, update, delete on schedule_day to hrms_app;
grant select, insert, delete on holiday to hrms_app;
grant select, insert, update on restore_request to hrms_app;
