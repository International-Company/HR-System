# Backup & Recovery Plan

Status: **Proposed, revised 2026-10-10** after the owner's decision on Q-12. System Administrators get an **in-app restore button** on their dashboard. This supersedes D-16; see DL-010.
Covers BKP-01 to BKP-06. Principle: **a backup counts only once it has been successfully restored.**

## 1. Targets (proposed — NFR-03)

RPO ≤ 24 h by default. The admin can enable more frequent backups (for example every 4 h). RTO ≤ 1 h for an in-app restore and ≤ 4 h for a disaster restore.

## 2. Backup layers

| Layer | What | Schedule & retention (configurable defaults) | Location | Restorable from the app? |
|---|---|---|---|---|
| L1 Railway volume backups | Snapshots of the whole PostgreSQL volume | Daily (6 days), weekly (27 days), monthly (89 days) — Railway's fixed schedules | Railway, same project | **No.** Railway dashboard only (fallback when the app itself is down) |
| L2 Application backups | `pg_dump` of the active HR database, encrypted, plus a manifest (time, app/schema version, row counts, checksums) | Daily at 02:00 (group timezone). Keep 14 daily, 8 weekly, 12 monthly. "Back up now" on demand | **Off-site provider, EU region** (Backblaze B2 EU Central or Cloudflare R2 EU jurisdiction). No-delete credentials + object lock | **Yes — the restore button uses these** |
| L3 Document files | Objects are never overwritten (immutable keys), so they are copied incrementally | Nightly | Off-site provider | Used automatically to recover missing objects |
| L4 Pre-restore / pre-release snapshot | An L2 backup taken automatically before every restore and every production migration | Kept 90 days | Off-site | Yes ("State before restore at …") |

## 3. In-app restore — design

### 3.1 How it can work safely

The application cannot overwrite the database it is running on. So the PostgreSQL server hosts:

| Database | Purpose |
|---|---|
| `hrms_control` | Small database: which data database is active, backup catalogue, restore jobs, maintenance flag, permanent copy of restore events |
| `hrms_blue` / `hrms_green` | Two data slots. One is **active**, the other receives restores |

A restore is loaded into the **inactive** slot, checked, and only then made active. If anything fails before the switch, production is untouched.

### 3.2 Flow

```mermaid
sequenceDiagram
  actor A as System Administrator
  participant UI as Admin dashboard › Backups
  participant W as Worker
  participant OFF as Off-site backups
  participant DB as PostgreSQL (control + blue/green)
  A->>UI: Choose restore point
  UI->>A: Impact preview: backup time, version, changes that will be LOST (counts per module from audit), special warnings (payroll approved/paid, contracts signed since then)
  A->>UI: Re-enter password + MFA code + type confirmation phrase
  opt second-approver setting ON
    UI-->>A: waits for a second System Administrator to approve
  end
  UI->>W: start restore job
  W->>OFF: download + decrypt + verify checksum
  W->>DB: pg_restore into INACTIVE slot → run forward migrations
  W->>DB: checks: schema version, row counts vs manifest, audit hash chain, RLS policies present
  W-->>UI: "Ready to switch" (or failed → nothing changed)
  A->>UI: Confirm switch
  W->>DB: maintenance ON (users see a maintenance page)
  W->>OFF: automatic pre-restore backup of current data (L4)
  W->>DB: copy audit events newer than the backup into the restored DB + "restore boundary" event
  W->>DB: switch active pointer → all sessions invalidated
  W->>DB: health checks → maintenance OFF
  W-->>A: Done. All admins notified. Restore recorded in control DB + audit
```

### 3.3 Safeguards

| Safeguard | Detail |
|---|---|
| Who | Permission `system.backup.restore`. Only the System Administrator role can hold it, and it cannot be added to custom roles |
| Step-up authentication | Password + **MFA is mandatory** for anyone holding this permission, even if MFA is otherwise optional |
| Explicit consequences | The preview lists exactly what will be lost. Approved/paid payroll, signed contracts and terminations since the backup get highlighted warnings |
| Second approver | Setting `backup.restore.requireSecondApprover`. Default **on** when the group has ≥ 2 System Administrators |
| Undo | Every restore first takes a pre-restore backup, which appears as a restore point. Undo = restore that point |
| Audit is never lost | Audit events created after the backup are carried into the restored database (AUD-04). The restore itself is recorded in both the audit log and `hrms_control` |
| Files | Object keys are never reused, so restored records still find their files. Missing objects are fetched from L3. Files uploaded after the backup are listed as orphans and **kept** (not auto-deleted) |
| Version safety | Older backups are migrated forward before the switch. A backup made by a *newer* app version than the running one is refused |
| Concurrency | One restore at a time. Backups pause during a restore |
| Only scope: the whole group | A restore replaces all companies' data. Per-company or single-record restore is **not offered**, because restoring one company would break cross-company links (transfers, group payroll summaries) |

### 3.4 Limits the admin must understand (shown in the UI and the admin guide)

1. Everything entered after the backup is lost, except audit history. Users must re-enter it.
2. Things that happened outside the system cannot be undone: notifications already received, payslips already downloaded, bank payments already made.
3. **If the app or the database server is down, the button is unavailable.** The disaster runbook (§5) and Railway L1 backups cover that case.
4. The volume must hold about 2.5× the database size (two slots plus working space). This is monitored.

## 4. Permissions & logging (BKP-02, BKP-03)

- Backup **settings** (schedule, retention, second approver): `settings.manage.backup` (System Administrator).
- Viewing backup status: `system.backup.view`. Taking a manual backup: `system.backup.create`.
- Every backup and restore job writes a record (start, end, size, checksum, destination, outcome) and an audit event. Failures notify System Administrators in-app.

## 5. Disaster runbook (when the in-app button cannot help)

| Scenario | Procedure |
|---|---|
| App healthy, wrong data entered | Use the in-app restore (or correct the records manually if only a few are affected — usually better than losing everyone's later work) |
| Database server corrupted / app cannot start | Railway dashboard → PostgreSQL volume → restore an L1 backup (creates a new volume staged for review) → deploy → verify |
| Railway project/account/region lost | New Railway project (EU West) → deploy from GitHub → new PostgreSQL → maintenance CLI command `restore-from-offsite` with the latest L2 → files synced back from L3 → DNS → verify |
| Key compromise | Rotate keys (data master key re-wrap, backup key, off-site credentials) and take a fresh backup |

## 6. Keys

To make the button work without manual steps, the **backup decryption key is a Railway secret available to the worker** (change from the earlier plan). Mitigations:
- The off-site credentials used by the app **cannot delete** backups (no `deleteFiles` capability), and the bucket uses **object lock** retention. A compromised app therefore cannot destroy the backup history.
- The owner keeps an **offline escrow copy** of the data master key and the backup key (two copies, separate places). Without them, encrypted backups cannot be restored after a total account loss.

## 7. Restore testing

- **Phase 1:** the first operator restore drill (L1 and L2) before the gate.
- **After the in-app restore ships:** an automated **monthly "dry-run restore"**. It restores the latest backup into the inactive slot and runs all checks, **without switching**. The result appears on the admin dashboard ("Last verified restore: 3 Oct — OK").
- **Quarterly:** a timed end-to-end drill on staging, including a real switch and undo, recorded in `docs/08-operations/restore-log.md`.
