# UI/UX Structured Screen Specifications

Status: **Proposed**. Covers UX-01 to UX-04 and I18N-01/02. Wireframes are low-fidelity ASCII, shown in LTR. In Arabic the whole layout mirrors (sidebar on the right).

## 1. Design foundations

| Token | Value (proposal) | Notes |
|---|---|---|
| Primary | Blue `#1D4ED8` (hover `#1E40AF`) | Contrast ≥ 4.5:1 on white |
| Surface | White `#FFFFFF`, page background `#F5F7FB`, borders `#E2E8F0` | |
| Text | `#0F172A` main, `#475569` secondary | |
| Status colours | success `#15803D`, warning `#B45309`, danger `#B91C1C`, info `#0369A1`, neutral `#64748B` | Status is always shown with **text + colour**, never colour alone |
| Typography | Arabic: **IBM Plex Sans Arabic**, English: **IBM Plex Sans** (both open licence, matching design family) | Self-hosted fonts, no external CDN |
| Icons | Tabler Icons (outline, simple). Direction-sensitive icons (arrows, chevrons) mirror in RTL | |
| Spacing / radius | 4-px grid. Radius 8 px. Light shadows only on popovers | |
| Accessibility | WCAG 2.2 AA target: keyboard navigation, visible focus, labels on every input, 44 px touch targets on mobile, reduced-motion support | |
| RTL | `dir="rtl"` at the root, CSS logical properties only (`margin-inline-start`). Numbers and IBANs in LTR isolation (`<bdi>`) | |
| Numerals | Configurable: Western digits (0-9) or Arabic-Indic (٠-٩). **Default Western** for HR data accuracy | Open item |

## 2. Application shell

```
┌──────────────────────────────────────────────────────────────────────┐
│ [≡] Logo  Company: [Group ▾ / Company A ▾]   🔍 Global search    🔔3  👤 │
├──────────┬───────────────────────────────────────────────────────────┤
│ ◧ Home   │  Breadcrumb › Page title                    [Primary action]│
│ 👥 Employees│ ┌ Filters bar (chips, Advanced ▸) ─────────────────────┐ │
│ ⏱ Attendance│ └──────────────────────────────────────────────────────┘ │
│ 🌴 Leave    │ ┌ Table (sortable, column chooser, row actions ⋯) ─────┐ │
│ 💰 Payroll  │ │                                                       │ │
│ 📄 Contracts│ │                                                       │ │
│ 🗂 Documents│ └───────────────────────── pagination ──────────────────┘ │
│ 🧲 Recruit  │                                                           │
│ 📊 Reports  │                                                           │
│ ⚙ Settings │                                                           │
│ « collapse │                                                           │
└──────────┴───────────────────────────────────────────────────────────┘
```

- **Collapsible sidebar** (icons-only when collapsed; on mobile it becomes a drawer). Menu items appear only for permitted, enabled modules. This is for usability; the server still enforces access.
- **Company switcher** shows only the companies in the user's scopes. "Group" appears only with group-scope roles.
- **Mobile (< 768 px):** bottom bar with Home · Punch · Requests · Notifications · Me. Tables become card lists.

## 3. Screen catalogue

| # | Screen | Primary users | Key content / actions | States |
|---|---|---|---|---|
| S01 | Login | All | Username, password, "trusted device" quick unlock (biometric/PIN) when registered, MFA step | Locked, disabled, MFA required, password expired |
| S02 | Home dashboard | All (role-specific) | Widgets from the catalogue (C-09). Employee: today's punch status, leave balance, pending requests, latest payslip. Manager: pending approvals, team absent/late today. HR: exceptions to review, expiring contracts, probation ends. Finance: payroll run status | Empty states with guidance |
| S03 | Punch (Attendance) | Employee | Big **Check in / Check out / Break** buttons, server time, network status ("Office network ✓" or "Not on authorized network"), method prompt (biometric/PIN), today's timeline | Network denied, device not registered, already checked in, offline (punch is **not** queued offline: requires the server) |
| S04 | My attendance | Employee | Calendar/month list: day class, in/out, late/early/overtime minutes, flags. "Request correction" | |
| S05 | Attendance review | Timekeeping, HR | Exceptions queue: potential absences, missing check-outs, administrative closures, corrections pending. Bulk confirm with reason | |
| S06 | Employees list | HR, managers | Search, filters (company, dept, status, title, location, hire date), column chooser respecting sensitivity, export | |
| S07 | Employee profile | HR (full), manager (limited), employee (self) | Header: photo, name (AR/EN), employee no., status badge, company/dept/title. **Tabs:** Overview · Personal · Employment (history timeline) · Compensation 🔒 · Bank 🔒 · Qualifications · Documents · Contracts* · Attendance · Leave · Payslips 🔒 · Lifecycle | 🔒 tabs not rendered and not returned by the API without permission. *per CON-10 |
| S08 | Lifecycle action wizard | HR | Transfer / promotion / salary change / suspension / confirmation: effective date, new values, reason, attachment → workflow | Preview of the before/after diff |
| S09 | New employee wizard | HR | Steps: Personal → Employment → Compensation → Bank → Documents → Account (create user?) → Review | Duplicate-detection warning (national ID blind index) |
| S10 | Leave: my requests & balances | Employee | Balances per type (with ledger drill-down), new request (type, dates, working-days preview excluding rest days/holidays, attachment if required), in-day permission (date, from-to) | Insufficient balance (policy-dependent block/warn) |
| S11 | Approvals inbox | Managers, HR, Finance | Unified list of workflow tasks: type, requester, summary, age, SLA. Approve/reject with comment. Delegation settings | |
| S12 | Payroll runs | Finance, HR | Runs per company/period with status stepper: Draft → Calculated → In approval → **Locked** → Paid. Totals per currency | |
| S13 | Payroll run detail | Finance | Item grid (employee, gross, deductions, net, currency), line drill-down with **explanations** ("Overtime 6h × 1.5 × 12.50"), manual adjustments (pre-approval, reason required), submit/approve/reject, reopen (special permission) | Locked banner. Read-only |
| S14 | My payslips | Employee | List + PDF view/download (own only) | |
| S15 | Contracts list & detail | HR | Filters (type, status, expiring in N days, probation), detail shows versions/addenda timeline, signers and status, actions: generate from template, send for signature, upload signed copy, renew, addendum | Signed = locked, with a lock icon |
| S16 | Contract template editor | HR/Admin | Clauses library, merge fields (`{{employee.full_name_ar}}`), required fields, language, preview with sample employee | |
| S17 | Documents | HR, employee (self per config) | Folder/category tree, metadata filters, upload (type/size validated), replace (policy), delete/restore (policy) | |
| S18 | Recruitment pipeline | HR | Vacancy list → candidates kanban by status (New, Under Review, Interview, Accepted, Rejected, Withdrawn), candidate card: CV, interviews, notes, offer, "Convert to employee" | |
| S19 | Separation cases | HR | Initiate (type, reason, last working day, attachments), approvals, settlement preview, access-policy checklist preview, cancel | |
| S20 | Commitment evaluation | HR, managers | Period selector, per-employee scores with component breakdown, recalculate (permission) | |
| S21 | Reports | Per permission | Dataset → fields (only permitted) → filters → preview → save / export Excel/PDF / print / schedule (in-app delivery) | |
| S22 | Global search results | All | Grouped results (employees, contracts, leave, payroll, documents) limited to scope | |
| S23 | Notification centre | All | Unread/all filter, type filter, mark read/all, click opens the linked item (re-authorised) | |
| S24 | Settings | Admin (and delegated) | Sections per §17 with group value and company override indicator ("Overridden for Company B ↺ reset") | Every change shows "who/when" and is audited |
| S25 | Roles & permissions | Admin | Role list, permission matrix grouped by module with sensitivity badges, assignments with scope picker | Warning when granting sensitive or security permissions |
| S26 | Users & sessions | Admin | Accounts, link to employee, status, MFA status, devices, active sessions with "terminate" | |
| S27 | Audit log | Authorized | Filterable by actor, entity, company, action, date. Before/after diff viewer. Export (audited) | Read-only |
| S28 | My profile & security | All | Own data (limited edits per policy), change password, MFA setup, devices/passkeys, sessions | |

## 4. Interaction rules

1. **Workflow status** always uses one consistent badge set: Draft · Submitted · Pending (step n of m, approver name) · Approved · Rejected · Cancelled · Locked.
2. Destructive or irreversible actions (lock payroll, sign contract, terminate) require a confirmation dialog that states the consequence. Typed confirmation is required for reopen/terminate.
3. Forms validate inline with zod messages in the active language. The server repeats every validation.
4. Dates are shown in the global format (I18N-03). Times are in the group timezone with the zone label shown in tooltips.
5. Empty, loading and error states are designed for every list.
6. Printing uses dedicated print stylesheets (RTL-aware) or the generated PDF.

The prototypes for S03, S07, S11 and S13 are recommended as the first UX validation with the owner before the Phase 2 UI build.
