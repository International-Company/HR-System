# Security & Privacy Plan

Status: **Proposed** (AUTH-10). Technical recommendations are kept separate from **legal matters**, which need specialist verification (§10).

## 1. Assets & classification

| Class | Examples | Controls |
|---|---|---|
| Restricted – identity | National ID/passport, date of birth | App-level encryption (D-06), `employee.identity.view`, audit on read |
| Restricted – financial | Salary, allowances, bank account, IBAN, payslips | Encryption for bank/IBAN, `employee.financial.view`, audit on read/export |
| Restricted – special category | Medical leave attachments | Separate document category + permission. Managers see the decision only |
| Confidential | Contracts, documents, attendance, leave, evaluation, recruitment | Scope-based access, encrypted file contents |
| Security-critical | Password hashes, sessions, TOTP secrets, WebAuthn keys, encryption keys, audit log | Never exported. Secrets in Railway variables only |

## 2. Threat model (summary, STRIDE)

| Threat | Example | Mitigations |
|---|---|---|
| Spoofing | Credential stuffing, stolen session | Argon2id, lockout, MFA by role, HttpOnly/Secure cookies, session rotation on login, idle + absolute timeout |
| Tampering | Editing locked payroll, punches or audit | DB triggers for immutability, append-only ledgers, hash-chained audit, server-side time |
| Repudiation | "I didn't approve that" | Audit of every decision with session/IP/device. Signature evidence |
| Information disclosure | IDOR across companies, leaky search/export | Policy service + RLS, 404 on out-of-scope, field filtering, presigned URLs ≤ 5 min |
| Denial of service | Login floods, huge uploads | Rate limits (IP + account), upload size limits, request body limits, pagination caps |
| Elevation of privilege | Admin self-grants, mass assignment | Explicit DTO allow-lists, dual control option, role-change audit + notification |
| Attendance fraud | Punching from outside the office, buddy punching | IP allow-list (spoof-tested), device registration, WebAuthn UV, device-bound PIN. Documented limits |

## 3. Authentication controls (AUTH-01 to AUTH-08)

| Control | Default (configurable within safe bounds) |
|---|---|
| Password hashing | Argon2id (memory ≥ 19 MiB, t=2, p=1 per OWASP guidance) |
| Password policy | Min 12 characters, check against a breached/common-password list, no forced periodic rotation (NIST SP 800-63B). **Minimum length cannot be set below 8** |
| Lockout | 5 failures → 15-minute lock (progressive). Admin unlock audited |
| MFA | TOTP or WebAuthn. **Required by default for System Administrator, HR, Finance and Senior Management** (proposal) |
| Sessions | Idle 30 min, absolute 12 h (attendance-only employees can be given a longer device credential). Remote revoke. New-device notification |
| PIN (4-digit) | Device-bound quick unlock only (C-06). Stored as Argon2id with the device secret. 5 failures disable PIN on that device |
| WebAuthn | `userVerification=required`, RP ID = production domain (Q-04), attestation `none`. **No biometric data ever reaches the server** — only public keys |
| Account lifecycle | Creation and permission changes audited. Termination policy auto-disables accounts (TRM-05) |

## 4. Application security controls

- **Transport:** HTTPS only (Railway TLS), HSTS, secure cookies.
- **Headers:** strict CSP (no inline scripts), `X-Content-Type-Options`, `Referrer-Policy`, `frame-ancestors 'none'`, Permissions-Policy (no geolocation, camera, microphone).
- **Input:** zod validation on every endpoint, parameterised SQL only, output encoding by React, no `dangerouslySetInnerHTML` except sanitised contract templates (DOMPurify).
- **CSRF:** SameSite=Lax + synchroniser token header.
- **File uploads:** allow-list of types per category, magic-byte check (not the extension), size limits, random object keys, private bucket, `Content-Disposition: attachment` downloads, image re-encoding for photos, no server-side execution. Malware scanning: optional ClamAV worker (no cost, about 1 GB RAM extra). **Decision pending, recommended for documents uploaded by candidates.**
- **Template injection:** contract merge fields use a logic-less renderer (no code execution).
- **Report/Excel export:** neutralise CSV/Excel formula injection (`=`, `+`, `-`, `@` prefixes).
- **Rate limiting:** login, PIN, punch and export endpoints.
- **Logging:** structured JSON logs. **No secrets, passwords, tokens, national IDs or bank numbers in logs** (redaction middleware + tests).

## 5. Data protection

| Area | Plan |
|---|---|
| Encryption at rest | Railway volume/bucket encryption (provider) **plus** app-level AES-256-GCM envelope encryption for restricted fields and document contents (D-06) |
| Key management | `DATA_ENCRYPTION_MASTER_KEY` (Railway secret) wraps per-record data keys. A `key_id` stored per ciphertext allows rotation. **The owner keeps an offline escrow copy.** Losing the key means losing encrypted data, including in backups |
| Backups | Logical dumps encrypted before leaving Railway. Because of the in-app restore (DL-010), the decryption key is a worker secret. Off-site credentials cannot delete, and object lock is on. The owner keeps an offline escrow copy |
| Data minimisation | Only specified fields (EMP-05). No GPS, no biometrics |
| Retention | Configurable per data class. Proposal: retention policies are defined with HR/legal (§10) before go-live. Until then, nothing is purged automatically |
| Test data | Synthetic only (QA-04). Production copies are forbidden in non-production without approval and masking |
| Access review | Quarterly report of sensitive permission holders for the owner |

## 6. Secure SDLC

- Branch protection, PR review, CI gates: typecheck, lint, unit, integration, authz matrix, `gitleaks`, OSV-Scanner/`npm audit` (fail on high/critical), Semgrep rules.
- Dependency updates: Renovate/Dependabot weekly. Security patches within **7 days (critical), 30 days (high)**.
- Before pilot: OWASP ASVS Level 2 checklist review, OWASP ZAP baseline scan on staging, manual authorization testing.
- **Open critical/high findings block phase acceptance (QA-03).**

## 7. Incident response (outline)

1. Detect (alerts/logs/user report) → 2. Contain (revoke sessions, rotate secrets, disable accounts) → 3. Assess scope with the audit log → 4. Recover (patch, restore if needed) → 5. Notify the owner and **legally required parties (jurisdiction-dependent, §9)** → 6. Post-incident review in `docs/08-operations/incidents/`.

## 8. Secrets inventory (names only, never values)

`DATABASE_URL`, `SESSION_SECRET`, `CSRF_SECRET`, `DATA_ENCRYPTION_MASTER_KEY`, `BLIND_INDEX_KEY`, `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `BACKUP_S3_*`, `BACKUP_ENCRYPTION_KEY` (worker only), `OPS_DATABASE_URL` (worker only: creates/switches restore slots), `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGIN`, `SMTP_*` (unset initially).

## 9. GDPR — technical measures planned (Q-01 = EU)

These are technical measures that support GDPR compliance. They do not replace legal review.

| GDPR area | Planned measure | Status |
|---|---|---|
| Data residency | Railway EU West (Amsterdam). Bucket and off-site backups in EU regions | Planned |
| Processors | Railway and the backup provider are processors. **The owner signs their Data Processing Agreements** (Railway is a US company, so transfer safeguards such as SCCs/DPF need legal confirmation) | Owner action |
| Data minimisation | Only the specified fields (EMP-05). No GPS. **No biometric data processed**: WebAuthn verification happens on the device and only a public key reaches the server | By design |
| Security of processing (Art. 32) | This plan: encryption, access control, audit, backups, restore tests | Planned |
| Data-subject rights (access, rectification) | **Proposed new requirement PRIV-01:** export of an employee's personal data (JSON/PDF) by HR on request. Rectification already exists through profile editing with audit | Needs approval (change request) |
| Storage limitation | **Proposed PRIV-02:** retention-policy engine per data class (anonymise or delete after N years, with legal-hold override). Retention periods must be set before go-live (C-20) | Needs approval |
| Records of processing (Art. 30) | **Proposed PRIV-03:** documentation template (the owner's legal responsibility). The system supplies the data-category inventory | Docs |
| DPIA (Art. 35) | Employee attendance monitoring is commonly treated as needing a DPIA. I supply the technical description. The assessment itself is a legal task | Owner/legal |
| Breach notification (Art. 33: 72 h to the authority) | Incident runbook plus audit queries to scope a breach quickly | Planned |

## 10. Legal and privacy matters requiring specialist verification

These are **not** technical decisions. They depend on the exact member state(s) (Q-28):

1. Lawful basis and employee notice for processing HR data, including attendance device data and IP addresses.
2. Data residency / cross-border transfer rules. Railway regions are US, EU and Singapore only.
3. Retention periods for employment, payroll, attendance and recruitment data, plus rejected candidates' data.
4. Legal validity of in-app electronic signatures for employment contracts (Q-14).
5. Breach notification duties and timelines.
6. Labour-law rules embedded in configuration defaults (leave entitlement, overtime pay, end-of-service).
7. Employee rights (access, correction) and any obligation to provide data exports.
8. Whether works councils or employee representatives must be consulted before introducing attendance monitoring (required in some member states).
9. Written-form requirements for some employment contract terms (in some member states a simple e-signature is not sufficient).
10. National working-time recording obligations (EU case law requires a system for recording daily working time). The attendance module supports this technically.
