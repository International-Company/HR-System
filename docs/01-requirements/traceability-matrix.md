# Requirements Traceability Matrix

Links each requirement → module → phase → verification. Test IDs are planned suite names, created in the phase that implements the requirement. Status columns are filled in during implementation. ✅ P1 = implemented and covered by passing tests in Phase 1 (apps/api/test).
Test codes: **U** unit · **I** integration · **A** authorization matrix · **R** RLS/isolation · **D** data integrity · **E** E2E · **S** security · **P** performance · **X** exclusion check (feature must not exist) · **Doc** documentation review · **UAT** pilot scenario.

| Req | Module | Phase | Verification | Planned tests | Status |
|---|---|---|---|---|---|
| ORG-01 | org | P1 | I, E | `org.hierarchy.*` | ✅ P1 |
| ORG-02 | org, all | P1+ | R, A | `rls.*`, NEG-02 | ✅ P1 |
| ORG-03 | org, access | P1 | A, E | `authz.group-admin.*` | ✅ P1 |
| ORG-04 | access, settings | P1 | A, I | `authz.company-scope.*` | ✅ P1 |
| ORG-05 | employees | P2 | I, D, A | `employee.transfer.*` | ✅ P2 |
| ORG-06 | settings | P1 | U, I | `settings.override.*` | ✅ P1 |
| ORG-07 | settings | P1 | I, A | `modules.enablement.*` | ✅ P1 |
| ORG-08 | settings | P1 | I, D | `modules.disable-keeps-data`, NEG-13 | ✅ P1 |
| ORG-09 | org, employees | P2 | I | `employee.no-department` | ✅ P2 |
| ORG-10 | org | P1 | I | `org.locations.*` | ✅ P1 |
| RBAC-01 | access | P1 | I | `roles.seeded` | ✅ P1 |
| RBAC-02 | access | P1 | I, E | `roles.custom.*` | ✅ P1 |
| RBAC-03 | access | P1 | A | authz matrix | ✅ P1 |
| RBAC-04 | access | P1 | A, R | `scope.*` | ✅ P1 |
| RBAC-05 | access | P1 | A (every route in matrix) | `authz.route-coverage` | ✅ P1 |
| RBAC-06 | access, search, reporting, files, notify | P1–P11 | A, R | NEG-01…NEG-13 | ⏳ |
| RBAC-07 | access | P1 | Doc, A | authorization-model.md, generated catalogue | ✅ P1 |
| EMP-01…EMP-04 | employees | P2 | I, E | `employee.profile.*` | ✅ P2 |
| EMP-05 | employees | P2 | X | `exclusion.employee-fields` | ✅ P2 |
| EMP-06 | employees | P2 | D, I | `employee-number.*` (unique, immutable, format change new-only) | ✅ P2 |
| EMP-07 | employees | P2 (+P8) | I, E | `lifecycle.*` | ✅ P2 + P8 (separation, rehire) |
| EMP-08 | employees | P2 | D | `history.no-overlap`, `as-of.*` | ✅ P2 |
| EMP-09 | employees | P2 | A | NEG-03, `financial-fields.*` | ✅ P2 |
| EMP-10 | employees, payroll | P2/P7 | A | NEG-01, `self.salary` | ✅ P2 |
| EMP-11 | employees, documents | P2 | I | `employee.documents` | ✅ P2 |
| REC-01…REC-05 | recruitment | P9 | I, E | `recruitment.*` | ⏳ |
| REC-06 | recruitment, employees | P9 | I, D | `recruitment.convert` | ⏳ |
| REC-07 | recruitment, documents | P9 | I, X | `recruitment.no-hardcoded-docs` | ⏳ |
| REC-08 | recruitment | P9 | — | Pending Q-11 | ❓ |
| SCH-01, SCH-02 | calendar | P3 | U, I, D | `schedule.*`, `schedule.as-of` | ✅ P3 |
| SCH-03 | calendar | P3 | X | `exclusion.shift-roster` | ✅ P3 |
| SCH-04 | calendar | P3 | I | `holidays.group-company` | ✅ P3 |
| ATT-01, ATT-02 | attendance | P4 | I, S | `punch.ip-allowlist`, NEG-06, proxy spoof spike | ✅ `attendance.test.ts`; ⏳ Railway spoof spike |
| ATT-03 | identity, attendance | P4 | I, E | `webauthn.*` | ✅ `attendance.test.ts` (options); ⏳ real device |
| ATT-04 | identity, attendance | P4 | I, S | `pin.*`, NEG-14 | ✅ |
| ATT-05 | attendance | P4 | I, A | `devices.*` | ✅ |
| ATT-06 | attendance | P4 | I | `punch.metadata` | ✅ |
| ATT-07 | attendance | P4 | X | `exclusion.gps` (no geolocation API, Permissions-Policy) | ✅ Permissions-Policy `geolocation=()` |
| ATT-08 | docs | P4 | Doc | architecture.md §9 + user guide | ✅ UI notice + DL-031 |
| ATT-09 | attendance | P4 | U (golden cases), E | `attendance-day.calc.*` | ✅ |
| ATT-10 | attendance, settings | P4 | U, I | `attendance.policy.*` | ✅ |
| ATT-11 | attendance | P4 | U | `auto-closure.no-overtime` (C-02) | ✅ |
| ATT-12 | attendance | P4 | U | `overtime.auto` | ✅ |
| ATT-13 | attendance | P4 | U | `breaks.*` | ✅ |
| ATT-14 | attendance | P4/P5 | I, D | `absence.detection.*` | ✅ |
| ATT-15 | attendance, workflow | P4 | I, D | `corrections.*`, `punch.append-only` | ✅ |
| ATT-16 | attendance | P4/P5 | U | `conflict-policies.*` | ✅ |
| ATT-17 | attendance | P4 | U | `holiday-work.not-overtime` | ✅ |
| LEV-01, LEV-02 | leave | P5 | U (golden cases), D | `leave.accrual.*`, `ledger.sum` | ✅ `leave-rules.test.ts`, `leave.test.ts` |
| LEV-03 | leave, workflow | P5 | I, A | `leave.chain`, NEG-10 | ✅ `leave.test.ts` (chain, on behalf, self-approval excluded) |
| LEV-04 | leave | P5 | X | `exclusion.half-day` | ✅ full days only (no half-day input) |
| LEV-05 | leave, attendance | P5 | U, I | `inday-permission.*` | ✅ `leave.test.ts` (permission removes lateness, limits) |
| LEV-06 | leave | P5 | U, I | `leave.policies.*` | ✅ `leave.test.ts` (deduction timing, cancellation, retroactive) |
| LEV-07 | leave, attendance | P5 | I | `leave.attendance-integration` | ✅ `leave.test.ts` (absence → leave) |
| LEV-08 | leave, documents | P5 | I, A | `leave.attachment-required`, `medical.restricted` | ✅ `leave.test.ts` (C-12) |
| PAY-01 | payroll | P7 | U (golden cases) | `payroll.calc.*` | ✅ `payroll-calc.test.ts`, `payroll.test.ts` |
| PAY-02 | payroll | P7 | I, A | `payroll.company-run`, `group-summary` | ✅ `payroll-calc.test.ts`, `payroll.test.ts` |
| PAY-03 | payroll | P7 | A, E | NEG-01, `payslip.pdf` | ✅ `payroll-calc.test.ts`, `payroll.test.ts` |
| PAY-04 | payroll, workflow | P7 | I | `payroll.approval.*` | ✅ `payroll-calc.test.ts`, `payroll.test.ts` |
| PAY-05 | payroll | P7 | D, A | NEG-07, `payroll.reopen` | ✅ `payroll-calc.test.ts`, `payroll.test.ts` |
| PAY-06 | payroll | P7 | I | `payments.*` | ✅ `payroll-calc.test.ts`, `payroll.test.ts` |
| PAY-07 | payroll | P7 | U, I | `multicurrency.*` | ✅ `payroll-calc.test.ts`, `payroll.test.ts` |
| PAY-08 | payroll, settings | P7 | U, I | `payroll.config.*`, `proration.*` | ✅ `payroll-calc.test.ts`, `payroll.test.ts` |
| PAY-09 | payroll | Future | Doc | port documented | ➖ future (extension point / optional module) |
| PAY-10 | payroll | Future | X | module disabled by default | ➖ future (extension point / optional module) |
| PAY-11 | payroll, separation | P7/P8 | U | `settlement.*` | ✅ `payroll-calc.test.ts`, `payroll.test.ts` |
| CEV-01, CEV-02 | evaluation | P10 | U, I | `evaluation.*` | ⏳ |
| CEV-03 | evaluation | P10 | X | `exclusion.performance-appraisal` | ⏳ |
| CON-01, CON-02 | contracts | P6 | I, E | `contract.template.*` | ✅ `contracts.test.ts` (templates, clauses, merge fields) |
| CON-03 | contracts | P6 | I, S | `signature.evidence` | ✅ `contracts.test.ts` (in-app evidence, upload) |
| CON-04, CON-05 | contracts | P6 | I, D | `contract.renewal.*`, `addendum.*` | ✅ `contracts.test.ts` (extension, new contract, automatic, addendum) |
| CON-06 | contracts | P6 | D | NEG-08 | ✅ `contracts.test.ts` (NEG-08) |
| CON-07 | contracts | P6 | I | `contract.status-retention` | ✅ statuses + type retention; nothing deleted |
| CON-08, CON-09 | contracts, notify | P6 | I | `contract.alerts.*` | ✅ `contracts.test.ts` (alerts, expiry, probation) |
| CON-10, CON-11 | contracts | P6/P11 | E, A | `contract.display`, `contract.search` | ✅ profile tab setting, search |
| DOC-01…DOC-03 | documents | P2 | I, S | `documents.*`, NEG-15 | ✅ P2 |
| DOC-04 | documents, notify | P2 | X | `exclusion.doc-expiry-alerts` | ✅ P2 |
| DOC-05 | documents | P2 | X | review | ✅ P2 |
| DOC-06 | files | P2 | I | `storage-port.*` (adapter contract tests) | ✅ P2 |
| TRM-01…TRM-04 | separation | P8 | I, A | `separation.*` | ✅ `separation.test.ts` |
| TRM-05 | separation, identity | P8 | I, A | NEG-05, `exit-policy.*` | ✅ `separation.test.ts` (NEG-05) |
| TRM-06 | separation | P8 | D | `separation.history-kept` | ✅ nothing deleted; former employees visible (DL-050) |
| TRM-07 | separation, employees | P8 | I, D | `rehire.same-number` | ✅ `separation.test.ts` |
| TRM-08 | — | P8 | X | `exclusion.clearance` | ✅ excluded (no clearance module) |
| NOT-01, NOT-02 | notify | P3 | I, A, E | `notifications.*` | ✅ P3 |
| NOT-03 | notify | P3 | E (manual on devices) | `push.*` | ✅ P3 |
| NOT-04 | notify + modules | P3–P8 | I | `events.<module>` | ⏳ |
| NOT-05 | notify | P3 | I | `mail.disabled-no-send` | ✅ P3 |
| NOT-06 | notify | P3 | X | `exclusion.sms-whatsapp` | ✅ P3 |
| RPT-01…RPT-04 | reporting | P11 | I, E | `reports.*` | ⏳ |
| RPT-05 | reporting | P11 | A | NEG-04 | ⏳ |
| SRCH-01, SRCH-02 | search | P11 | I, A | NEG-11 | ⏳ |
| DASH-01, DASH-02 | dashboards | P11 | I, E | `dashboards.*` | ⏳ |
| SET-01, SET-02 | settings | P1+ | I, A | `settings.*` | ✅ P1 |
| I18N-01, I18N-02 | web | P1 | E (AR+EN snapshots) | `i18n.*` | ✅ P1 |
| I18N-03 | settings | P1 | U | `time.zone-format` | ✅ P1 |
| AUTH-01, AUTH-06 | identity | P1 | I, S | `login.*`, `lockout.*` | ✅ P1 |
| AUTH-02 | identity | P4 | I, S | NEG-14 | ⏳ |
| AUTH-03 | identity | P4 | I, E | `webauthn.*` | ⏳ |
| AUTH-04, AUTH-05 | identity | P1 | I | `mfa.*`, `auth-methods.policy` | ✅ P1 |
| AUTH-07 | identity | P1 | I, A | `sessions.revoke` | ✅ P1 |
| AUTH-08 | identity, employees | P1/P2 | I | `accounts.*` | ⏳ |
| AUTH-09 | all | P1+ | S | CI security gates, ZAP | ⏳ |
| AUTH-10, AUTH-11 | docs | P0 | Doc | security-privacy-plan.md | ✅ drafted |
| AUD-01…AUD-03 | audit | P1 | I | `audit.*` | ✅ P1 |
| AUD-04 | audit | P1 | D, S | NEG-09, `audit.hash-chain` | ✅ P1 |
| BKP-01…BKP-05 | ops | P1/P12 | Restore drill | restore-log entries | ⏳ |
| BKP-06 | ops, access, audit | P3 | I, A, D, E (staging switch + undo) | `restore.preview`, `restore.step-up-mfa`, `restore.audit-carry-forward`, `restore.undo`, `restore.permission-not-in-custom-roles` | ✅ P3 |
| PRIV-01…PRIV-03 | employees, settings | TBD | — | Pending change-request approval | ❓ |
| ARC-01…ARC-06 | ops/docs | P0–P1 | Doc, deploy | this package; staging deploy | 🔄 |
| GOV-01…GOV-05 | delivery | P0+ | Doc | roadmap, tracker, decision log | ✅ drafted |
| QA-01…QA-05 | quality | P1+ | CI gates | testing-strategy.md | ⏳ |
| QA-06 | quality | P13 | UAT | pilot-uat-plan.md | ⏳ |
| OPS-01…OPS-03 | ops | P0/P14 | Doc | deployment + cost docs | ✅ drafted |
| UX-01…UX-04 | web | P1+ | E, axe, owner review | `a11y.*` | ⏳ |
| EXC-01…EXC-12 | all | every phase | X | exclusion checklist at each gate | ⏳ |
| NFR-01…NFR-07 | ops/all | P12 | P, E | k6, browser matrix | ⏳ (pending approval of NFRs) |
