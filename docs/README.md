# HRMS Planning Package — Index

Status: **Phase 0 (Audit & Planning) — awaiting owner approval.**
Prepared: 2026-10-10. No application code has been written. Nothing has been deployed, installed, or migrated.

All diagrams are Mermaid, so they can be edited as text. GitHub, VS Code (with a Mermaid extension) and most Markdown viewers render them.

| # | Deliverable | Document |
|---|---|---|
| 1 | Repository audit report | [00-audit/repository-audit.md](00-audit/repository-audit.md) |
| 2 | Consolidated requirements specification | [01-requirements/requirements-specification.md](01-requirements/requirements-specification.md) |
| 3 | Requirements traceability matrix | [01-requirements/traceability-matrix.md](01-requirements/traceability-matrix.md) |
| 4 | Confirmed/unresolved decisions, conflicts, assumptions | [02-decisions/open-decisions.md](02-decisions/open-decisions.md) |
| 5 | Architecture & technology recommendation | [03-architecture/architecture.md](03-architecture/architecture.md) |
| 6 | Module map & dependency analysis | [03-architecture/architecture.md#5-module-map-and-dependencies](03-architecture/architecture.md#5-module-map-and-dependencies) |
| 7 | Database design & ERD | [03-architecture/database-design.md](03-architecture/database-design.md) |
| 8 | Authorization & company-isolation model | [03-architecture/authorization-model.md](03-architecture/authorization-model.md) |
| 9 | UI/UX screen specifications | [04-ux/screen-specifications.md](04-ux/screen-specifications.md) |
| 10 | API & integration proposal | [03-architecture/api-and-integrations.md](03-architecture/api-and-integrations.md) |
| 11 | File-storage comparison & recommendation | [08-operations/file-storage-comparison.md](08-operations/file-storage-comparison.md) |
| 12 | Security & privacy plan | [05-security/security-privacy-plan.md](05-security/security-privacy-plan.md) |
| 13 | Testing strategy & test-data plan | [06-quality/testing-strategy.md](06-quality/testing-strategy.md) |
| 14 | Phased implementation roadmap | [07-delivery/roadmap.md](07-delivery/roadmap.md) |
| 15 | Acceptance criteria per phase | [07-delivery/roadmap.md](07-delivery/roadmap.md) (each phase section) |
| 16 | Git & change-management approach | [07-delivery/git-and-change-management.md](07-delivery/git-and-change-management.md) |
| 17 | Railway deployment & rollback plan | [08-operations/railway-deployment.md](08-operations/railway-deployment.md) |
| 18 | Backup & recovery plan | [08-operations/backup-recovery.md](08-operations/backup-recovery.md) |
| 19 | Monitoring & maintenance plan | [08-operations/monitoring-maintenance.md](08-operations/monitoring-maintenance.md) |
| 20 | Cost analysis | [08-operations/cost-analysis.md](08-operations/cost-analysis.md) |
| 21 | Pilot/UAT plan | [06-quality/pilot-uat-plan.md](06-quality/pilot-uat-plan.md) |
| 22 | Documentation structure & diagrams | This index + [03-architecture/architecture.md](03-architecture/architecture.md) |
| 23 | Decision Log & progress tracker | [02-decisions/decision-log.md](02-decisions/decision-log.md), [07-delivery/progress-tracker.md](07-delivery/progress-tracker.md) |

## Documentation structure (proposed, to be kept in sync with code)

```
docs/
  README.md                 ← this index
  00-audit/                 ← repository audits (one per audit)
  01-requirements/          ← specification + traceability matrix
  02-decisions/             ← decision log, open questions, ADRs (adr/NNNN-title.md once approved)
  03-architecture/          ← architecture, database, authorization, API
  04-ux/                    ← screen specifications, design tokens
  05-security/              ← security & privacy plan, threat model
  06-quality/               ← testing strategy, seed data, UAT
  07-delivery/              ← roadmap, progress tracker, git/change management
  08-operations/            ← deployment, backup, monitoring, storage, cost, runbooks
```

Conventions:
- Requirement IDs (`EMP-03`) are defined in the specification and must be referenced from code-level tests and from the traceability matrix.
- Decision IDs: `D-xx` are proposals awaiting approval, `DL-xxx` are Decision Log entries, `Q-xx` are open questions, `C-xx` are conflicts and `A-xx` are assumptions.
- Facts are labelled **Verified**. Anything else is labelled **Assumption** or **Recommendation**.

## Phase 12 additions

| Document | Link |
|---|---|
| Security review (P12) | [05-security/security-review-p12.md](05-security/security-review-p12.md) |
| Operations runbooks | [08-operations/runbooks.md](08-operations/runbooks.md) |
| User guide (Arabic / English) | [09-guides/user-guide-ar.md](09-guides/user-guide-ar.md) · [09-guides/user-guide-en.md](09-guides/user-guide-en.md) |
| Administrator guide (Arabic / English) | [09-guides/admin-guide-ar.md](09-guides/admin-guide-ar.md) · [09-guides/admin-guide-en.md](09-guides/admin-guide-en.md) |
