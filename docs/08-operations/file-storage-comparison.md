# File-Storage Comparison & Recommendation

Status: **Recommendation. No provider is selected or activated until the owner approves (Q-19).**
Prices were checked on 2026-10-10 from the providers' public pages (sources at the end). Re-check them before approval.

## 1. Options

| Criterion | **Railway Storage Buckets** | Cloudflare R2 | Backblaze B2 | AWS S3 Standard | Railway Volume (filesystem) | PostgreSQL `bytea` |
|---|---|---|---|---|---|---|
| Storage price | $0.015/GB-month | $0.015/GB-month (10 GB free) | $6.95/TB-month (~$0.007/GB), 10 GB free | Higher than the others (verify current regional price) | $0.15/GB-month | Volume price ($0.15/GB) + DB bloat |
| Egress / operations | **Free and unlimited** | Egress free. Class A $4.50/M, Class B $0.36/M (free tier 1 M / 10 M) | Free egress up to 3× stored, then $0.01/GB. Most API calls free | Paid egress and requests | Internal | Internal |
| Railway compatibility | Native, same project, credentials injected per environment | External S3 API, works from Railway | External S3 API | External S3 API | Native, but bound to one service and blocks multiple replicas | Native |
| Security | Private only, presigned URLs, encrypted at rest. **No versioning, object lock or lifecycle yet** | Private buckets, presigned URLs, encryption at rest, object lock available | Encryption, object lock available | Most complete (versioning, lock, KMS) | Disk encryption by provider | DB access controls |
| Backup / recovery | **No backups/snapshots.** A deleted bucket is recoverable for 52 h only → **needs an external copy** | Versioning not equivalent to backups. Lifecycle tools available | Object lock/versions available | Versioning + replication | Railway volume backups | Included in DB backups (large dumps) |
| Portability | S3 API → easy to move | S3 API | S3 API | S3 API | Filesystem → migration effort | Poor (bloated DB) |
| Operational complexity | Lowest (one platform, one bill) | Low (second account) | Low (second account) | Medium (IAM) | Low, but scaling limits | Low, but backups and performance suffer |
| Hobby plan cap | 1 TB total | — | — | — | — | — |

## 2. Recommendation (D-05)

1. **Primary:** Railway Storage Buckets. Lowest operational complexity, free egress and operations, same billing, separate buckets per environment.
**EU (DL-008):** the Railway bucket is created in EU West. The off-site copy uses an EU region (Backblaze B2 EU Central, or Cloudflare R2 with EU jurisdiction). Off-site app credentials have **no delete capability**, and the bucket has **object lock**, because the in-app restore means the worker holds the backup key (DL-010).

2. **Secondary copy (required because Railway Buckets have no versioning or backups):** a nightly job in the worker copies new and changed objects (already application-encrypted, D-06) to **Backblaze B2** (cheapest at rest; object lock available for ransomware protection). **Cloudflare R2** is an equally valid alternative. The copy lives under a different provider and account, which also satisfies BKP-04 (separation from production).
3. **Code is provider-agnostic:** all access goes through `StoragePort` (S3 API). Switching the primary to R2/B2/S3 is a configuration change plus a data copy.
4. **Rejected:** Railway Volume (blocks horizontal scaling, 10× the price per GB) and PostgreSQL `bytea` (bloats backups and the database).

Expected cost at 100 GB of documents: Railway ≈ $1.50/month + B2 copy ≈ $0.63/month (see cost-analysis.md).

## 3. What is stored where

| Data | Location |
|---|---|
| Metadata, permissions, links, hash, `key_id`, object key | PostgreSQL (`document`, `stored_object`) |
| File content (encrypted AES-256-GCM, per-object data key) | Bucket `hrms-<env>-files`, key `obj/<uuidv7>` |
| Generated PDFs (payslips, contracts) | Same bucket, linked to their record |
| DB logical dumps (encrypted) | Off-site provider bucket `hrms-backups` (not the primary bucket) |

## Sources

- Railway pricing: https://railway.com/pricing
- Railway Storage Buckets docs: https://docs.railway.com/storage-buckets
- Cloudflare R2 pricing: https://developers.cloudflare.com/r2/pricing/
- Backblaze B2 pricing: https://www.backblaze.com/cloud-storage/pricing
