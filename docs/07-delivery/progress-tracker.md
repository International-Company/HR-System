# Development Progress Tracker

This tracker is for the development team. It is kept separate from the HR application (GOV-02). Updated at every status change.
Legend: ✅ Completed · 🔄 In progress · ⏳ Remaining · ⛔ Blocked · ❓ Awaiting decision

Last updated: 2026-10-10 (owner answers to Q-01, 02, 03, 10, 12, 20, 21, 25 recorded)

| Phase | Status | Tests | Blocked by / waiting for |
|---|---|---|---|
| P0 Audit & planning | 🔄 Revised after owner answers, ❓ awaiting final approval | n/a | Q-29; approval of the remaining proposed decisions (D-02…D-15, D-17, D-18, D-19); approval to `git init` |
| P1 Foundation | ❓ | — | P0 approval; Q-19 (off-site backup provider) before the backup work in P1 |
| P2 Employees & documents | ⏳ | — | Q-05, Q-06, Q-16, Q-19, Q-26 |
| P3 Workflow, notifications, schedules, in-app restore | ⏳ | — | Q-07, Q-08, Q-15, Q-28 |
| P4 Attendance | ⏳ | — | Q-04, Q-09, Q-17 |
| P5 Leave | ⏳ | — | Q-28 (labour-law defaults) |
| P6 Contracts | ⏳ | — | Q-14, Q-22, Q-28 |
| P7 Payroll | ⏳ | — | Q-13, Q-24, Q-28 |
| P8 Separation & rehire | ⏳ | — | Q-27 |
| P9 Recruitment | ⏳ | — | Q-11 |
| P10 Commitment evaluation | ⏳ | — | — |
| P11 Reports, search, dashboards | ⏳ | — | — |
| P12 Hardening | ⏳ | — | — |
| P13 Pilot / UAT | ⏳ | — | Q-23; retention periods (C-20); GDPR owner items |
| P14 Release | ⏳ | — | Owner approval; Railway Pro plan confirmation |

## P0 deliverables checklist

| # | Deliverable | Status |
|---|---|---|
| 1 | Repository audit | ✅ |
| 2 | Requirements specification | ✅ v0.2 (BKP-06 added; PRIV-01…03 proposed) |
| 3 | Traceability matrix | ✅ |
| 4 | Decisions / questions / conflicts / assumptions | ✅ (owner answers recorded; Q-28, Q-29 added; C-19…C-22 added) |
| 5–10 | Architecture, modules, DB/ERD, authorization, UX specs, API | ✅ proposed (updated for EU region, restore slots, npm) |
| 11 | Storage comparison | ✅ EU regions; ❓ approval Q-19 |
| 12 | Security & privacy plan | ✅ GDPR section added; legal items need a specialist (§10) |
| 13 | Testing strategy & seed plan | ✅ PGlite locally + CI (D-19, ❓ Q-29) |
| 14–15 | Roadmap & acceptance criteria | ✅ |
| 16 | Git & change management | ✅ |
| 17–19 | Deployment, backup (in-app restore), monitoring | ✅ |
| 20 | Cost analysis | ✅ scenario S as the starting point |
| 21 | Pilot/UAT plan | ✅ draft; ❓ Q-23 |
| 22 | Documentation structure & diagrams | ✅ |
| 23 | Decision log & this tracker | ✅ DL-008…DL-014 |
