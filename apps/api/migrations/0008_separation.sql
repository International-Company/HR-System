-- 0008 Separation & rehire (Phase 8): separations with per-type approval routes, exit access
-- policy, visibility of former employees. History is never deleted (TRM-06).

-- Former employees stay visible to the company where they last worked (TRM-06, TRM-07).
-- Previously only open assignments counted, so HR lost sight of people after their last day.
create or replace function app_can_see_employee(eid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select app_group_scope()
      or eid = app_employee_id()
      or exists (
        select 1 from employment_assignment a
        where a.employee_id = eid
          and a.company_id = any(app_company_ids())
          and (
            a.valid_to is null or a.valid_to >= current_date
            -- the latest assignment of a person who no longer works anywhere in the group
            or not exists (select 1 from employment_assignment b where b.employee_id = eid and b.valid_from > a.valid_from)
          )
      )
$$;

create table separation (
  id uuid primary key,
  employee_id uuid not null references employee (id),
  company_id uuid not null references company (id),
  type text not null check (type in ('resignation', 'termination', 'contract_end', 'retirement', 'other')),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled', 'completed')),
  last_working_day date not null,
  reason text not null,
  rehire_eligible boolean not null default true,
  -- Assignment end date before the separation, restored if it is cancelled.
  previous_valid_to date,
  assignment_id uuid references employment_assignment (id),
  settlement jsonb,
  initiated_by uuid not null references user_account (id),
  initiated_by_self boolean not null default false,
  workflow_instance_id uuid references workflow_instance (id),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  cancelled_by uuid references user_account (id),
  cancel_reason text
);
create index separation_company on separation (company_id, status);
-- At most one open separation per employee.
create unique index separation_open on separation (employee_id) where status in ('pending', 'approved');

-- Exit access policy (TRM-05): owner-run because SELF/GROUP role grants and devices without a
-- company are outside HR's row scope. Acts only on an approved separation that is due.
create or replace function separation_apply_exit(sid uuid, keep_self_service boolean, revoke_devices boolean) returns integer
language plpgsql security definer set search_path = public as $$
declare
  s separation%rowtype;
  n integer := 0;
  u record;
begin
  select * into s from separation where id = sid;
  -- The app decides with the configured timezone; the database only refuses future dates.
  if not found or s.status <> 'approved' or s.last_working_day > current_date then
    raise exception 'separation is not due' using errcode = '55000';
  end if;
  for u in select id from user_account where employee_id = s.employee_id loop
    -- End on the last working day, but never before the grant started.
    update role_assignment set ended_at = now(), valid_to = greatest(valid_from, least(coalesce(valid_to, s.last_working_day), s.last_working_day))
      where user_id = u.id and ended_at is null
        and (not keep_self_service or scope_type <> 'SELF');
    if not keep_self_service then
      update user_account set status = 'disabled' where id = u.id and status <> 'disabled';
    end if;
    update session set revoked_at = now(), revoked_reason = 'separation' where user_id = u.id and revoked_at is null;
    if revoke_devices then
      update attendance_device set status = 'revoked', revoked_at = now() where user_id = u.id and status <> 'revoked';
    end if;
    n := n + 1;
  end loop;
  return n;
end
$$;
grant execute on function separation_apply_exit(uuid, boolean, boolean) to hrms_app;

-- Approval routes per type (configurable in the app, TRM-01/TRM-04).
insert into workflow_definition (id, key, subject_type, name_ar, name_en, locked) values
  ('00000000-0000-7000-8000-000000000005', 'separation.resignation', 'separation', 'استقالة', 'Resignation', false),
  ('00000000-0000-7000-8000-000000000006', 'separation.termination', 'separation', 'إنهاء خدمة', 'Termination', false),
  ('00000000-0000-7000-8000-000000000007', 'separation.contract_end', 'separation', 'انتهاء العقد', 'End of contract', false),
  ('00000000-0000-7000-8000-000000000008', 'separation.retirement', 'separation', 'تقاعد', 'Retirement', false),
  ('00000000-0000-7000-8000-000000000009', 'separation.other', 'separation', 'إنهاء خدمة (أخرى)', 'Separation (other)', false);
insert into workflow_step (id, definition_id, seq, approver_rule, role_key, skip_if_unresolved, name_ar, name_en) values
  (gen_random_uuid(), '00000000-0000-7000-8000-000000000005', 1, 'direct_manager', null, true, 'المدير المباشر', 'Direct manager'),
  (gen_random_uuid(), '00000000-0000-7000-8000-000000000005', 2, 'role_in_company', 'hr', false, 'الموارد البشرية', 'Human resources'),
  (gen_random_uuid(), '00000000-0000-7000-8000-000000000006', 1, 'role_in_company', 'hr', true, 'الموارد البشرية', 'Human resources'),
  (gen_random_uuid(), '00000000-0000-7000-8000-000000000006', 2, 'role_in_company', 'company_manager', false, 'مدير الشركة', 'Company manager'),
  -- HR usually starts these: another HR user if there is one, then the company manager.
  (gen_random_uuid(), '00000000-0000-7000-8000-000000000007', 1, 'role_in_company', 'hr', true, 'الموارد البشرية', 'Human resources'),
  (gen_random_uuid(), '00000000-0000-7000-8000-000000000007', 2, 'role_in_company', 'company_manager', false, 'مدير الشركة', 'Company manager'),
  (gen_random_uuid(), '00000000-0000-7000-8000-000000000008', 1, 'role_in_company', 'hr', true, 'الموارد البشرية', 'Human resources'),
  (gen_random_uuid(), '00000000-0000-7000-8000-000000000008', 2, 'role_in_company', 'company_manager', false, 'مدير الشركة', 'Company manager'),
  (gen_random_uuid(), '00000000-0000-7000-8000-000000000009', 1, 'role_in_company', 'hr', true, 'الموارد البشرية', 'Human resources'),
  (gen_random_uuid(), '00000000-0000-7000-8000-000000000009', 2, 'role_in_company', 'company_manager', false, 'مدير الشركة', 'Company manager');

alter table separation enable row level security;
alter table separation force row level security;
create policy separation_access on separation
  using (app_can_see_employee(employee_id) or app_is_workflow_participant(workflow_instance_id))
  with check (app_can_see_employee(employee_id) or app_is_workflow_participant(workflow_instance_id));

grant select, insert, update on separation to hrms_app;
