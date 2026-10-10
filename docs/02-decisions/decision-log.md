# Decision Log

Every significant decision gets an entry. Entries are never deleted: a changed decision gets a new entry that **supersedes** the old one.
Statuses: `Proposed` · `Approved` · `Rejected` · `Superseded`.
Once a decision is approved, architecture-level decisions also get an ADR file in `docs/02-decisions/adr/NNNN-title.md`.

| ID | Date | Decision | Status | Rationale | Impact | Supersedes / changed by |
|---|---|---|---|---|---|---|
| DL-001 | 2026-10-10 | The project is greenfield. There is no existing code to preserve | Verified fact | Read-only audit: empty folder, not a Git repository | No stack constraints from existing code | — |
| DL-002 | 2026-10-10 | Planning documentation lives in `docs/` as Markdown + Mermaid | Proposed | Versioned with the code, diff-able, editable diagrams | Documentation structure | — |
| DL-003 | 2026-10-10 | D-01 TypeScript stack (NestJS, React/Vite, Mantine, Drizzle, PostgreSQL 17, pg-boss) | Proposed | One language across front and back end. Strong typing for complex rules. Mantine has first-class RTL. pg-boss avoids a paid Redis service | Every implementation phase | Depends on Q-03 |
| DL-004 | 2026-10-10 | D-02 Modular monolith | Proposed | Small team, transactional consistency across HR modules, lowest Railway cost | Deployment topology | — |
| DL-005 | 2026-10-10 | D-03 Shared schema + `company_id` + RLS defence-in-depth | Proposed | Transfers and group reporting need one database. RLS guards against missed filters | Every data access | — |
| DL-006 | 2026-10-10 | D-05 Railway Buckets + secondary-provider backup copy | Proposed | Same platform, $0.015/GB-month, free egress. A second provider is needed because Railway Buckets currently have no versioning or backups | Paid service. **Requires approval (Q-19)** | — |
| DL-007 | 2026-10-10 | D-06 to D-18 (see open-decisions.md) | Proposed | See open-decisions.md §2 | Various | — |
| DL-008 | 2026-10-10 | Companies operate in the EU. Host in Railway EU West (Amsterdam). Storage and backups in EU regions. GDPR applies | Approved (owner, Q-01) | Data residency and GDPR | Region choice is permanent for buckets. Adds GDPR items (security plan §9) | Member state(s) pending Q-28 |
| DL-009 | 2026-10-10 | D-01 TypeScript stack approved. The owner maintains the system | Approved (delegated, Q-03) | Owner asked for the best option | Confirms DL-003 | Supersedes DL-003 status |
| DL-010 | 2026-10-10 | In-app restore button for System Administrators (D-16b) | Approved (owner, Q-12) | The owner wants self-service recovery | Blue/green database slots, control DB, step-up MFA, pre-restore backup, audit carry-forward. Backup key held online by the worker (mitigated by no-delete credentials + object lock) | **Supersedes D-16** |
| DL-011 | 2026-10-10 | No local installations. npm workspaces instead of pnpm (D-12 revised). D-19 proposed for testing | Approved (no installs), D-19 Proposed (Q-29) | Owner preference | Local DB tests via PGlite; authoritative tests in CI | Revises DL-003 tooling |
| DL-012 | 2026-10-10 | Senior Management default scope = whole group | Approved (owner, Q-21) | — | Seeded role defaults | — |
| DL-013 | 2026-10-10 | No data migration. The system starts empty with new companies and employees | Approved (owner, Q-02) | — | Import tooling removed from P2 scope | Closes Q-18 |
| DL-014 | 2026-10-10 | Railway workspace and billing owned by the owner. Hobby while building, Pro before production | Approved (owner) / plan Proposed | — | Cost | Plan confirmed at P14 |

| DL-015 | 2026-10-10 | Owner: "everything is fine" — all remaining proposed decisions (D-02…D-15, D-17…D-19) approved, Q-29 accepted (project-local npm packages), off-site backups on Backblaze B2 EU (Q-19), start Phase 1. The owner has a Railway subscription | Approved (owner) | Planning package accepted | Phase 1 started. Q-28 (member state) still open, not needed for P1 | Supersedes "Proposed" status of DL-002…DL-007 |

## How to add an entry

1. Next sequential ID. 2. ISO date. 3. One-sentence decision. 4. Status. 5. Why (with alternatives considered). 6. What changes (modules, cost, data, tests). 7. Links to the entries it supersedes or that supersede it.
