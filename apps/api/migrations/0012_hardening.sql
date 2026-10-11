-- 0012 Hardening (Phase 12): fixes from the security review.

-- Approvals: further users who may not approve a request (e.g. everyone who prepared a payroll).
alter table workflow_instance add column excluded_user_ids uuid[] not null default '{}';

-- Contracts: the text of a version cannot change once it was sent for signature (not only
-- after it is fully signed); only its status, signed copy and lock may change.
create or replace function contract_version_immutable() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'contract versions cannot be deleted' using errcode = '55000';
  end if;
  if old.locked_at is not null then
    raise exception 'signed contract versions are immutable' using errcode = '55000';
  end if;
  if old.status <> 'draft' and (new.body is distinct from old.body or new.body_sha256 is distinct from old.body_sha256
      or new.effective_date is distinct from old.effective_date or new.end_date is distinct from old.end_date) then
    raise exception 'a contract version sent for signature cannot be edited' using errcode = '55000';
  end if;
  return new;
end
$$;

-- Payroll: payments only against approved runs.
create or replace function payroll_payment_check() returns trigger
language plpgsql as $$
begin
  if not exists (select 1 from payroll_line l join payroll_run r on r.id = l.run_id where l.id = new.line_id and r.status = 'approved') then
    raise exception 'payments are recorded for approved payroll only' using errcode = '55000';
  end if;
  return new;
end
$$;
create trigger payroll_payment_approved_only before insert on payroll_payment
for each row execute function payroll_payment_check();
