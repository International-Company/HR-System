# Development Progress Tracker

This tracker is for the development team. It is kept separate from the HR application (GOV-02). Updated at every status change.
Legend: ✅ Completed · 🔄 In progress · ⏳ Remaining · ⛔ Blocked · ❓ Awaiting decision/owner action

Last updated: 2026-10-10

| Phase | Status | Tests | Blocked by / waiting for |
|---|---|---|---|
| P0 Audit & planning | ✅ Approved (DL-015) | n/a | — |
| P1 Foundation | 🔄 Implementation complete; deployment-dependent acceptance items pending | 74 API + 2 web tests passing locally (embedded PostgreSQL); real-PostgreSQL CI run pending | ❓ Owner: GitHub repository URL, Railway staging setup, Backblaze B2 bucket (guide: [railway-setup-guide-ar.md](../08-operations/railway-setup-guide-ar.md)) |
| P2 Employees & documents | 🔄 Implementation complete (DL-021) | 101 API tests (26 new) + 2 web tests passing locally; live HTTP smoke test passed | ❓ Owner: Railway bucket for documents (guide 3.7); review of Phase 2 defaults (DL-022); staging walkthrough |
| P3 Workflow, notifications, schedules, in-app restore | ⏳ | — | Q-07, Q-08, Q-15, Q-28 |
| P4 Attendance | ⏳ | — | Q-04, Q-09, Q-17 |
| P5 Leave | ⏳ | — | Q-28 |
| P6 Contracts | ⏳ | — | Q-14, Q-22, Q-28 |
| P7 Payroll | ⏳ | — | Q-13, Q-24, Q-28 |
| P8 Separation & rehire | ⏳ | — | Q-27 |
| P9 Recruitment | ⏳ | — | Q-11 |
| P10 Commitment evaluation | ⏳ | — | — |
| P11 Reports, search, dashboards | ⏳ | — | — |
| P12 Hardening | ⏳ | — | — |
| P13 Pilot / UAT | ⏳ | — | Q-23; retention periods (C-20); GDPR owner items |
| P14 Release | ⏳ | — | Owner approval; Railway Pro plan confirmation |

## Phase 1 acceptance criteria (roadmap.md)

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Login, lockout, session list/revoke, idle timeout | ✅ | `test/auth.test.ts` (11 tests) |
| 2 | Companies/departments, custom roles, scoped assignments, audited before/after | ✅ | `authz.test.ts`, `settings-org.test.ts`, `audit.test.ts` |
| 3 | Authorization matrix + RLS tests in CI; table without RLS fails | ✅ locally / ⏳ first GitHub CI run | `authz.test.ts`, `isolation.test.ts`, `.github/workflows/ci.yml` |
| 4 | Audit append-only for the app role; hash chain verifies and detects tampering | ✅ | `audit.test.ts` |
| 5 | AR (RTL) / EN (LTR) by global setting; accessible shell | ✅ built / ⏳ visual + axe review on staging (no browser available in this environment) | `apps/web`, translation key test |
| 6 | Staging deploy via GitHub → Railway, pre-deploy migration, health check, rollback rehearsed | ⏳ owner setup | `Dockerfile`, `railway/*.json`, setup guide |
| 7 | Backup taken and restored with verified checks | ✅ code + CI test / ⏳ staging run | `backup.test.ts` (server-only test runs in CI), Backups page "Run restore test" |

## Phase 1 deliverables

| Area | Delivered |
|---|---|
| Repository | Git, npm workspaces monorepo, ESLint, Prettier, CI workflow, Dockerfile, Railway config-as-code |
| Organisation | Group, companies, optional departments (hierarchy, same-company parent, no cycles), work locations; deactivate-only |
| Identity | Argon2id passwords, NIST-style policy + blocklist, lockout, server sessions (idle/absolute timeout, remote revoke), forced password change, TOTP MFA with recovery codes, MFA required by role |
| Access | Permission catalogue in code, 8 locked system roles, custom roles, scoped assignments (group/company/department/self), group-only permissions, no self-escalation, last-admin protection |
| Isolation | Policy service + PostgreSQL RLS (forced) + least-privilege runtime role without DELETE |
| Settings | Typed settings with group values and company overrides; public settings for the login page; module registry with per-company enablement and disable policy |
| Audit | Append-only, hash-chained, redacted; audit of audit views; integrity verification (UI + daily job) |
| Backups | Encrypted streaming `pg_dump` to off-site S3 storage, manual/scheduled runs, automated restore tests into a scratch database |
| Web | Arabic/English PWA shell, collapsible sidebar, login/MFA/password flows, dashboard, companies, users, roles, settings, modules, audit, backups, my account |

## Phase 2 acceptance criteria (roadmap.md)

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Transfer keeps the employee number; history shows both assignments; old-company access rules respected | ✅ | `employees.test.ts` (transfer, immutable number, overlap) |
| 2 | Salary/bank fields never returned without the financial permission | ✅ | `employees.test.ts` (manager, finance, self) |
| 3 | Duplicate identity detection via blind index; values encrypted in the DB | ✅ | `employees.test.ts` (duplicate across companies, raw SQL check) |
| 4 | Uploads checked by type/size/content; replace/delete/restore per category; downloads authorised | ✅ | `documents.test.ts` (8 tests) |
| 5 | Overlapping assignments rejected by the database | ✅ | `employees.test.ts` |
| 6 | Import tooling | ➖ Not needed (DL-013: system starts empty) | — |

## Phase 2 deliverables

| Area | Delivered |
|---|---|
| Employees | Profile (AR/EN names, identity encrypted + masked, personal data), group-wide immutable numbers with configurable format, effective-dated employment (company, department, job title, manager, location, category, contract type/dates), transfers, job/department/manager/contract changes, promotions and salary changes with allowances/deductions, probation confirmation, suspension, long leave, return to work, lifecycle timeline, qualifications, bank accounts (encrypted; masked for the employee), user-account linking |
| Access | Company/department/self scopes per employee; financial, identity and medical data behind separate permissions; database RLS for every new table |
| Master lists | Job titles, employment categories, contract types, allowance and deduction types; group-wide or per company |
| Documents | Configurable categories (types, size, sensitivity, employee visibility, replace/delete rules, expiry field, retention), encrypted storage, content-type sniffing, superseded versions on replace, soft delete/restore, profile photos; no expiry notifications (DOC-04) |
| Web | Employees list with filters, new-employee form, profile with tabs (personal, employment & history, salary, bank, qualifications, documents, account), master lists and document categories admin, "My profile" for linked employees |
