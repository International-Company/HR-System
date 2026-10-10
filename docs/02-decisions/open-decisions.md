# Decisions, Open Questions, Conflicts & Assumptions

Status as of 2026-10-10. The owner decides every **Q** and approves every **D**. Answers are recorded in the [Decision Log](decision-log.md).

## 0. Owner answers received — 2026-10-10

| Q | Owner's answer | Consequence |
|---|---|---|
| Q-01 | **EU** | Host in Railway **EU West (Amsterdam)**. Bucket and off-site backups in EU regions. **GDPR applies** (see security plan §9). The exact member state(s) are still needed for labour-law defaults and timezone → **Q-28** |
| Q-02 | New system, new companies, new employees. No figures yet | Plan for cost scenario S and scale on demand. **Q-18 closed: no data migration** (employees entered in the app) |
| Q-03 | The owner maintains it and delegated the stack choice ("do the best") | **D-01 approved as delegated** (TypeScript stack). Extra emphasis on documentation, runbooks and managed services that one person can operate |
| Q-10 | The owner owns the Railway workspace and billing | Plan proposal: Hobby while building, **Pro before production** (confirmed at the P14 gate) |
| Q-12 | **Wants an in-app restore button for the System Administrator** | **D-16 superseded by D-16b** (safe in-app restore, see backup-recovery.md §3). Risks accepted by the owner, mitigations designed |
| Q-20 | Unknown for now | Audit kept indefinitely **until defined**. **Must be defined before go-live** because of GDPR storage limitation (C-20) |
| Q-21 | Yes | Senior Management: group-wide scope, read + approvals |
| Q-25 | **No local installations** | No Docker, no local PostgreSQL, no global tools. Proposal **D-19**: only npm packages inside the project folder (PGlite for fast local DB tests); real PostgreSQL 17 tests run in GitHub Actions; staging on Railway. **Confirmation needed → Q-29** |

## 1. Confirmed decisions (stated in the Master Instruction)

These need no further approval. Changing them requires a formal change request.

| # | Confirmed decision |
|---|---|
| CF-01 | Hosting on Railway with Railway PostgreSQL. The owner links GitHub ↔ Railway |
| CF-02 | Multi-company group: Group → Companies → optional Departments → Employees |
| CF-03 | The employee number does not change on company transfer |
| CF-04 | Two UI languages (Arabic RTL, English LTR). One global language chosen by the admin |
| CF-05 | One timezone and date format for all companies |
| CF-06 | Leave approval: Employee → Direct Manager → HR, for all leave types |
| CF-07 | No half-day leave. In-day permissions use start/end times |
| CF-08 | Overtime is recorded automatically after scheduled end, without prior approval |
| CF-09 | Holiday work is classified separately and is not automatic overtime |
| CF-10 | Attendance uses IP restriction plus optional device biometrics/PIN. No GPS, no raw fingerprints |
| CF-11 | Payroll runs monthly per company, is locked on approval, and needs a special permission to reopen |
| CF-12 | Commitment evaluation is attendance-only. No performance appraisal |
| CF-13 | Signed contracts are immutable. Changes go through version/renewal/new contract |
| CF-14 | No document-expiry notifications. No clearance module. No email sending, SMS or WhatsApp initially |
| CF-15 | No paid services, deployments or destructive operations without explicit approval |

## 2. Proposed decisions requiring approval (D-xx)

Each decision is explained in the linked document. **Recommendation** in every case.

| ID | Decision | Recommendation | Main alternative | Where |
|---|---|---|---|---|
| D-01 ✅ approved (delegated by owner, Q-03) | Technology stack | TypeScript end to end: **NestJS** API, **React + Vite** PWA, **Mantine** UI (native RTL), **Drizzle ORM** + SQL migrations, **PostgreSQL 17**, **pg-boss** background jobs (no Redis) | Django + DRF + React (choose if maintainers are Python developers) | [architecture.md §3](../03-architecture/architecture.md#3-technology-recommendation) |
| D-02 | Architecture style | **Modular monolith** in one monorepo with 2 processes (web/API, worker). No microservices | Separate frontend service | architecture.md §4 |
| D-03 | Company isolation | Single database and schema. `company_id` on company-scoped rows. Central policy service **plus PostgreSQL Row-Level Security** as a second layer | Schema per company (rejected: transfers, group reports and migrations get much harder) | [authorization-model.md](../03-architecture/authorization-model.md) |
| D-04 | History model | Effective-dated rows (`valid_from`/`valid_to`, no overlaps, enforced by DB exclusion constraints) for assignment, compensation and schedule assignment | Event sourcing (rejected: complexity) | database-design.md |
| D-05 | File storage | **Railway Storage Buckets** primary, plus a nightly encrypted copy to a **second provider** (Backblaze B2 or Cloudflare R2). Access only through an S3 abstraction | Cloudflare R2 as primary | [file-storage-comparison.md](../08-operations/file-storage-comparison.md) |
| D-06 | Field and file encryption | Application-level envelope encryption (AES-256-GCM) for national ID/passport, bank account, IBAN and **all document contents**. Master key in a Railway secret. **The owner keeps an offline escrow copy** | Rely only on provider encryption at rest | security-privacy-plan.md |
| D-07 | Sessions | Server-side sessions (opaque HttpOnly cookie) stored in PostgreSQL. This enables idle timeout, maximum length and remote termination | Stateless JWT (rejected: hard to revoke) | security-privacy-plan.md |
| D-08 | PDF rendering | Headless Chromium (Playwright) in the worker. Arabic shaping and bidi render correctly | pdfmake/PDFKit (weak Arabic shaping) | architecture.md |
| D-09 | MFA methods | TOTP authenticator app and WebAuthn passkeys. No SMS/email OTP (no channels exist initially) | — | security-privacy-plan.md |
| D-10 | Configurability approach | **Typed policy settings** plus a fixed library of **predefined calculation methods with parameters** (for example "overtime = hourly rate × multiplier"). **No user-authored formulas or scripts** | A formula/expression engine (higher risk, much more testing). Could be added later through change control | C-08 |
| D-11 | Leave balances | Append-only **leave ledger** (accruals, usage, adjustments, carryover, expiry). The balance is derived from it | Mutable balance column (rejected: not auditable) | database-design.md |
| D-12 (revised for Q-25) | Repository layout | **npm workspaces** monorepo (npm is already installed, so no global pnpm install): `apps/api`, `apps/web`, `packages/shared`, `docs/`. Keep the current Arabic folder name, but clone to an ASCII path if tooling fails | Separate repositories | git-and-change-management.md |
| D-13 | Environments | Local → Railway **staging** (synthetic seed data only) → Railway **production** | Production only (rejected) | railway-deployment.md |
| D-14 | Railway plan | **Pro** for production (30-day logs, unlimited bucket capacity, more replicas, workspace features). Hobby is acceptable for staging/early development | Hobby for everything (1 TB bucket cap, 7-day logs) | cost-analysis.md |
| D-15 | Audit storage | Append-only `audit_event` table. A database trigger blocks UPDATE/DELETE. A per-row hash chain makes tampering detectable. Only a separate migration role can purge, under a retention policy | External log service (paid) | security-privacy-plan.md |
| ~~D-16~~ | ~~Backup restore as operator procedure only~~ | **Superseded by D-16b (owner decision Q-12)** | | |
| D-16b | In-app restore | System Administrator restore button on the dashboard: restore into an inactive database slot → checks → impact preview → step-up MFA (optional second approver) → automatic pre-restore backup → switch. Audit history carried forward. Railway volume backups remain the fallback when the app is down | — | [backup-recovery.md §3](../08-operations/backup-recovery.md#3-in-app-restore--design) |
| D-19 | Development without local installs (Q-25) | Only npm packages inside the project folder (deletable, nothing system-wide). **PGlite** (PostgreSQL in WebAssembly, an npm package) for fast local tests. Authoritative integration tests on **real PostgreSQL 17 in GitHub Actions**. Manual testing on Railway staging | (a) CI/staging only: every test run needs a push (slow, and the owner must push). (b) GitHub Codespaces cloud dev environment (free quota, then paid) | testing-strategy.md |
| D-17 | Workflow engine | One generic approval engine (definitions → steps → instances → tasks) shared by leave, corrections, payroll, contracts, termination and recruitment offers. Approvers are resolved by relationship ("direct manager", "HR of employee's company") or by role/scope | Hardcoded workflows per module | architecture.md |
| D-18 | API style | REST + JSON, versioned `/api/v1`, generated OpenAPI 3.1 contract | GraphQL (harder to authorize per field) | api-and-integrations.md |

## 3. Open questions (Q-xx)

**Blocking** = must be answered before the phase named.

| ID | Question | Why it matters | Blocks | Proposed default if unanswered |
|---|---|---|---|---|
| **Q-01** | In which country or countries do the companies operate? | Labour law (leave entitlements, end-of-service, overtime minimums), data-protection law (consent, data residency, cross-border transfer), e-signature validity, statutory payroll deductions. **Railway regions are US, EU (Amsterdam) and Singapore only**, and some laws restrict hosting HR data abroad | Phase 1 (region selection) | None. Legal input required |
| **Q-02** | Approximate scale: companies, employees now and in 3 years, concurrent users, document volume | Sizing, cost, performance targets | Phase 1 | 3–5 companies, ≤ 500 employees |
| **Q-03** | Who will maintain the system long-term, and which languages do they know? | Decides D-01 (TypeScript vs Python vs .NET) | Phase 1 | TypeScript |
| **Q-04** | Will production use a custom domain (for example `hr.example.com`)? | WebAuthn credentials are bound to the domain. Moving from `*.up.railway.app` to a custom domain later invalidates every registered passkey/biometric | Phase 4 (attendance biometrics) | Custom domain before any biometric enrolment |
| **Q-05** | Employee-number format: may it contain a company code? | It conflicts with "number never changes on transfer" (C-01) | Phase 2 | Group-wide prefix + sequence, for example `EMP-000123`, with no company code |
| **Q-06** | Are names, job titles and other free text entered in **both** Arabic and English, or only one? | Schema (bilingual columns), forms, reports, contract templates | Phase 2 | Name stored in Arabic and English. Other free text single-language |
| **Q-07** | Is Hijri date display or Hijri-based holiday handling needed? | Calendar components, holiday entry | Phase 3 | Gregorian only. Holidays entered as Gregorian dates each year |
| **Q-08** | Default weekly rest days and work week (for example Fri/Sat or Sat/Sun)? | Seed defaults only (always configurable) | Phase 3 | Configurable, no default assumed |
| **Q-09** | Do all company sites have a **static public IP** (IPv4 and/or IPv6)? Are there remote or field employees who must punch from outside the office? | IP restriction only works with stable egress IPs. Remote staff need an exception policy | Phase 4 | Per-location CIDR allow-list. Exceptions only through correction requests |
| **Q-10** | Railway plan: Hobby or Pro (see D-14)? Who owns the Railway workspace and billing? | Cost, logs, capacity | Phase 1 deploy | Pro for production |
| **Q-11** | Recruitment: internal only, or a public careers page where candidates apply? | A public page adds an internet-facing attack surface, spam control and consent text | Phase 9 | Internal only |
| **Q-12** | Who may trigger restores, and do you accept D-16 (no in-app restore)? | Safety of production data | Phase 1 | D-16 |
| **Q-13** | Group-level payroll summaries across currencies: per-currency totals only, or converted using rates recorded on the run? | No central FX module (C-04) | Phase 7 | Per-currency totals, plus optional conversion using rates entered on the run |
| **Q-14** | Electronic signature: is in-app signing with evidence (authenticated user, timestamp, IP, device, document hash, typed name/drawn signature) acceptable, or do you need a qualified/third-party e-signature provider? | Legal validity depends on jurisdiction (Q-01) | Phase 6 | In-app simple e-signature plus upload of wet-signed copies. Legal review before relying on it |
| **Q-15** | Leave-workflow edge cases: (a) the employee has no direct manager, (b) the direct manager is on leave, (c) the requester is the HR person, (d) the manager is in another company. Is delegation needed? | Routing rules of the fixed chain | Phase 5 | (a) skip to HR, (b) delegate assigned by the manager or skip to HR after N days, (c) another HR user, (d) allowed |
| **Q-16** | Are "direct manager" and "department manager" always the same person? Can the direct manager work in another group company? | Scope model for managers | Phase 2 | Different concepts. Cross-company managers allowed |
| **Q-17** | Shared punch devices (kiosk with PIN) or personal devices only? | A PIN on a shared device allows buddy-punching | Phase 4 | Personal devices. Kiosk mode optional and disabled |
| **Q-18** | Is there existing HR data to migrate (Excel, another system), including opening leave balances and contract history? | Import tooling and its phase | Phase 2 | CSV/Excel import for employees and opening balances |
| **Q-19** | Approve the storage provider (D-05) and the secondary backup provider? | Paid service | Phase 2 | — |
| **Q-20** | Audit-log retention period (for example 7 years)? | Storage, legal | Phase 1 | Keep indefinitely until decided |
| **Q-21** | Senior Management default scope: whole group, or selected companies? | Default role scopes | Phase 1 | Whole group, read-only plus approvals |
| **Q-22** | Should printed outputs (payslips, contracts) be producible in the language *other* than the global UI language (for example English payslip while the UI is Arabic)? | Templates, i18n of documents | Phase 6/7 | Templates per language. The template is chosen at generation |
| **Q-23** | Which companies and users will take part in the pilot? | UAT plan | Phase 13 | — |
| **Q-24** | Must payroll calculate **statutory deductions** (income tax, social insurance, pension) or only configured deductions? | Not mentioned in the specification. Usually country-specific (Q-01) | Phase 7 | Configured fixed/percentage deductions only. No statutory engine |
| **Q-25** | May I install development tools when Phase 1 starts (pnpm, Docker Desktop or a local PostgreSQL 17)? | Local integration tests need a real PostgreSQL | Phase 1 | ✅ Answered: no local installs (→ D-19, Q-29) |
| **Q-26** | Can an employee hold positions in two companies **at the same time**? | Data model (A-09) | Phase 2 | No. One active company assignment at a time |
| **Q-27** | Should employees keep read-only access to their own payslips after termination? | TRM-05 vs EMP-10 (C-17) | Phase 8 | Configurable, default off |
| **Q-28** | Which EU member state(s) will the companies be in? | Labour-law defaults (leave minimums, overtime, working-time records), national GDPR rules, works-council consultation on attendance monitoring, contract written-form rules, **timezone (C-19)**, default currency | Phase 3 (timezone/holidays), Phase 5, 6, 7 | — |
| **Q-29** | Is D-19 acceptable: npm packages inside the project folder only (removable by deleting `node_modules`), nothing installed on the system? | Without it I cannot run any tests locally | **Phase 1** | — |

Status of earlier questions: Q-01 partly answered (EU → Q-28), Q-02 answered (unknown, start small), Q-03 ✅, Q-10 ✅ (plan at P14), Q-12 ✅, Q-18 ✅ (no migration), Q-20 deferred (C-20), Q-21 ✅, Q-25 ✅ (→ Q-29).

## 4. Conflicts and tensions in the specification (C-xx)

| ID | Conflict | Proposed resolution |
|---|---|---|
| C-01 | "Employee-number format configurable" vs "number never changes on transfer". A format containing a company code becomes wrong after a transfer. Changing the format later could imply renumbering | Numbers are group-wide and never contain mutable attributes. A format change applies **only to newly created numbers**. Existing numbers are never rewritten (Q-05) |
| C-02 | Automatic check-out at scheduled end vs automatic overtime after scheduled end. An auto-closed day can never show overtime, and it hides forgotten check-outs | Auto-closure sets `closure_type = administrative`. That day **produces no overtime** and is flagged "check-out not recorded" for correction. Overtime comes only from a real check-out |
| C-03 | Scheduled reports with recipients vs no email in the initial phase | Scheduled reports are delivered to the in-app notification centre (with a download link). Email delivery becomes available when SMTP is activated |
| C-04 | Group payroll summaries across currencies vs no FX module | Totals per currency, plus optional conversion with rates entered and stored on the run (Q-13) |
| C-05 | The leave chain is fixed (Employee → Manager → HR) while the specification asks for configurable workflows elsewhere | The engine is generic (D-17). The leave definition is seeded with this chain and **locked**: only edge-case routing (Q-15) is configurable unless a change request is approved |
| C-06 | A 4-digit PIN (10,000 combinations) as an authentication factor vs the security policy | The PIN is accepted **only as a quick-unlock on a registered device** that already holds a valid long-lived device credential. It is never a standalone remote login. Strict attempt limits (for example 5 failures → device unlock disabled, password required). The attendance PIN follows the same device-bound rule |
| C-07 | "Department" in the employee profile vs departments being optional | `department_id` is nullable. Department-scoped roles simply do not apply to employees without a department |
| C-08 | "Everything configurable" vs reliability and testability | D-10: typed settings plus predefined calculation methods with parameters. Each method has unit tests. New methods come through change requests |
| C-09 | "Admin configures dashboard layout" vs "keep dashboards simple" | A catalogue of approved widgets. The admin picks widgets and their order per role/company on a fixed responsive grid. No free-form layout builder |
| C-10 | A free field-selection report builder vs field-level sensitivity | Reports are built on **curated datasets**. Each field carries a sensitivity class. Fields the user may not see are not offered and are stripped on the server |
| C-11 | "No multi-version DMS" vs replacement policies, contract immutability and audit | Replacing a document keeps the old file as `superseded` (retrievable by authorized users) when the category's policy says so. This is not a general versioning system |
| C-12 | Medical attachments are special-category data | They go in a restricted document category ("medical"), visible only to HR with a separate permission. Managers see the leave decision, not the attachment |
| C-13 | Disabling a module keeps data, but open workflows (pending leave, unpaid payroll) are left in limbo | Disable policy per module: `read-only` (default: data visible, no new transactions, open items can still complete) or `hidden` (data hidden but kept). Disabling with open items requires confirmation listing them |
| C-14 | IP restriction behind Railway's proxy. The client IP comes from `X-Forwarded-For` | Take the address Railway's edge supplies (first XFF entry per Railway guidance) and **verify in a Phase 4 spike that clients cannot spoof it**. Document that this is network control, not proof of presence (ATT-08) |
| C-15 | "Biometric attendance" via WebAuthn proves *someone unlocked a registered device*, not whose finger it was. Windows Hello/Android may fall back to the device PIN | Require `userVerification=required`. Document the limitation. Bind credentials to the user. Optionally allow only devices registered and approved by HR |
| C-16 | "Admin can configure anything" vs integrity of locked records (approved payroll, signed contracts, audit) | Integrity rules are invariants the database enforces (triggers/constraints), not settings. Only the designated reopen workflows can change these records |
| C-17 | On termination "disable login" vs EMP-10 (employee sees own payslips) | Configurable exit policy (Q-27). Default: disable login |
| C-18 | "Employees see their current salary" — is salary *history* visible? | Default: current salary plus own payslips. History is HR/Finance only. Configurable |
| C-19 | One timezone for all companies (CF-05) vs EU companies possibly spanning several timezones (for example Portugal UTC+0, Germany UTC+1, Greece UTC+2) | If all companies are in one timezone, there is no issue. Otherwise lateness would be wrong by whole hours. Resolution then: a timezone per company or work location (a change request against CF-05). Depends on Q-28 |
| C-20 | Audit/HR data kept indefinitely (Q-20 unknown) vs GDPR storage limitation (Art. 5(1)(e)) | Allowed as a temporary default during build. **Retention periods per data class must be approved before go-live** (P13 gate item) |
| C-21 | In-app restore (Q-12) vs "audit history can never be erased" (AUD-04) | Audit events after the backup point are carried into the restored database, and the restore is recorded permanently in the control database |
| C-22 | UI only Arabic/English vs EU contracts and payslips that may legally need the local language | UI stays AR/EN. Contract and payslip **templates** are free text, so they can be written in any language. Only the UI is limited. Legal check per Q-28 |

## 5. Assumptions (A-xx) — to be confirmed

| ID | Assumption |
|---|---|
| A-01 | One deployment serves **one** company group. It is not a SaaS for several unrelated groups |
| A-02 | All companies share one timezone (CF-05) |
| A-03 | All users are internal (employees, HR, managers). Candidates do not log in (Q-11) |
| A-04 | Gregorian calendar (Q-07) |
| A-05 | Starts small (new companies, new employees; Q-02). Designed to grow to ~2,000 employees without redesign |
| A-06 | Browser-based PWA only. A native app is a future phase |
| A-07 | Separate Railway staging and production environments |
| A-08 | Payroll does not calculate statutory tax or social insurance (Q-24) |
| A-09 | An employee has one active company assignment at a time (Q-26) |
| A-10 | Payroll and salary amounts use the employee's contract currency. A payroll run can contain several currencies |
| A-11 | Notifications are in-app and Web Push only. SMTP is prepared but disabled |
