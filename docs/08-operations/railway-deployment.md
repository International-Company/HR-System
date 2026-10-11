# Railway Deployment, Release & Rollback Plan

Status: **Implemented for Phase 1** (`Dockerfile`, `railway/web.json`, `railway/worker.json`). Owner's step-by-step guide: [railway-setup-guide-ar.md](railway-setup-guide-ar.md). Covers ARC-01, ARC-02, ARC-04 and OPS-01. **No deployment happens without the owner's approval. The owner performs the GitHub ↔ Railway linking.**

## 1. Railway project layout

| Environment | Services | Source branch |
|---|---|---|
| staging | `web`, `worker`, `postgres` (Railway PostgreSQL template), bucket `files` | `main` |
| production | `web`, `worker`, `postgres`, bucket `files` | `production` |

- Region: **EU West (Amsterdam)** for every service and bucket (DL-008). **The bucket region cannot be changed after creation.**
- PostgreSQL volume sized at **≥ 2.5× the database size** for the restore slots (D-16b). A volume-usage alert is at 70%.
- Databases on the server (from Phase 3, DL-019): `hrms_control`, `hrms_blue`, `hrms_green`; Phase 1 uses Railway's default database. Roles: `hrms_migrator` (owner), `hrms_app` (no BYPASSRLS), `hrms_ops` (worker only: restore slots). To verify in a Phase 1 spike: the Railway PostgreSQL template allows creating extra databases and roles.
- Build: the repository `Dockerfile` (multi-stage, Node 24, PostgreSQL 18 client tools for backups). Each service points to its config file: `railway/web.json` (pre-deploy migration + health check) and `railway/worker.json`. Chromium for PDFs is added when PDF generation arrives (Phase 6/7). This keeps builds reproducible instead of relying on auto-detection.
- `web` start: `node apps/api/dist/main.js`. `worker` start: same image with `WORKER=1`.
- **Pre-deploy command** (web only): `node apps/api/dist/migrate.js`. It runs migrations before traffic switches. If it fails, the deploy is aborted and the old version keeps running.
- **Health check path:** `/health/ready` (DB reachable, migrations at the expected version, storage reachable). `/health/live` for liveness.
- "Wait for CI" enabled, so Railway deploys only after GitHub Actions passes (to verify in Phase 1).

## 2. Environment variables

Names only (see security plan §8). Values are set by the owner or me in Railway variables, **never committed**. `.env.example` documents each variable with a description and no real value. Railway reference variables connect the services, for example `DATABASE_URL=${{postgres.DATABASE_URL}}`.
Additional: `APP_ENV` (`staging|production`), `PUBLIC_URL`, `TRUST_PROXY=2` (Railway internal proxy + edge, DL-035), `LOG_LEVEL`, `MAIL_ENABLED=false`.

## 3. Owner's one-time steps (documented checklist)

1. Create the Railway workspace and project on the chosen plan (Q-10).
2. Link the GitHub repository and set branches per environment.
3. Add the PostgreSQL service and bucket in each environment. Enable volume backups (daily + weekly + monthly).
4. Set the secrets (I provide a generation script that prints commands locally, never values to logs).
5. Add the custom domain (Q-04) and DNS records.

## 4. Release procedure (production)

1. A release PR from `main` to `production` lists changes, migrations (destructive? → needs separate approval) and the rollback plan.
2. Staging verification: automated E2E smoke + manual checklist signed.
3. **Backup before risky operations:** a manual volume backup plus a logical dump to off-site storage, verified to exist.
4. Owner approves → merge (fast-forward) → Railway builds, runs pre-deploy migration and health checks, then switches traffic.
5. **Post-deployment verification (≤ 15 min):** `/health/ready` green; login; one punch on a test-safe production account (`smoke` account restricted to a hidden "smoke" company, no seed data); open a payslip list; error rate and logs normal; version endpoint shows the new tag.
6. Tag `vX.Y.Z` and update CHANGELOG and the progress tracker.

## 5. Rollback

| Situation | Action |
|---|---|
| New version unhealthy, no schema change | Railway "Redeploy" / rollback to the previous deployment (one click), or revert the merge on `production` |
| Schema changed in an **expand-only** migration (the default rule) | Same as above: the old code is compatible with the expanded schema |
| Data-destructive migration has gone wrong (only with prior approval) | Stop writes (maintenance mode flag) → restore from the pre-release backup per backup-recovery.md → redeploy the previous version. Data entered since the backup must be reconciled manually, which is why destructive migrations need approval |

## 6. Logs & observability

Railway captures stdout/stderr. The app writes structured JSON logs (request ID, user ID, company ID, route, latency, outcome — no sensitive values). Retention follows the plan (7 days Hobby, 30 days Pro). Security-relevant events live in the audit table, not only in logs.
