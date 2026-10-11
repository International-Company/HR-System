-- 0009 Recruitment (Phase 9): vacancies, candidates, applications with an append-only event
-- history, interviews, offers. Internal only (Q-11). Candidate files use the document store.

create table vacancy (
  id uuid primary key,
  company_id uuid not null references company (id),
  department_id uuid,
  job_title_id uuid references lookup_value (id),
  employment_category_id uuid references lookup_value (id),
  contract_type_id uuid references lookup_value (id),
  work_location_id uuid,
  title text not null,
  description text not null default '',
  openings integer not null check (openings > 0),
  status text not null default 'draft' check (status in ('draft', 'open', 'on_hold', 'closed', 'filled')),
  required_document_category_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  foreign key (company_id, department_id) references department (company_id, id),
  foreign key (company_id, work_location_id) references work_location (company_id, id)
);
create index vacancy_company on vacancy (company_id, status);

create table candidate (
  id uuid primary key,
  company_id uuid not null references company (id),
  full_name_ar text not null,
  full_name_en text not null,
  email citext,
  phone text,
  nationality text,
  source text not null check (source in ('direct', 'referral', 'agency', 'website', 'other')),
  notes text not null default '',
  employee_id uuid references employee (id),
  -- Storage limitation (GDPR, C-20): reviewed for deletion after this date unless hired.
  retain_until date not null,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
create index candidate_company on candidate (company_id);
create unique index candidate_employee on candidate (employee_id) where employee_id is not null;

create table job_application (
  id uuid primary key,
  vacancy_id uuid not null references vacancy (id),
  candidate_id uuid not null references candidate (id),
  company_id uuid not null references company (id),
  stage text not null,
  outcome text not null default 'open' check (outcome in ('open', 'accepted', 'rejected', 'withdrawn')),
  employee_id uuid references employee (id),
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  unique (vacancy_id, candidate_id)
);
create index job_application_vacancy on job_application (vacancy_id);

-- Stage changes, notes, interview results, offers and conversion: append-only (REC-03).
create table application_event (
  id uuid primary key,
  application_id uuid not null references job_application (id),
  kind text not null check (kind in ('stage', 'note', 'interview', 'offer', 'converted')),
  stage text,
  text text,
  created_at timestamptz not null default now(),
  created_by uuid references user_account (id)
);
create index application_event_app on application_event (application_id, created_at);
create trigger application_event_append_only before update or delete on application_event
for each row execute function audit_event_immutable();

create table interview (
  id uuid primary key,
  application_id uuid not null references job_application (id),
  company_id uuid not null references company (id),
  scheduled_at timestamptz not null,
  duration_minutes integer not null,
  mode text not null check (mode in ('in_person', 'phone', 'video')),
  location text,
  interviewer_user_ids uuid[] not null,
  status text not null default 'scheduled' check (status in ('scheduled', 'done', 'cancelled')),
  result text check (result in ('pass', 'fail', 'hold')),
  score integer check (score between 1 and 5),
  feedback text,
  recorded_by uuid references user_account (id),
  recorded_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid
);
create index interview_application on interview (application_id);

create table job_offer (
  id uuid primary key,
  application_id uuid not null references job_application (id),
  company_id uuid not null references company (id),
  base_salary numeric(18, 4) not null check (base_salary >= 0),
  currency char(3) not null,
  start_date date not null,
  job_title_id uuid references lookup_value (id),
  notes text,
  status text not null default 'draft'
    check (status in ('draft', 'pending_approval', 'approved', 'sent', 'accepted', 'declined', 'withdrawn')),
  workflow_instance_id uuid references workflow_instance (id),
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now()
);
create index job_offer_application on job_offer (application_id);

-- Candidate files are documents linked to the candidate (and to the employee after hiring).
alter table document_link drop constraint document_link_entity_type_check;
alter table document_link add constraint document_link_entity_type_check check (entity_type in ('employee', 'candidate'));

-- A recruitment category for CVs (any category can be required per vacancy, REC-07).
insert into document_category (id, code, name_ar, name_en, allowed_types, max_size_mb, sensitivity, employee_visible, has_expiry)
values (gen_random_uuid(), 'cv', 'السيرة الذاتية', 'CV / résumé', '{pdf,docx,jpg,png}', 10, 'normal', false, false)
on conflict do nothing;

-- Offer approval route (configurable): another HR user (skippable) → company manager.
insert into workflow_definition (id, key, subject_type, name_ar, name_en, locked)
values ('00000000-0000-7000-8000-00000000000a', 'recruitment.offer', 'job_offer', 'عرض عمل', 'Job offer', false);
insert into workflow_step (id, definition_id, seq, approver_rule, role_key, skip_if_unresolved, name_ar, name_en) values
  (gen_random_uuid(), '00000000-0000-7000-8000-00000000000a', 1, 'role_in_company', 'hr', true, 'الموارد البشرية', 'Human resources'),
  (gen_random_uuid(), '00000000-0000-7000-8000-00000000000a', 2, 'role_in_company', 'company_manager', false, 'مدير الشركة', 'Company manager');

-- Interviewers may read what they interview for, even outside their company scope.
create or replace function app_is_interviewer(aid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from interview i where i.application_id = aid and app_user_id() = any(i.interviewer_user_ids))
$$;

alter table vacancy enable row level security;
alter table vacancy force row level security;
create policy vacancy_access on vacancy
  using (app_can_see_company(company_id) or exists (select 1 from job_application a where a.vacancy_id = vacancy.id and app_is_interviewer(a.id)))
  with check (app_can_see_company(company_id));

alter table candidate enable row level security;
alter table candidate force row level security;
create policy candidate_access on candidate
  using (app_can_see_company(company_id) or exists (select 1 from job_application a where a.candidate_id = candidate.id and app_is_interviewer(a.id)))
  with check (app_can_see_company(company_id));

alter table job_application enable row level security;
alter table job_application force row level security;
create policy job_application_access on job_application
  using (app_can_see_company(company_id) or app_is_interviewer(id))
  with check (app_can_see_company(company_id) or app_is_interviewer(id));

alter table application_event enable row level security;
alter table application_event force row level security;
create policy application_event_access on application_event
  using (exists (select 1 from job_application a where a.id = application_id))
  with check (exists (select 1 from job_application a where a.id = application_id));

alter table interview enable row level security;
alter table interview force row level security;
create policy interview_access on interview
  using (app_can_see_company(company_id) or app_user_id() = any(interviewer_user_ids))
  with check (app_can_see_company(company_id) or app_user_id() = any(interviewer_user_ids));

alter table job_offer enable row level security;
alter table job_offer force row level security;
create policy job_offer_access on job_offer
  using (app_can_see_company(company_id) or app_is_workflow_participant(workflow_instance_id))
  with check (app_can_see_company(company_id) or app_is_workflow_participant(workflow_instance_id));

grant select, insert, update on vacancy, candidate, job_application, interview, job_offer to hrms_app;
grant select, insert on application_event to hrms_app;
