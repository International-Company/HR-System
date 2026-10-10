# Operating Cost Analysis

Status: **Estimate for planning. No service has been subscribed or activated (OPS-03).**
Unit prices were checked on 2026-10-10 from public pages (see Sources). Railway bills **actual** resource usage, so real costs are known only after measuring staging and pilot usage. These scenarios will be re-calibrated then.

## 1. Unit prices used

| Item | Price |
|---|---|
| Railway Hobby | $5/month, includes $5 usage |
| Railway Pro | $20/month per workspace, includes $20 usage |
| Railway RAM | $10 per GB-month |
| Railway vCPU | $20 per vCPU-month |
| Railway volume (PostgreSQL data, volume backups) | $0.15 per GB-month |
| Railway egress | $0.05 per GB |
| Railway Storage Buckets | $0.015 per GB-month, egress and operations free |
| Backblaze B2 (off-site copy) | $6.95 per TB-month, first 10 GB free |

## 2. Assumptions

- Average (not peak) utilisation. HR workloads are bursty: morning punches, month-end payroll.
- The worker runs headless Chromium for PDFs, so its RAM is the main cost driver.
- Staging is smaller than production and could be stopped when not in use.
- Average document size ~300 KB. Photos compressed.
- Excluded: domain name (~$10–20/year at typical registrars, verify), developer time, a third-party e-signature service (not planned).

## 3. Scenarios (monthly, USD)

| Component | **S — ≤ 100 employees** | **M — ~500 employees** | **L — ~2,000 employees** |
|---|---|---|---|
| web (API + PWA) | 0.1 vCPU + 0.4 GB ≈ **$6** | 0.25 vCPU + 1 GB ≈ **$15** | 2 replicas × (0.4 vCPU + 1 GB) ≈ **$36** |
| worker | 0.05 vCPU + 0.4 GB ≈ **$5** | 0.1 vCPU + 0.8 GB ≈ **$10** | 0.25 vCPU + 1.5 GB ≈ **$20** |
| PostgreSQL compute | 0.1 vCPU + 0.5 GB ≈ **$7** | 0.3 vCPU + 1.5 GB ≈ **$21** | 1 vCPU + 4 GB ≈ **$60** |
| PostgreSQL volume | 5 GB ≈ **$0.75** | 20 GB ≈ **$3** | 60 GB ≈ **$9** |
| Volume backups (incremental) | ~5 GB ≈ **$0.75** | ~30 GB ≈ **$4.50** | ~100 GB ≈ **$15** |
| Bucket (documents) | 10 GB ≈ **$0.15** | 100 GB ≈ **$1.50** | 500 GB ≈ **$7.50** |
| Egress | 5 GB ≈ **$0.25** | 20 GB ≈ **$1** | 80 GB ≈ **$4** |
| **Production subtotal** | **≈ $20** | **≈ $56** | **≈ $152** |
| Staging (reduced) | ≈ $12 | ≈ $15 | ≈ $20 |
| **Railway usage total** | **≈ $32** | **≈ $71** | **≈ $172** |
| Railway bill on Pro (usage above the $20 included) | **≈ $32** | **≈ $71** | **≈ $172** |
| Off-site backup (B2) | $0 (inside free 10 GB) | ≈ $1 | ≈ $4 |
| **Estimated monthly total** | **≈ $32** | **≈ $72** | **≈ $176** |

**Starting point (owner answer Q-02): scenario S**, scaling up as companies and employees are added. The in-app restore (DL-010) needs the PostgreSQL volume at about 2.5× the database size. That adds about $1 (S), $5 (M) or $13 (L) per month for volume storage, which is not included in the table above.

On Pro, the $20 subscription includes $20 of usage, so the bill is the larger of $20 or actual usage. The Hobby plan gives a similar bill for scenario S, but with 7-day logs, a 1 TB bucket cap and fewer replicas. Hence D-14 recommends Pro for production.

## 4. Required vs optional services

| Service | Required? | Cost |
|---|---|---|
| Railway plan + compute + PostgreSQL | **Required** | Table above |
| Railway Storage Bucket | **Required** (after Q-19) | Table above |
| Off-site backup provider (B2 or R2) | **Strongly recommended** (BKP-04) | ~$0–4 |
| Custom domain | **Recommended** (WebAuthn/PWA, Q-04) | ~$10–20/year (verify) |
| Web Push (VAPID) | Required for push | **Free** (browser vendors' push services) |
| TOTP MFA | Required | **Free** (open standard, user's authenticator app) |
| Monitoring | Railway built-in metrics/logs included | $0. Optional external uptime/error tracking: free tiers exist (verify before choosing) |
| SMTP (future) | Not in initial scope | Per provider, typically pennies per thousand emails. To be priced when activated |
| GitHub | Owner's account | Private repos available on the free plan (verify Actions minutes against usage). CodeQL on private repos needs paid GitHub Advanced Security, so the plan uses Semgrep/OSV instead |
| Malware scanning (ClamAV) | Optional | ≈ +1 GB RAM ≈ +$10/month |

## 5. Cost controls

Usage alerts and limits in the Railway workspace (owner sets them), stopping staging out of hours, compressing photos, retention policies for logs and backups, and monthly review of the Railway usage page.

## Sources

- https://railway.com/pricing
- https://docs.railway.com/storage-buckets
- https://docs.railway.com/volumes/backups
- https://developers.cloudflare.com/r2/pricing/
- https://www.backblaze.com/cloud-storage/pricing
