# Development Progress Tracker

This tracker is for the development team. It is kept separate from the HR application (GOV-02). Updated at every status change.
Legend: ✅ Completed · 🔄 In progress · ⏳ Remaining · ⛔ Blocked · ❓ Awaiting decision/owner action

Last updated: 2026-10-10

| Phase | Status | Tests | Blocked by / waiting for |
|---|---|---|---|
| P0 Audit & planning | ✅ Approved (DL-015) | n/a | — |
| P1 Foundation | 🔄 Implementation complete; deployment-dependent acceptance items pending | 74 API + 2 web tests passing locally (embedded PostgreSQL); real-PostgreSQL CI run pending | ❓ Owner: GitHub repository URL, Railway staging setup, Backblaze B2 bucket (guide: [railway-setup-guide-ar.md](../08-operations/railway-setup-guide-ar.md)) |
| P2 Employees & documents | 🔄 Implementation complete (DL-021) | 101 API tests (26 new) + 2 web tests passing locally; live HTTP smoke test passed | ❓ Owner: Railway bucket for documents (guide 3.7); review of Phase 2 defaults (DL-022); staging walkthrough |
| P3 Workflow, notifications, schedules, in-app restore | 🔄 Implementation complete (DL-026) | 118 API tests passing locally (+2 server-only in CI, incl. full restore); 2 web tests; live HTTP smoke test passed | ❓ First CI run; restore drill on staging after Backblaze is configured; review of defaults (DL-029) |
| P4 Attendance | 🔄 Implementation complete (DL-030) | 148 API tests passing locally (+2 server-only in CI) incl. 16 golden cases and 14 attendance integration tests; local HTTP smoke test passed | ❓ Proxy spoof spike on Railway; HR sign-off of golden cases; k6 burst test; review of defaults (DL-031) |
| P5 Leave | 🔄 Implementation complete (DL-038) | 172 API tests passing locally (+2 server-only in CI) incl. 10 leave-rule golden cases and 13 leave integration tests; migration 0005 applied to an existing database | ❓ HR sign-off of golden cases; review of defaults (DL-038); grant `documents.view.medical` to HR staff who check sick notes |
| P6 Contracts | 🔄 Implementation complete (DL-040) | 184 API tests passing locally (+2 server-only in CI) incl. 14 contract tests; migration 0006 applied to an existing database | ❓ Legal review of in-app signing (DL-042); Arabic print check signed off; review of defaults (DL-043) |
| P7 Payroll | 🔄 Implementation complete (DL-044) | 203 API tests passing locally (+2 server-only in CI) incl. 9 payroll golden cases and 10 payroll integration tests; migration 0007 applied to an existing database | ❓ HR/Finance golden cases signed off; Q-24 statutory deductions (DL-045); Q-28 country; performance test on the largest company |
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

## Phase 3 acceptance criteria (roadmap.md)

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Workflow routes by relationship and role, delegates, records every decision; self-approval blocked | ✅ | `workflow.test.ts` (7 tests) |
| 2 | Notifications re-checked on open; personal only | ✅ | `notifications-restore.test.ts`; links open in-app pages that enforce access |
| 3 | Push works (Chrome/Edge/Android, installed iOS PWA) | ✅ code + fake-sender tests / ⏳ real-device check on staging |
| 4 | Schedule history "as of" a date; holidays group/company | ✅ | `calendar.test.ts` (5 tests) |
| 5 | No e-mail is sent | ✅ | DisabledMailer test |
| 6 | Restore: preview, MFA, failed checks leave production untouched, switch + undo, audit survives, only System Administrator | ✅ unit (PGlite) / ⏳ full swap test runs in CI and staging drill |

## Phase 4 acceptance criteria (roadmap.md)

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | All golden cases pass | ✅ code / ⏳ HR sign-off | `attendance-compute.test.ts` (16 cases) |
| 2 | NEG-06 (forged client IP) and NEG-14 (PIN guessing) pass | ✅ local / ⏳ Railway spike | `attendance.test.ts` (forged X-Forwarded-For, five wrong PINs) |
| 3 | Auto-closed days produce no overtime (C-02) | ✅ | `attendance-compute.test.ts` |
| 4 | Holiday work is not overtime | ✅ | `attendance-compute.test.ts` |
| 5 | Absence detection respects approved leave and holidays | ✅ (leave input ready; leave requests arrive in P5) | `attendance-compute.test.ts`, `attendance.test.ts` |
| 6 | Corrections keep the original punches | ✅ | `attendance.test.ts` (void + append-only) |
| 7 | Punch p95 < 1 s under a k6 burst test | ⏳ staging | — |

## Phase 4 deliverables

| Area | Delivered |
|---|---|
| Punching | Check in/out and breaks from computer or phone, server time, authorised networks per company/location, optional device biometrics (WebAuthn platform authenticators) or device-bound PIN, device approval, idempotent requests, audited refusals |
| Calculation | Worked time, scheduled-break deduction, extra breaks, lateness and early departure with grace, automatic overtime with threshold, early-arrival and rest-day policies, holiday work, overnight and split shifts, administrative closure, possible absence |
| Review | Hourly recompute job with employee notifications, HR review queue (confirm absence, excuse, reopen), correction requests through the workflow (manager → HR), direct HR corrections |
| Web | Attendance page (punch card, network status, history, corrections, my devices), review page, setup page (networks, devices), policy tab in Settings, attendance tab in the employee profile |

## Phase 5 acceptance criteria (roadmap.md)

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Ledger sum equals the displayed balance (property test) | ✅ | `leave-rules.test.ts` (200 random ledgers, re-run idempotent) |
| 2 | Golden cases: mid-year hire, carryover cap, cancellation | ✅ code / ⏳ HR sign-off | `leave-rules.test.ts`, `leave.test.ts` |
| 3 | Approved leave converts potential absence into leave days | ✅ | `leave.test.ts` (absent_pending → excused, removed from the review queue) |
| 4 | Managers cannot open medical attachments | ✅ | `leave.test.ts` (C-12) |

## Phase 5 deliverables

| Area | Delivered |
|---|---|
| Leave types | Group or company types with rules: entitlement, service tiers, yearly/monthly/no balance, working or calendar days, deduction on approval or submission, negative limit, yearly cap, per-request cap, notice, retroactive window, carryover cap and expiry, attachments (category), eligibility by contract type and category |
| Balances | Append-only ledger (opening, accrual, usage, refund, adjustment, carryover expiry), idempotent daily job, opening balances and audited adjustments by HR, balance history |
| Requests | Full-day leave through the locked Employee → Manager → HR chain, HR recording for employees (approved by another HR), overlap and balance checks, cancellation (employee while pending, HR after approval with refund) |
| In-day permissions | Time window on a workday within working hours, daily and monthly limits, approval route (manager → HR), approved time is not lateness or early leave |
| Attendance | Approved leave marks days as leave (excused); leave and permission flags; worked-on-leave flag |
| Web | Leave page (balances, requests, permissions), leave management (company requests, record for employee, leave types), leave tab in the profile, in-day permission settings, readable approval summaries |

## Phase 6 acceptance criteria (roadmap.md)

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | A signed version cannot be modified (API + DB tests) | ✅ | `contracts.test.ts` (NEG-08: API 409, triggers on versions and signatures) |
| 2 | Renewal creates history in the configured mode | ✅ | `contracts.test.ts` (extension version; new linked contract, old one "renewed") |
| 3 | Alerts fire with the configured timing, count and recipients | ✅ | `contracts.test.ts` (one alert per threshold, no repeats) |
| 4 | Arabic output renders correctly (visual check signed off) | ⏳ owner check | Print page (DL-041) |

## Phase 6 deliverables

| Area | Delivered |
|---|---|
| Setup | Templates per language with merge fields (employee, company, job, department, contract, salary), fields filled when preparing, reusable clauses (company clause replaces group clause), rules per contract type (renewal mode, automatic renewal, signers, durations, retention) |
| Contracts | Drafts generated from templates (manual text edit with permission), sending for signature, in-app signing with evidence or upload of a signed copy, database-locked signed versions, addenda, extensions, renewal as a new linked contract, ending, probation outcomes |
| Automation | Daily job: expiry and probation alerts (in-app/push) to HR, manager and/or employee, expiry (or hold during approved leave), automatic renewal only for allowed types |
| Web | Contracts page (awaiting my signature, my contracts, search by company/status/type/expiry/number or name), contract page with versions, signatures, evidence and print, contract setup (templates, clauses, types), contracts tab in the profile (configurable), contract settings |

## Phase 7 acceptance criteria (roadmap.md)

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Golden cases pass to the minor currency unit | ✅ code / ⏳ HR-Finance sign-off | `payroll-calc.test.ts` (9 cases), `payroll.test.ts` |
| 2 | NEG-01 (other employee's payslip) and NEG-07 (edit a locked run, API and SQL) pass | ✅ | `payroll.test.ts` |
| 3 | A locked run is reproducible from its snapshot | ✅ | Each line stores all calculation inputs (`payroll_line.inputs`) |
| 4 | Reopen keeps the previous revision and the audit reason | ✅ | `payroll.test.ts` (revision 2, superseded, reason) |
| 5 | Preparer ≠ approver | ✅ | Workflow excludes the requester (`payroll.test.ts`) |
| 6 | Performance target for the largest company | ⏳ staging | — |

## Phase 7 deliverables

| Area | Delivered |
|---|---|
| Calculation | Base and recurring items prorated by days employed, mid-month salary changes, overtime and holiday work with multipliers, lateness per minute after tolerance, absence (confirmed or also unreviewed), unpaid leave, manual bonuses and deductions, rounding to cents, explanation per item, warnings (no salary, currency change, negative net) |
| Runs | One per company and month, recalculation keeps manual items, exchange rates per run, submission and approval through the workflow, database lock after approval, reopening as an audited new revision |
| Payments and payslips | Payment history per employee (status, method, reference, date), payslips for employees (own and approved only), printable payslip, notification when ready |
| Group | Summary per company and currency with optional conversion; end-of-service calculator with configurable methods |
| Web | Payroll page (runs, group summary, end of service), run page with lines, items, manual entries, payments, rates, submit and reopen; My payslips; payroll and end-of-service settings |
