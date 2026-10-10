# Testing Strategy & Test-Data Plan

Status: **Proposed**. Covers QA-01 to QA-05.

## 1. Test pyramid and categories

| Level | Tool | Scope | Runs |
|---|---|---|---|
| Unit | Vitest | Calculation methods (lateness, overtime, breaks, leave accrual/proration, payroll lines, evaluation scores), validators, policy resolution | Every commit |
| Integration (API + DB) | Vitest + Supertest. **Locally: PGlite** (PostgreSQL compiled to WebAssembly, an npm package in the project folder. No Docker or system install, per Q-25/D-19). **Authoritative: real PostgreSQL 17 service container in GitHub Actions** | Endpoints, transactions, triggers, RLS, workflows, events | Locally on demand. CI on every PR |
| Authorization matrix | Generated from `authz-matrix.yaml` | Every endpoint × persona × target, positive **and negative** | Every PR (**mandatory gate**) |
| Company isolation (DB) | SQL tests as the app role | RLS on every company-scoped table. CI check "table without policy" | Every PR (**gate**) |
| Data integrity | Integration + property-based (fast-check) | No overlapping history, ledger sum = balance, locked payroll immutable, audit append-only, idempotent punches | Every PR (**gate**) |
| E2E | Playwright (Chromium + WebKit, AR and EN) | Critical journeys per phase, RTL layout snapshots | Nightly + before phase acceptance |
| Accessibility | axe-core in Playwright | Key screens, WCAG 2.2 AA rules | Phase acceptance |
| Security | gitleaks, OSV/npm audit, Semgrep, ZAP baseline, manual authz review | — | CI + before pilot |
| Performance | k6 against staging | Punch burst (e.g. 80% of employees within 15 min), payroll calculation for the largest company, report export | Phases 4, 7, 11, 12 |
| Restore | Operator drill (P1). Automated in-app **dry-run restore** (monthly, from P3). Real switch + undo on staging (quarterly) | Backup really restores, row counts, checksums, audit carried forward | Phase 1, then monthly/quarterly |

**Local vs CI database (D-19):** PGlite gives fast feedback without installing anything. Small behaviour differences from server PostgreSQL are possible (roles, connection-level settings, `pg_dump`/`pg_restore`, concurrency). So restore, RLS-role and concurrency tests are tagged `@server-only` and run in CI only. **Only the CI result counts at the phase gate.** Phase 1 includes a spike to confirm that RLS, `SET ROLE` and `btree_gist` exclusion constraints behave the same in PGlite as in PostgreSQL 17.

## 2. Mandatory negative test examples (QA-02)

| ID | Case | Expected |
|---|---|---|
| NEG-01 | Employee requests another employee's payslip by ID | 404 |
| NEG-02 | Company A manager lists or opens company B employees | Empty list / 404 |
| NEG-03 | Department manager reads a salary field | Field absent |
| NEG-04 | HR(A) exports report with filter company=B | 403 |
| NEG-05 | Terminated user with an old cookie calls any API | 401 |
| NEG-06 | Punch from IP outside the allow-list (including a forged `X-Forwarded-For` header) | 403, audited |
| NEG-07 | Edit item of a locked payroll run (API and raw SQL as the app role) | 409 / DB error |
| NEG-08 | Edit a signed contract version | 409 |
| NEG-09 | UPDATE/DELETE on audit_event as the app role | DB error |
| NEG-10 | User approves their own leave | 403 |
| NEG-11 | Global search for a company B employee's name by a company A user | No result |
| NEG-12 | Reuse an expired presigned download URL | Provider 403 |
| NEG-13 | Call an endpoint of a disabled module | 403 (or read-only per policy) |
| NEG-14 | 6th wrong PIN on a device | PIN disabled, password required |
| NEG-15 | Upload an `.exe` renamed as `.pdf` | Rejected |

## 3. Domain test scenarios (calculation correctness)

A **golden-case table** per calculation, written with HR before implementation of that phase. Each row: inputs → expected outputs, signed off by HR. Examples:
- Late arrival inside/outside grace. Early departure. Punch across midnight. Rest-day work. Holiday work classified separately (not overtime). Administrative auto-closure produces no overtime (C-02).
- Leave spanning a holiday and rest days. Accrual for a mid-year hire. Carryover cap and expiry. Cancellation after partial use.
- Payroll: mid-month hire/termination proration, mid-period salary change, unpaid leave, multi-currency run, reopen → new revision.

## 4. Test data & seed plan (QA-04, QA-05)

| Topic | Rule |
|---|---|
| Generator | `npm run seed -- --profile=<dev|test|demo> --seed=<n>`. Deterministic: the same seed gives the same data |
| Content | Fictitious group "Demo Holding" with 3 companies (different currencies, one without departments), ~60 employees with AR/EN names, every role persona, schedules (incl. split-break), holidays, 3 months of punches with exceptions, leave in all states, contracts (probation, expiring, signed, renewed), 2 payroll months (one locked), a transferred employee, a terminated and a rehired employee, candidates in each status |
| Credentials | Personas share a dev-only password printed by the seed command. **Never committed in plain text.** |
| Production guard | The seed refuses to run when `APP_ENV=production`. On startup, production **refuses to boot** if any `is_seed=true` user exists. A CI test checks both |
| Reset | `npm run db:reset` (local/test only: drop → migrate → seed). Staging reset needs a manual approval step |
| Removal | Demo data in staging is removed by `npm run seed:purge`. Production never receives seed data |
| Real data | Never copied to non-production without written approval and masking (names, IDs, bank, salary perturbation) |

## 5. Phase acceptance gate (applies to every phase)

1. All mandatory categories green in CI (unit, integration, authz matrix, isolation, integrity).
2. Phase E2E journeys pass in AR and EN.
3. No open critical/high security findings.
4. Traceability matrix updated: every phase requirement has at least one passing test.
5. Docs updated (architecture, DB, permissions, decision log, progress tracker).
6. Demo on staging. Owner approval recorded in the Decision Log.

## 6. Coverage targets (guidance, not a substitute for the matrices)

Domain calculation modules ≥ 90% branch coverage. Overall ≥ 75%. The authorization matrix covers 100% of endpoints (enforced by a check that every route appears in the matrix).
