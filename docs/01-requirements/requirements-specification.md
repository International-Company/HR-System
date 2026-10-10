# Consolidated Requirements Specification

Source: the owner's Master Instruction (2026-10-10). `§n` refers to its section numbers.
Version: 0.1 (draft for approval). The owner must approve changes through change management ([git-and-change-management.md](../07-delivery/git-and-change-management.md)).

Priority: **M** = must, initial scope. **F** = future-ready (architecture must allow it, not built initially). **X** = explicit exclusion.
Related open items are listed as Q-/C-/A- from [open-decisions.md](../02-decisions/open-decisions.md).

## 1. Organisation & multi-company (§4)

| ID | Requirement | P | Related |
|---|---|---|---|
| ORG-01 | Hierarchy: Company Group → Companies → optional Departments → Employees | M | A-01 |
| ORG-02 | Employee and operational data are separated by company | M | |
| ORG-03 | Group-wide administration | M | |
| ORG-04 | Company-scoped access and configuration | M | |
| ORG-05 | An employee can transfer between companies and keeps the employee number and all history | M | C-01 |
| ORG-06 | Group-level settings with company-level overrides where applicable | M | |
| ORG-07 | Modules are activated at group level and enabled per company | M | |
| ORG-08 | Disabled-module behaviour is configurable. Disabling never deletes data | M | C-13 |
| ORG-09 | Departments are optional. An employee may belong directly to a company | M | C-07 |
| ORG-10 | Work locations are maintained per company (used by attendance network rules and profiles) | M | |

## 2. Roles & authorization (§5)

| ID | Requirement | P | Related |
|---|---|---|---|
| RBAC-01 | Seeded role categories: System Administrator, HR Employee, Senior Management, Company Manager, Department Manager, Employee, Accountant/Finance, Attendance/Timekeeping Officer | M | |
| RBAC-02 | The System Administrator can create custom roles and assign granular permissions | M | |
| RBAC-03 | Permission actions: view, create, edit, delete, approve, reject, export, print, manage settings, view sensitive, manage accounts/permissions, access audit logs | M | |
| RBAC-04 | Permissions are scoped by group, company, department, direct reports, self and module | M | |
| RBAC-05 | Authorization is enforced server-side on every API call. Hiding UI controls is never the only control | M | |
| RBAC-06 | No access outside the authorized scope, including search, reports, exports, files and notifications | M | |
| RBAC-07 | The permission model is documented and covered by automated positive and negative tests | M | |

## 3. Employee management (§6)

| ID | Requirement | P | Related |
|---|---|---|---|
| EMP-01 | Personal information: full name, photo, national ID/passport no., date of birth, gender, nationality, marital status, phone, email | M | Q-06 |
| EMP-02 | Employment information: employee no., job title, department, direct manager, work location, hire date, actual start date, employment category, contract type, contract start/end, employment status | M | |
| EMP-03 | Financial information: base salary, currency, allowances, deductions, bank name, account no., IBAN, payment method | M | |
| EMP-04 | Educational qualifications | M | |
| EMP-05 | No unrequested fields (job grades, goals, skills, experience, training, emergency contacts, internal notes) without approval | X | |
| EMP-06 | Employee number is unique across the group, auto-generated, with a format the admin configures. It never changes on transfer | M | C-01, Q-05 |
| EMP-07 | Lifecycle: hiring, probation/confirmation, company and department transfer, job title and manager change, promotion and salary change, contract change/renewal, long leave/suspension, resignation/termination, retirement, rehire | M | |
| EMP-08 | Effective-dated history of employment, compensation and assignment changes | M | |
| EMP-09 | Salary and bank data need a "view sensitive" permission. By default HR, Senior Management and Finance have it | M | Q-21 |
| EMP-10 | Employees see their own current salary and their own payslips only | M | C-18 |
| EMP-11 | Employee documents are handled by the Document module (DOC-*) | M | |

## 4. Recruitment (§7)

| ID | Requirement | P | Related |
|---|---|---|---|
| REC-01 | Vacancies (per company) | M | |
| REC-02 | Candidate records with CVs and documents | M | |
| REC-03 | Screening, interviews, stage notes and results | M | |
| REC-04 | Configurable candidate statuses. Defaults: New, Under Review, Interview, Accepted, Rejected, Withdrawn | M | |
| REC-05 | Offer management | M | |
| REC-06 | Convert an accepted candidate into an employee record | M | |
| REC-07 | Required recruitment documents are configurable. No requirement is hardcoded | M | |
| REC-08 | Public careers page / candidate self-service portal | ? | Q-11 |

## 5. Work schedules & holidays (§8)

| ID | Requirement | P | Related |
|---|---|---|---|
| SCH-01 | Multiple schedules: working days, rest days, start/end times, scheduled breaks, grace periods | M | |
| SCH-02 | Assign schedules to employees or groups. Changes are effective-dated and kept as history | M | |
| SCH-03 | No shift-rostering system | X | |
| SCH-04 | A group-wide holiday calendar plus company-specific holidays | M | Q-07 |

## 6. Attendance (§8)

| ID | Requirement | P | Related |
|---|---|---|---|
| ATT-01 | Web/PWA punch is allowed only from authorized IP ranges (per company/location) | M | Q-09, C-14 |
| ATT-02 | Punching from a computer or phone is allowed when network and authentication conditions are met | M | |
| ATT-03 | Optional device biometrics via platform authenticators (WebAuthn: Windows Hello, Android). No raw biometric data | M | C-15 |
| ATT-04 | Optional per-employee attendance PIN | M | C-06, Q-17 |
| ATT-05 | Configurable device registration, linking and assignment policies | M | |
| ATT-06 | Each punch records timestamp, source, IP and available device identification | M | |
| ATT-07 | No GPS tracking or geofencing | X | |
| ATT-08 | Document that IP restriction does not prove physical presence | M | |
| ATT-09 | Tracks check-in/out, late arrival, early departure, scheduled and extra breaks, worked hours, overtime and absence | M | |
| ATT-10 | Configurable grace periods, correction permissions, approval workflows and policies | M | |
| ATT-11 | Optional automatic check-out at scheduled end, flagged as an administrative closure and not proof of departure | M | C-02 |
| ATT-12 | Overtime after scheduled end is recorded automatically without prior approval. Its financial treatment is configurable | M | C-02 |
| ATT-13 | Scheduled breaks are deducted automatically. Extra breaks are recorded with start/end | M | |
| ATT-14 | Potential absence is detected automatically (scheduled workday, no punch, no approved leave). HR reviews and corrects with an audit trail | M | |
| ATT-15 | Forgotten-punch handling and correction requests with approval and full audit history | M | |
| ATT-16 | Configurable policies for early check-in, early departure, unscheduled-day and rest-day work, and conflicts between attendance, schedule and leave | M | |
| ATT-17 | Work on an official holiday is classified separately and is never treated as overtime automatically | M | |

## 7. Leave & in-day permissions (§9)

| ID | Requirement | P | Related |
|---|---|---|---|
| LEV-01 | Configurable leave types: paid/unpaid, entitlement, accrual, carryover, other rules | M | |
| LEV-02 | Balance calculation by service length, contract, company policy, accrual and entitlement dates, approved/used leave, initial balance, carryover limits and expiry | M | Q-18 |
| LEV-03 | Approval chain Employee → Direct Manager → HR for all leave types | M | C-05, Q-15 |
| LEV-04 | Full-day leave. No half-day leave | M | |
| LEV-05 | In-day permissions with start/end time, integrated with attendance. Unit can be hours, minutes or both | M | |
| LEV-06 | Configurable: when the balance is deducted, initial balance, cancellation, retroactive requests, exceeding the balance, year-end/carryover, attachments | M | |
| LEV-07 | Approved leave updates balances and feeds attendance and absence calculations | M | |
| LEV-08 | Mandatory medical attachment is a per-leave-type setting (HR decides later) | M | |

## 8. Payroll (§10)

| ID | Requirement | P | Related |
|---|---|---|---|
| PAY-01 | Components: base salary, allowances, bonuses, attendance/lateness/absence deductions, unpaid-leave deductions, overtime, net salary | M | Q-24 |
| PAY-02 | Monthly payroll run per company. Authorized users see group-level summaries | M | C-04 |
| PAY-03 | Payslips. An employee can access only their own | M | |
| PAY-04 | Configurable approval workflow and levels, editing before approval, rejection handling | M | |
| PAY-05 | Approved payroll is locked. Reopening needs a special permission and is audited | M | |
| PAY-06 | Payment records: status, method, account/bank, transaction reference, date, amount, currency, notes, history | M | |
| PAY-07 | Multiple currencies. Exchange rates recorded per transaction when needed. No central FX module | M | C-04 |
| PAY-08 | Configurable: period dates, due date, automatic or manual generation, day/hour rate basis, overtime rules and multipliers, allowance and bonus rules, attendance deductions, inclusion rules, proration, mid-period salary changes, recalculation policy and audit, payslip templates, displayed currency, payment methods, payslip notification and access | M | C-08 |
| PAY-09 | Accounting integration (extension point only) | F | |
| PAY-10 | Salary advances/loans (optional module, disabled by default) | F | |
| PAY-11 | End-of-service settlement with a configurable calculation method | M | Q-01 |

## 9. Attendance commitment evaluation (§11)

| ID | Requirement | P | Related |
|---|---|---|---|
| CEV-01 | Evaluation based only on attendance, absence, lateness, early departure, worked hours and overtime | M | |
| CEV-02 | Configurable periods, weights, calculation rules, result display, reporting, recalculation, visibility and salary impact | M | |
| CEV-03 | No goals, self-assessment, performance forms or behavioural ratings | X | |

## 10. Contracts (§12)

| ID | Requirement | P | Related |
|---|---|---|---|
| CON-01 | Configurable contract types, reusable templates, clauses and required fields | M | |
| CON-02 | Employee and company data inserted automatically. Manual creation where permitted | M | |
| CON-03 | Electronic signing or upload of an externally signed copy. Configurable signers and access. Signature status, timestamps and evidence fields | M | Q-14 |
| CON-04 | Renewal either modifies the current contract or creates a new one (configurable). Automatic renewal only for authorized types under configured conditions | M | |
| CON-05 | Addenda and modifications through controlled workflows | M | |
| CON-06 | A signed contract cannot be edited. Changes go through a new contract, version or renewal that preserves history | M | |
| CON-07 | Contract statuses, retention policies and history | M | |
| CON-08 | Contract-expiry and probation alerts: timing, number of alerts, recipients and delivery method are configurable | M | |
| CON-09 | Configurable policies for contract expiry, probation outcomes and expiry during approved leave | M | |
| CON-10 | Contracts shown in the employee profile, the contracts module, or both (configurable) | M | |
| CON-11 | Advanced contract search and reporting | M | |

## 11. Document management (§13)

| ID | Requirement | P | Related |
|---|---|---|---|
| DOC-01 | A separate module, linked to employees, contracts and operations | M | |
| DOC-02 | Configurable categories/folders, metadata fields, allowed file types, size limits and permissions | M | |
| DOC-03 | Configurable deletion/recovery, replacement, retention and expiry-date fields | M | C-11 |
| DOC-04 | **No document-expiry notifications** | X | |
| DOC-05 | No multi-version DMS for every document | X | |
| DOC-06 | Metadata in PostgreSQL and file content in the approved object storage, behind a provider-agnostic interface | M | D-05 |

## 12. Termination & rehire (§14)

| ID | Requirement | P | Related |
|---|---|---|---|
| TRM-01 | Configurable workflows for resignation, termination, contract expiry, retirement and other types | M | |
| TRM-02 | Reasons, attachments, approvals, last working day, cancellation, notifications | M | |
| TRM-03 | Optional end-of-service settlement (uses PAY-11) | M | |
| TRM-04 | Configurable initiator, approver, canceller and manager for each process | M | |
| TRM-05 | Configurable access policy on exit: disable login, end sessions, revoke company/department permissions, revoke devices, stop attendance and payroll | M | C-17 |
| TRM-06 | History is preserved. No automatic deletion | M | |
| TRM-07 | Rehire keeps the same employee number and the history | M | |
| TRM-08 | No clearance/custody module | X | |

## 13. Notifications (§15)

| ID | Requirement | P | Related |
|---|---|---|---|
| NOT-01 | In-app notification centre: read/unread, filtering, open the linked item, mark one or all as read | M | |
| NOT-02 | Configurable notification visibility and recipients | M | |
| NOT-03 | PWA/Web Push where the platform supports it | M | |
| NOT-04 | Events: leave, attendance exceptions, absence, lateness, early departure, overtime, contract expiry, probation, payroll, termination, system | M | |
| NOT-05 | No active email sending. A documented SMTP adapter, disabled, ready to activate later | M/F | |
| NOT-06 | No SMS/WhatsApp. No document-expiry notifications | X | |

## 14. Reports, search, dashboards (§16)

| ID | Requirement | P | Related |
|---|---|---|---|
| RPT-01 | Report builder: report type, field selection, filters, save and reuse | M | C-10 |
| RPT-02 | Excel and PDF export, print | M | |
| RPT-03 | Scheduled reports with recipients (in-app delivery until email is enabled) | M | C-03 |
| RPT-04 | Report catalogue: employees, attendance, leave balances, payroll, lateness, absence, overtime, contract expiry, recruitment, turnover, commitment evaluation, employee costs, termination | M | |
| RPT-05 | Every report and export respects authorization and company scope | M | |
| SRCH-01 | Global search and in-page search with advanced filters | M | |
| SRCH-02 | Search results respect permissions and company boundaries | M | |
| DASH-01 | Simple dashboards configurable by role and company | M | C-09 |
| DASH-02 | The admin configures dashboard content and layout within the supported design | M | |

## 15. Settings & localisation (§17)

| ID | Requirement | P | Related |
|---|---|---|---|
| SET-01 | The System Administrator controls which settings exist and who may manage them | M | |
| SET-02 | Settings: group/company info and logos, default currency, language, date/time formats and timezone, attendance, leave, payroll, contracts, evaluation, documents, notifications, security policies, employee-number format, work locations, holiday calendars | M | |
| I18N-01 | Exactly two UI languages: Arabic (RTL) and English (LTR) | M | Q-06 |
| I18N-02 | The admin selects one global system language. No per-user language switching is assumed | M | Q-22 |
| I18N-03 | One timezone and one set of date/time formats for all companies, set by the admin | M | A-02 |

## 16. Authentication & security (§18)

| ID | Requirement | P | Related |
|---|---|---|---|
| AUTH-01 | Username and password is the primary authentication method | M | |
| AUTH-02 | Optional 4-digit PIN for quick access | M | C-06 |
| AUTH-03 | Optional device biometrics (WebAuthn platform authenticators) | M | Q-04 |
| AUTH-04 | Optional MFA | M | D-09 |
| AUTH-05 | Allowed authentication methods configurable by role or user | M | |
| AUTH-06 | Policies: password strength and length, failed-login limit and lockout, MFA requirement, idle timeout, maximum session length | M | |
| AUTH-07 | Active session and device management. Remote session termination | M | |
| AUTH-08 | Account creation, modification and deactivation. User-to-employee linking rules | M | |
| AUTH-09 | Encryption, HTTPS, secret management, input validation, authorization checks, secure file upload | M | |
| AUTH-10 | Security plan approved before implementation | M | |
| AUTH-11 | Privacy, retention and access review. Legal questions flagged for specialist verification | M | Q-01 |

## 17. Audit (§19)

| ID | Requirement | P | Related |
|---|---|---|---|
| AUD-01 | Audit trail with configurable detail: actor, timestamp, record/employee, company, old/new values, IP, device, operation, outcome | M | |
| AUD-02 | The admin configures who can access audit logs | M | |
| AUD-03 | Actions on the audit system itself are audited | M | |
| AUD-04 | Ordinary users cannot alter or erase audit history (append-only, tamper-evident) | M | Q-20 |

## 18. Backup & recovery (§20)

| ID | Requirement | P | Related |
|---|---|---|---|
| BKP-01 | Configurable backup schedules and retention | M | |
| BKP-02 | Backup access and restore permissions | M | Q-12 |
| BKP-03 | Backup and restore operations are logged | M | |
| BKP-04 | Secure backup storage, separated from the operational database | M | |
| BKP-05 | Documented recovery procedures and periodic restore tests | M | |
| BKP-06 | **In-app restore button** for the System Administrator on their dashboard, with impact preview, step-up MFA, optional second approver, automatic pre-restore backup (undo) and audit carry-forward (owner decision 2026-10-10, DL-010) | M | Q-12 |

### Proposed privacy requirements (GDPR, Q-01 = EU) — **not in scope until approved via change request**

| ID | Requirement | P |
|---|---|---|
| PRIV-01 | HR can export all personal data held about an employee (data-subject access request) | Proposed |
| PRIV-02 | Retention policies per data class (anonymise/delete after a configured period, legal-hold override). Periods must be set before go-live | Proposed |
| PRIV-03 | Data-category inventory to support the owner's records of processing | Proposed |

## 19. Architecture, deployment, governance, quality, UX (§21–27)

| ID | Requirement | P |
|---|---|---|
| ARC-01 | Deploy on Railway with Railway-hosted PostgreSQL | M |
| ARC-02 | The owner links GitHub to Railway. We prepare the repository and documentation only | M |
| ARC-03 | API-first design ready for future integrations and a native mobile app (not built now) | F |
| ARC-04 | Railway deployment documentation: environment, migrations, health checks, logs, backup, rollback, verification | M |
| ARC-05 | Editable diagrams (Mermaid): architecture, module dependencies, ERD, data flow, API, deployment, auth flows | M |
| ARC-06 | Documentation covering requirements, ADRs, database, permissions, testing, security, deployment, maintenance, limitations | M |
| GOV-01 | Phased delivery with acceptance criteria and approval gates | M |
| GOV-02 | Progress tracker kept separate from the HR application | M |
| GOV-03 | Decision Log | M |
| GOV-04 | Formal change management | M |
| GOV-05 | Preserve Git work, use branches and recovery points | M |
| QA-01 | Functional, integration, authorization/company-isolation and data-integrity tests are mandatory. Security and performance tests as needed | M |
| QA-02 | Negative authorization tests (for example, another employee's payslip, another company's records) | M |
| QA-03 | Open critical/high security findings block phase acceptance | M |
| QA-04 | Reproducible, isolated seed data. No real employee data without approval | M |
| QA-05 | Test credentials cannot work in production | M |
| QA-06 | Pilot/UAT plan approved before release | M |
| OPS-01 | Release and maintenance plan (versioning, migrations, backups, rollback, verification, monitoring, security updates) | M |
| OPS-02 | Cost analysis with sources, assumptions and scenarios | M |
| OPS-03 | No paid service is activated without approval | M |
| UX-01 | Calm corporate white/blue design, simple icons | M |
| UX-02 | Collapsible sidebar, responsive desktop and mobile | M |
| UX-03 | Clear forms, tables, filters and workflow statuses. Role-appropriate dashboards | M |
| UX-04 | Accessibility and readability come before decoration (target WCAG 2.2 AA) | M |

## 20. Explicit exclusions (§28)

EXC-01 traditional performance appraisal · EXC-02 goals/self-assessment · EXC-03 document-expiry notifications · EXC-04 clearance/custody module · EXC-05 mandatory loans/advances · EXC-06 native mobile app · EXC-07 active email sending · EXC-08 SMS/WhatsApp · EXC-09 GPS attendance · EXC-10 raw fingerprint storage · EXC-11 unapproved paid services · EXC-12 unapproved destructive/production operations.

Every exclusion gets an "absence" check in review: code review and the test suite confirm that no such feature or endpoint exists.

## 21. Non-functional requirements (proposed — **Recommendation**, needs approval)

| ID | Requirement |
|---|---|
| NFR-01 | Availability target 99.5% monthly during business hours (Railway single region) |
| NFR-02 | p95 API latency < 500 ms for interactive screens at the expected scale (Q-02). Attendance punch < 1 s end-to-end |
| NFR-03 | RPO ≤ 24 h (≤ 1 h optional with more frequent dumps). RTO ≤ 4 h |
| NFR-04 | All monetary values use exact decimal arithmetic (PostgreSQL `numeric`). No floating point |
| NFR-05 | All timestamps stored in UTC (`timestamptz`). Work dates are calculated in the configured group timezone |
| NFR-06 | Supported browsers: latest 2 versions of Chrome, Edge, Safari (iOS ≥ 16.4 for push) and Firefox |
| NFR-07 | Mobile-responsive down to 360 px width |
