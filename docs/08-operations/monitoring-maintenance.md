# Monitoring & Maintenance Plan

Status: **Proposed.**

## 1. Monitoring

| Signal | Source | Alert (who) |
|---|---|---|
| Availability | Railway health checks; optional external uptime check on `/health/ready` (free tier, to be chosen and approved) | Owner/tech admin |
| Error rate, latency | Structured logs (request latency, status); Railway metrics (CPU/RAM/network) | Tech admin |
| Background jobs | `job_run` table: absence detection, accruals, alerts, backups, off-site sync | In-app notification to System Administrators on failure |
| Backups | `backup_run` records + monthly restore test | System Administrators |
| Security | Failed-login spikes, lockouts, permission changes, sensitive exports, audit hash-chain verification (daily) | Security dashboard for admins + notification |
| Cost | Railway usage alerts/limits (set by owner) | Owner |
| Capacity | DB size, bucket size, slow queries (`pg_stat_statements`) | Monthly review |

## 2. Maintenance routine

| Frequency | Task |
|---|---|
| Daily (automated) | Backups, off-site sync, audit hash-chain check, job health |
| Weekly | Dependency update PRs (Renovate/Dependabot) reviewed; review failed jobs/alerts |
| Monthly | Automated restore test; cost and capacity review; review of sensitive-permission holders; PostgreSQL minor updates as Railway offers them |
| Quarterly | Manual restore drill; access review signed by the owner; secret-rotation check; review of retention policies |
| Yearly | Holiday calendars for the new year; leave year-end/carryover run verification; security review (ASVS checklist) |
| On demand | Security patches: critical ≤ 7 days, high ≤ 30 days |

## 3. Troubleshooting & documentation

Runbooks in [runbooks.md](runbooks.md): deploy failed, migration failed, DB full, bucket unreachable, punch failures (IP/proxy), push not delivered, job stuck, restore. Each covers symptoms, checks, fixes and escalation. Incidents are documented in `docs/08-operations/incidents/`.
