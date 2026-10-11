-- 0011 Reports (Phase 11): saved reports per user, outputs of scheduled reports delivered to
-- the notification centre (C-03). Personal: only the owner sees them.

create table saved_report (
  id uuid primary key,
  user_id uuid not null references user_account (id),
  name text not null,
  dataset text not null,
  fields text[] not null,
  filters jsonb not null,
  schedule jsonb,
  last_run_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index saved_report_user on saved_report (user_id);

-- Generated files of scheduled reports, kept 30 days.
create table report_output (
  id uuid primary key,
  report_id uuid not null references saved_report (id),
  user_id uuid not null references user_account (id),
  file_name text not null,
  mime text not null,
  body bytea not null,
  row_count integer not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index report_output_user on report_output (user_id, created_at);

alter table saved_report enable row level security;
alter table saved_report force row level security;
create policy saved_report_owner on saved_report
  using (user_id = app_user_id() or app_group_scope()) with check (user_id = app_user_id() or app_group_scope());

alter table report_output enable row level security;
alter table report_output force row level security;
create policy report_output_owner on report_output
  using (user_id = app_user_id()) with check (user_id = app_user_id() or app_group_scope());

grant select, insert, update, delete on saved_report to hrms_app;
grant select, insert on report_output to hrms_app;
