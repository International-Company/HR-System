-- 0006 Contracts (Phase 6): type rules, clauses, templates, contracts, immutable signed
-- versions, signatures with evidence, alert log.

-- Rules per contract type (the types themselves are the contract_type lookup values).
create table contract_type_policy (
  contract_type_id uuid primary key references lookup_value (id),
  policy jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid
);

create table contract_clause (
  id uuid primary key,
  company_id uuid references company (id),
  code citext not null,
  title text not null,
  language text not null check (language in ('ar', 'en')),
  body text not null,
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1
);
create unique index contract_clause_code on contract_clause (coalesce(company_id, '00000000-0000-0000-0000-000000000000'::uuid), language, code);
create trigger contract_clause_touch before update on contract_clause for each row execute function touch_row();

create table contract_template (
  id uuid primary key,
  company_id uuid references company (id),
  contract_type_id uuid not null references lookup_value (id),
  code citext not null,
  name text not null,
  language text not null check (language in ('ar', 'en')),
  body text not null,
  fields jsonb not null default '[]',
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1
);
create unique index contract_template_code on contract_template (coalesce(company_id, '00000000-0000-0000-0000-000000000000'::uuid), code);
create trigger contract_template_touch before update on contract_template for each row execute function touch_row();

-- Group-wide contract numbers (CTR-000001), like employee numbers.
create table contract_number_sequence (
  singleton boolean primary key default true check (singleton),
  next_value bigint not null
);
insert into contract_number_sequence values (true, 1);

create table contract (
  id uuid primary key,
  contract_no text not null unique,
  company_id uuid not null references company (id),
  employee_id uuid not null references employee (id),
  contract_type_id uuid not null references lookup_value (id),
  template_id uuid references contract_template (id),
  status text not null default 'draft'
    check (status in ('draft', 'awaiting_signature', 'active', 'expired', 'ended', 'renewed', 'cancelled')),
  start_date date not null,
  end_date date,
  probation_end date,
  probation_outcome text check (probation_outcome in ('confirmed', 'extended', 'not_confirmed')),
  probation_note text,
  renewal_of_id uuid references contract (id),
  end_reason text,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  check (end_date is null or end_date >= start_date)
);
create index contract_employee on contract (employee_id);
create index contract_company_status on contract (company_id, status, end_date);

create or replace function next_contract_no(prefix text) returns text
language plpgsql security definer set search_path = public as $$
declare
  n bigint;
  candidate text;
begin
  loop
    update contract_number_sequence set next_value = next_value + 1
      where singleton returning next_value - 1 into n;
    candidate := prefix || lpad(n::text, 6, '0');
    exit when not exists (select 1 from contract where contract_no = candidate);
  end loop;
  return candidate;
end
$$;

-- Versions: original, addenda, extensions. Once locked (fully signed) a version can never
-- change (CON-06, NEG-08).
create table contract_version (
  id uuid primary key,
  contract_id uuid not null references contract (id),
  version_no integer not null,
  kind text not null check (kind in ('original', 'addendum', 'extension', 'auto_renewal')),
  status text not null default 'draft' check (status in ('draft', 'awaiting_signature', 'signed', 'cancelled')),
  language text not null check (language in ('ar', 'en')),
  body text not null,
  body_sha256 text not null,
  field_values jsonb not null default '{}',
  effective_date date not null,
  end_date date,
  signed_copy_id uuid references document (id),
  locked_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid,
  unique (contract_id, version_no)
);

create or replace function contract_version_immutable() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'contract versions cannot be deleted' using errcode = '55000';
  end if;
  if old.locked_at is not null then
    raise exception 'signed contract versions are immutable' using errcode = '55000';
  end if;
  return new;
end
$$;
create trigger contract_version_lock before update or delete on contract_version
for each row execute function contract_version_immutable();

-- Signatures with evidence (CON-03). A completed signature cannot change.
create table contract_signature (
  id uuid primary key,
  version_id uuid not null references contract_version (id),
  role text not null check (role in ('employee', 'company')),
  status text not null default 'pending' check (status in ('pending', 'signed')),
  method text check (method in ('in_app', 'upload', 'system')),
  signer_user_id uuid references user_account (id),
  typed_name text,
  signed_at timestamptz,
  ip inet,
  user_agent text,
  document_hash text,
  unique (version_id, role)
);

create or replace function contract_signature_immutable() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' or old.status = 'signed' then
    raise exception 'completed signatures are immutable' using errcode = '55000';
  end if;
  return new;
end
$$;
create trigger contract_signature_lock before update or delete on contract_signature
for each row execute function contract_signature_immutable();

-- Alerts already sent (one per contract, kind and threshold).
create table contract_alert (
  contract_id uuid not null references contract (id),
  kind text not null check (kind in ('expiry', 'probation')),
  days_before integer not null,
  due_date date not null,
  sent_at timestamptz not null default now(),
  primary key (contract_id, kind, days_before, due_date)
);

-- Default rules for the seeded contract types.
insert into contract_type_policy (contract_type_id, policy)
select id, '{"renewal":"extend","autoRenew":false,"autoRenewMonths":12,"signers":["employee","company"],"defaultDurationMonths":12,"probationDays":90,"retentionYears":10}'::jsonb
from lookup_value where kind = 'contract_type' and code = 'fixed_term';
insert into contract_type_policy (contract_type_id, policy)
select id, '{"renewal":"extend","autoRenew":false,"autoRenewMonths":12,"signers":["employee","company"],"defaultDurationMonths":null,"probationDays":90,"retentionYears":10}'::jsonb
from lookup_value where kind = 'contract_type' and code = 'open_ended';

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table contract_type_policy enable row level security;
alter table contract_type_policy force row level security;
create policy contract_type_policy_read on contract_type_policy for select using (true);
create policy contract_type_policy_write on contract_type_policy for insert with check (app_group_scope());
create policy contract_type_policy_update on contract_type_policy for update using (app_group_scope()) with check (app_group_scope());

alter table contract_clause enable row level security;
alter table contract_clause force row level security;
create policy contract_clause_access on contract_clause
  using (company_id is null or app_can_see_company(company_id))
  with check ((company_id is null and app_group_scope()) or (company_id is not null and app_can_see_company(company_id)));

alter table contract_template enable row level security;
alter table contract_template force row level security;
create policy contract_template_access on contract_template
  using (company_id is null or app_can_see_company(company_id))
  with check ((company_id is null and app_group_scope()) or (company_id is not null and app_can_see_company(company_id)));

-- Contracts follow the employee (own contracts, or staff of a company the employee is in).
alter table contract enable row level security;
alter table contract force row level security;
create policy contract_access on contract
  using (app_can_see_employee(employee_id) or app_can_see_company(company_id))
  with check (app_can_see_company(company_id) or employee_id = app_employee_id());

alter table contract_version enable row level security;
alter table contract_version force row level security;
create policy contract_version_access on contract_version
  using (exists (select 1 from contract c where c.id = contract_id))
  with check (exists (select 1 from contract c where c.id = contract_id));

alter table contract_signature enable row level security;
alter table contract_signature force row level security;
create policy contract_signature_access on contract_signature
  using (exists (select 1 from contract_version v where v.id = version_id))
  with check (exists (select 1 from contract_version v where v.id = version_id));

alter table contract_alert enable row level security;
alter table contract_alert force row level security;
create policy contract_alert_access on contract_alert
  using (exists (select 1 from contract c where c.id = contract_id))
  with check (exists (select 1 from contract c where c.id = contract_id));

grant select, insert, update on contract_type_policy, contract_clause, contract_template, contract,
  contract_version, contract_signature to hrms_app;
grant select, insert on contract_alert to hrms_app;
