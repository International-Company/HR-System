-- 0007 Payroll (Phase 7): runs per company and month, lines with items and input snapshots,
-- manual items, payments history. Approved runs are locked by the database (PAY-05, NEG-07).

create table payroll_run (
  id uuid primary key,
  company_id uuid not null references company (id),
  period text not null check (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  period_start date not null,
  period_end date not null,
  revision integer not null default 1,
  revision_of_id uuid references payroll_run (id),
  status text not null default 'draft' check (status in ('draft', 'submitted', 'approved', 'superseded')),
  fx_rates jsonb not null default '{}',
  workflow_instance_id uuid references workflow_instance (id),
  calculated_at timestamptz,
  locked_at timestamptz,
  reopen_reason text,
  reopened_by uuid references user_account (id),
  created_at timestamptz not null default now(),
  created_by uuid not null references user_account (id),
  check (period_end >= period_start)
);
-- One current run per company and month (older revisions are superseded).
create unique index payroll_run_current on payroll_run (company_id, period) where status <> 'superseded';

create table payroll_line (
  id uuid primary key,
  run_id uuid not null references payroll_run (id),
  employee_id uuid not null references employee (id),
  company_id uuid not null references company (id),
  currency char(3) not null,
  days_paid integer not null,
  period_days integer not null,
  gross numeric(18, 2) not null,
  deductions numeric(18, 2) not null,
  net numeric(18, 2) not null,
  warnings text[] not null default '{}',
  -- Everything the calculation used, so a locked run is reproducible (P7 acceptance).
  inputs jsonb not null,
  unique (run_id, employee_id)
);
create index payroll_line_employee on payroll_line (employee_id);

create table payroll_item (
  id uuid primary key,
  line_id uuid not null references payroll_line (id),
  kind text not null check (kind in ('earning', 'deduction')),
  source text not null check (source in ('base', 'recurring', 'attendance', 'leave', 'manual')),
  code text not null,
  label text not null,
  quantity numeric(12, 2),
  rate numeric(18, 4),
  amount numeric(18, 2) not null,
  explanation text not null,
  -- The manual item this line item comes from (no FK: drafts are recalculated freely).
  manual_item_id uuid,
  seq integer not null
);
create index payroll_item_line on payroll_item (line_id);

-- Bonuses and one-off deductions entered before approval; kept across recalculations.
create table payroll_manual_item (
  id uuid primary key,
  run_id uuid not null references payroll_run (id),
  employee_id uuid not null references employee (id),
  kind text not null check (kind in ('earning', 'deduction')),
  label text not null,
  amount numeric(18, 2) not null check (amount > 0),
  note text,
  created_at timestamptz not null default now(),
  created_by uuid not null references user_account (id)
);
create index payroll_manual_item_run on payroll_manual_item (run_id);

-- Payment records (PAY-06): append-only history, the latest row is the current status.
create table payroll_payment (
  id uuid primary key,
  line_id uuid not null references payroll_line (id),
  status text not null check (status in ('pending', 'paid', 'failed', 'cancelled')),
  method text not null check (method in ('bank_transfer', 'cash', 'cheque')),
  reference text,
  paid_on date,
  amount numeric(18, 2) not null,
  currency char(3) not null,
  note text,
  created_at timestamptz not null default now(),
  created_by uuid not null references user_account (id)
);
create index payroll_payment_line on payroll_payment (line_id, created_at);
create trigger payroll_payment_append_only before update or delete on payroll_payment
for each row execute function audit_event_immutable();

-- Locks ------------------------------------------------------------------------------------
create or replace function payroll_run_locked(rid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from payroll_run where id = rid and locked_at is not null)
$$;

create or replace function payroll_child_lock() returns trigger
language plpgsql as $$
declare
  rid uuid;
begin
  if tg_table_name = 'payroll_item' then
    select run_id into rid from payroll_line where id = coalesce(new.line_id, old.line_id);
  else
    rid := coalesce(new.run_id, old.run_id);
  end if;
  if payroll_run_locked(rid) then
    raise exception 'approved payroll is locked' using errcode = '55000';
  end if;
  return coalesce(new, old);
end
$$;
create trigger payroll_line_lock before insert or update or delete on payroll_line
for each row execute function payroll_child_lock();
create trigger payroll_item_lock before insert or update or delete on payroll_item
for each row execute function payroll_child_lock();
create trigger payroll_manual_item_lock before insert or update or delete on payroll_manual_item
for each row execute function payroll_child_lock();

-- A locked run may only become "superseded" by a reopened revision.
create or replace function payroll_run_lock() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'payroll runs cannot be deleted' using errcode = '55000';
  end if;
  if old.locked_at is not null and (
    new.status <> 'superseded' or new.period is distinct from old.period or new.company_id is distinct from old.company_id
    or new.locked_at is distinct from old.locked_at or new.fx_rates is distinct from old.fx_rates
    or new.calculated_at is distinct from old.calculated_at
  ) then
    raise exception 'approved payroll is locked' using errcode = '55000';
  end if;
  return new;
end
$$;
create trigger payroll_run_lock before update or delete on payroll_run
for each row execute function payroll_run_lock();

-- Approval route (configurable): another finance user (skippable) → company manager.
insert into workflow_definition (id, key, subject_type, name_ar, name_en, locked)
values ('00000000-0000-7000-8000-000000000004', 'payroll.run', 'payroll_run', 'اعتماد مسير الرواتب', 'Payroll approval', false);
insert into workflow_step (id, definition_id, seq, approver_rule, role_key, skip_if_unresolved, name_ar, name_en) values
  (gen_random_uuid(), '00000000-0000-7000-8000-000000000004', 1, 'role_in_company', 'finance', true, 'المالية', 'Finance'),
  (gen_random_uuid(), '00000000-0000-7000-8000-000000000004', 2, 'role_in_company', 'company_manager', false, 'مدير الشركة', 'Company manager');

-- ---------------------------------------------------------------------------
-- RLS: runs and lines by company; employees see their own lines (payslips) only.
-- ---------------------------------------------------------------------------
alter table payroll_run enable row level security;
alter table payroll_run force row level security;
create policy payroll_run_access on payroll_run
  using (app_can_see_company(company_id) or exists (select 1 from payroll_line l where l.run_id = payroll_run.id and l.employee_id = app_employee_id())
         or app_is_workflow_participant(workflow_instance_id))
  with check (app_can_see_company(company_id) or app_is_workflow_participant(workflow_instance_id));

alter table payroll_line enable row level security;
alter table payroll_line force row level security;
create policy payroll_line_access on payroll_line
  using (app_can_see_company(company_id) or employee_id = app_employee_id())
  with check (app_can_see_company(company_id));

alter table payroll_item enable row level security;
alter table payroll_item force row level security;
create policy payroll_item_access on payroll_item
  using (exists (select 1 from payroll_line l where l.id = line_id))
  with check (exists (select 1 from payroll_line l where l.id = line_id));

alter table payroll_manual_item enable row level security;
alter table payroll_manual_item force row level security;
create policy payroll_manual_item_access on payroll_manual_item
  using (exists (select 1 from payroll_run r where r.id = run_id and app_can_see_company(r.company_id)))
  with check (exists (select 1 from payroll_run r where r.id = run_id and app_can_see_company(r.company_id)));

alter table payroll_payment enable row level security;
alter table payroll_payment force row level security;
create policy payroll_payment_access on payroll_payment
  using (exists (select 1 from payroll_line l where l.id = line_id))
  with check (exists (select 1 from payroll_line l where l.id = line_id and app_can_see_company(l.company_id)));

grant select, insert, update on payroll_run to hrms_app;
grant select, insert, delete on payroll_line, payroll_item, payroll_manual_item to hrms_app;
grant select, insert on payroll_payment to hrms_app;
