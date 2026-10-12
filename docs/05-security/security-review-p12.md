# Security review — Phase 12 (hardening)

Date: 2026-10-11 · Scope: API (all modules), database row-level security, web headers · Method: independent code review in the OWASP ASVS L2 mindset (two reviewers, controller → service → RLS policy traced end to end), automated route sweep, live header check, performance baselines.

**Result: no critical findings. One finding was rated high by one reviewer (candidate identity files) and is fixed. All medium findings are fixed. Remaining low items are listed as accepted residual risks below.**

## 1. Findings and status

| # | Finding | Severity | Status | Fix / evidence |
|---|---|---|---|---|
| 1 | Candidate files of restricted categories (identity scans) readable with only `recruitment.view` | High (reviewer 2) / Medium | ✅ Fixed | Listing and download require `documents.view.restricted` for restricted categories; medical never. `security-fixes.test.ts` |
| 2 | An administrator could link their own (or another admin) account to an employee and read that person's salary and ID number through "self" access | Medium–High | ✅ Fixed | Linking one's own account or an administrator account is refused. Residual risk R1 below |
| 3 | MFA attempts and login failures counted with read-then-write (races); wrong MFA codes never locked the account | Medium | ✅ Fixed | Atomic counters; wrong MFA codes count toward the account lockout. `security-fixes.test.ts` (parallel wrong passwords) |
| 4 | A custom-role holder with `access.role.manage` could widen their own role | Medium | ✅ Fixed | Changing a role one holds is refused |
| 5 | Audit log showed salary, payment and settlement values to readers without the financial permission | Medium | ✅ Fixed | Values masked (•••) unless the reader has the financial/identity permission in that company; the stored audit record is unchanged |
| 6 | Uploading a signed contract copy completed the company signature without the signing permission, on drafts, and on one's own contract | Medium | ✅ Fixed | Needs a company signer (`contracts.sign`) who is not the contract's employee, on a version sent for signature; records the version fingerprint; nobody manages their own contract. HR role now includes `contracts.sign` (company signer for paper signatures) |
| 7 | Payroll separation of duties: a preparer could add a bonus to their own pay; item authors could approve; one person could approve several steps | Medium | ✅ Fixed | No items on one's own pay; creator and item authors excluded from approval; one decision per person per request (workflow engine) |
| 8 | Single leave requests and separations readable by anyone with any role in the company (row policy only) | Medium/Low | ✅ Fixed | Scope checks (self, department, HR, or approver) before returning |
| 9 | Department-scoped users saw company-wide dashboard figures and names of people on leave; department-scoped `separation.view` saw the whole company | Low–Medium | ✅ Fixed | Department filtering in widgets and separations. `security-fixes.test.ts` |
| 10 | Push subscription endpoints could point to internal hosts (blind SSRF from the worker) | Low–Medium | ✅ Fixed | Only HTTPS endpoints of the browsers' push services are accepted and used |
| 11 | Interviewers saw candidate contact details, internal notes and other interviewers' feedback, also after a cancelled interview; could record results on closed applications | Low | ✅ Fixed | Reduced view; access only while the interview is scheduled or held; closed applications refused |
| 12 | Hiring a candidate twice in parallel could create two employee records | Low | ✅ Fixed | Employee creation and the hire mark run in one transaction with the application and candidate locked |
| 13 | Disabled account answered 403 only after a correct password (confirmed the password) | Low | ✅ Fixed | Same answer as a wrong password |
| 14 | Text of a partly signed contract version not protected by the database; payments could be inserted for unapproved runs at database level | Low | ✅ Fixed | Migration 0012 triggers |
| 15 | Contract templates, clauses and type rules readable by every employee | Low | ✅ Fixed | Only for staff who prepare contracts (found by the route sweep) |

## 2. Accepted residual risks (owner review)

| ID | Risk | Why accepted / mitigation | Owner action |
|---|---|---|---|
| R1 | An administrator can still create a separate ordinary account and link it to an employee, then read that employee's self-service data | Administrators are fully trusted for accounts by design; every link is in the audit log (`employee.account_linked`). Dual control can be added later | Review account-link events monthly |
| R2 | ~~Login rate limiting kept in memory per server process~~ | **Closed (2026-10-12):** limits are kept in the database (migration 0013, hashed keys), shared by all processes and replicas; `rate-limit.test.ts` | — |
| R3 | ~~Password change and the restore step-up have no own attempt counter~~ | **Closed (2026-10-12):** wrong passwords or codes when changing the password, turning MFA off or confirming a restore count toward the account lockout; at the limit the account locks and all its sessions end. Device PIN failures are counted atomically; `rate-limit.test.ts` | — |
| R4 | Contract text may contain the salary; readers with `contracts.view` (built-in roles that already see salaries) can read it | Built-in roles are consistent; only a custom role could expose more | Keep salary placeholders out of templates for custom-role readers |
| R5 | Scheduled reports run with the owner's permissions at run time even if the owner has not yet enabled MFA required later | Permissions and scope are re-checked at each run | — |
| R6 | No malware scanning of uploaded files (optional ClamAV worker, security plan) | Files are type-checked by content, size-limited, encrypted, and served with `nosniff` and a sandbox CSP | Decide before candidates upload files at scale |

## 3. Automated checks added

| Check | File | What it proves |
|---|---|---|
| Route sweep | `test/route-coverage.test.ts` | Every route (230, read from the controllers) refuses anonymous callers except the public ones; a plain employee gets data only from self-service endpoints; junk input never causes a 5xx |
| Regression tests | `test/security-fixes.test.ts` | One test per fixed finding |
| Performance | `test/performance.test.ts` | Payroll for 200+ employees with a month of attendance ≈ 1.9 s; punch p95 ≈ 47 ms (target < 1 s) on the in-process database |

## 4. Live configuration (production domain, 2026-10-11)

HTTPS only (HTTP → 301), `Strict-Transport-Security: max-age=31536000; includeSubDomains`, CSP `default-src 'self'` with `frame-ancestors 'none'` and `object-src 'none'`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `Permissions-Policy` without geolocation/camera/microphone/payment, `Cross-Origin-Opener-Policy: same-origin`, API responses `Cache-Control: no-store`; session cookie `__Host-`, HttpOnly, Secure, SameSite=Lax; client address behind Railway verified (DL-035). Dependency audit: 0 known vulnerabilities (`npm audit --omit=dev`).

## 5. Not done in this phase (needs the owner)

- Dynamic scan with OWASP ZAP and a manual penetration test on staging (no local tools by the owner's choice, Q-25; can run in CI or by an external tester).
- Restore drill against the off-site backup (needs Backblaze, pending).
- Accessibility check with a screen reader on real devices (code scan of form controls and icon buttons done; missing labels fixed).
