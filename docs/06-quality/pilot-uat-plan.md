# Pilot / User Acceptance Testing Plan (draft)

Status: **Draft — needs the owner's input (Q-23) and approval before Phase 13.** Covers QA-06.

Working documents for the pilot (Arabic, for testers and HR): [step-by-step test scripts per role](pilot-test-scripts-ar.md) · [company onboarding checklist](pilot-onboarding-checklist-ar.md). Defects use the GitHub issue form *Pilot defect* (no personal data; repository must be private first).

## 1. Participants (to be confirmed)

| Proposal | Detail |
|---|---|
| Companies | 1 pilot company (preferably the one with the most typical policies), plus 1 company for read-only group checks |
| Users | 1 System Administrator, 2 HR, 1 Finance, 1 Timekeeping officer, 2 Department managers, 1 Company manager, 1 Senior management, 10–20 employees on mixed devices (Windows laptop, Android, iPhone) |
| Duration | 2 attendance weeks + 1 full payroll cycle run **in parallel** with the current process (results compared, the old process stays authoritative) |
| Environment | Production-like **pilot environment** (separate from staging) with real pilot data under approved data handling, or production with pilot companies only. **Decision needed** |

## 2. Representative scenarios

| # | Scenario | Success criteria |
|---|---|---|
| U01 | Admin configures the company, schedules, holidays, leave types and roles | Done without developer help, using the admin guide |
| U02 | HR creates employees (entered in the app; no import, DL-013), links user accounts | Numbers generated correctly. Data validated |
| U03 | Employees punch daily from office network on PC and phone. Biometric/PIN enrolment | ≥ 98% punches succeed first try. Outside-network attempts blocked |
| U04 | Late/early/overtime/absence detection vs a manual timesheet | 100% agreement or every difference explained by configuration |
| U05 | Leave request → manager → HR. In-day permission | Balances match HR's manual calculation |
| U06 | Correction request for a forgotten check-out | Audit trail shows before/after and approver |
| U07 | Contract generated from template, signed, renewal reminder | PDF correct in Arabic. Signed version locked |
| U08 | Monthly payroll run, approval, lock, payslips, payment recording | **Net pay identical to the current payroll process for 100% of pilot employees** (or each difference explained and accepted) |
| U09 | Employee views only their own payslip/salary | Confirmed by negative tests performed by the testers |
| U10 | Transfer an employee to another company. Termination and rehire | Number unchanged, history kept, access revoked on termination |
| U11 | Reports & exports (Excel/PDF), search, dashboards | Correct data within scope |
| U12 | Notifications in-app and push | Received for each configured event |

## 3. Defect handling

| Severity | Definition | Release impact |
|---|---|---|
| S1 Critical | Data loss/corruption, security or isolation breach, wrong pay | Blocks release. Fix immediately |
| S2 High | Core workflow blocked without workaround | Blocks release |
| S3 Medium | Workaround exists | Fix before release, or accepted by owner with a plan |
| S4 Low | Cosmetic/text | Scheduled |

- Recorded in **GitHub Issues** with the template: steps, expected, actual, screenshot, user/role, company, environment, severity, requirement ID.
- Priority (P1–P4) is set by the owner. Severity is set by QA.
- Fix → automated regression test added → deploy to pilot → reporter retests → closed with evidence.

## 4. Evidence and sign-off

- Test execution log per scenario (who, when, result, evidence link).
- Payroll reconciliation sheet (old vs new, per employee).
- Open defects list with severity and decision.
- Final **UAT sign-off** by the owner and HR lead, recorded in the Decision Log. **No production release without it.**
