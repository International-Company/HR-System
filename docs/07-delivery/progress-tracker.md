# Development Progress Tracker

This tracker is for the development team. It is kept separate from the HR application (GOV-02). Updated at every status change.
Legend: ✅ Completed · 🔄 In progress · ⏳ Remaining · ⛔ Blocked · ❓ Awaiting decision/owner action

Last updated: 2026-10-10

| Phase | Status | Tests | Blocked by / waiting for |
|---|---|---|---|
| P0 Audit & planning | ✅ Approved (DL-015) | n/a | — |
| P1 Foundation | 🔄 Implementation complete; deployment-dependent acceptance items pending | 74 API + 2 web tests passing locally (embedded PostgreSQL); real-PostgreSQL CI run pending | ❓ Owner: GitHub repository URL, Railway staging setup, Backblaze B2 bucket (guide: [railway-setup-guide-ar.md](../08-operations/railway-setup-guide-ar.md)) |
| P2 Employees & documents | ⏳ | — | P1 acceptance; Q-05, Q-06, Q-16, Q-26 |
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
