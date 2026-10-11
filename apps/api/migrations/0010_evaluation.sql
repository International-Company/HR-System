-- 0010 Attendance commitment evaluation (Phase 10): one result per employee and period, with
-- the attendance inputs it was calculated from (scores reproduce from inputs).

create table evaluation_result (
  id uuid primary key,
  employee_id uuid not null references employee (id),
  company_id uuid not null references company (id),
  period text not null check (period ~ '^\d{4}-(0[1-9]|1[0-2]|Q[1-4])$'),
  period_start date not null,
  period_end date not null,
  score numeric(5, 2) not null check (score between 0 and 100),
  band jsonb not null,
  components jsonb not null,
  inputs jsonb not null,
  policy jsonb not null,
  status text not null default 'draft' check (status in ('draft', 'final')),
  calc_version integer not null default 1,
  calculated_at timestamptz not null default now(),
  calculated_by uuid references user_account (id),
  finalized_at timestamptz,
  finalized_by uuid references user_account (id),
  unique (employee_id, company_id, period)
);
create index evaluation_result_company on evaluation_result (company_id, period);

alter table evaluation_result enable row level security;
alter table evaluation_result force row level security;
create policy evaluation_result_access on evaluation_result
  using (app_can_see_company(company_id) or employee_id = app_employee_id())
  with check (app_can_see_company(company_id));

grant select, insert, update on evaluation_result to hrms_app;
