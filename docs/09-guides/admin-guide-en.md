# Administrator guide

For the system administrator and the group HR lead. Technical operations (deploy, backups, faults) are in [runbooks.md](../08-operations/runbooks.md).

## 1. First set-up, in order

1. **Companies:** create each company of the group. Departments are optional.
2. **Modules:** in **Settings → Modules**, turn on what each company uses: documents, attendance, leave, payroll, contracts, recruitment, separation, evaluation and reports.
3. **Lookups:** job titles, work locations, employment categories and contract types.
4. **Work schedules and public holidays:** create a schedule per company or department, then add the year's holidays.
5. **Attendance set-up:**
   - add the authorised networks (the office's public IP address);
   - choose whether a registered device is required.
6. **Leave:** review the leave types, balances and accrual rules per company.
7. **Contract set-up:** create the templates, the clauses and the rules for each contract type.
8. **Payroll:** review the calculation settings: day rate, overtime and end-of-service. There is no statutory tax or social-insurance engine; enter those amounts as manual or fixed items (DL-045).
9. **Approval routes:** review the default route for each request type and adjust it if needed.
10. **Employees and users:**
    1. Add the employees.
    2. Create their accounts in **Users**.
    3. Link each account to its employee.
    4. Assign roles.

## 2. Roles and permissions

| Role | Usual scope | Notes |
|---|---|---|
| System Administrator | Group | Accounts, settings and backups. Does **not** see salaries, ID documents or medical records unless also given a role that includes them |
| HR Employee | Company | Employees, leave and contracts; signs contracts for the company |
| Accountant / Finance | Company | Prepares and pays payroll |
| Senior Management | Group | Views and approves |
| Company Manager | Company | Views and approves within their company |
| Department Manager | Department | Their department's employees only |
| Timekeeping Officer | Company | Attendance review and corrections |
| Employee | Self | Own data only |

- A person can hold several roles with different scopes, for example HR in company A and department manager in company B.
- **Custom roles:** create a role with only the permissions needed. Nobody can change a role they hold.
- **Separation of duties enforced by the system:**
  - whoever prepares payroll cannot approve it;
  - nobody can add items to their own pay or manage their own contract;
  - nobody can link their own account, or an administrator's account, to an employee;
  - one person cannot make two decisions on the same request.
- **Sensitive permissions** are salary data, restricted documents such as ID scans, and restore. Review who holds them every month.

## 3. Users

- **Unlock:** accounts lock automatically after wrong attempts. Unlock one in **Users → user → Unlock**.
- **Reset two-step verification** when a phone is lost. The user enrols again at the next sign-in.
- **End all sessions** if you suspect an account is compromised.
- **Disable** blocks sign-in at once. After a separation, the account is disabled automatically after the last working day.
- **Always keep at least two active administrators.**

## 4. Key settings

- **Security:**
  - attempts before lockout and lockout time;
  - two-step verification is required for the administrator, HR, finance and senior management roles by default.
- **Dashboards:** in **Settings → Dashboards**, choose the cards each role sees and their order.
- **Employee and contract numbering:** prefix and number of digits.
- **Commitment evaluation:**
  - weights, bands and period;
  - whether employees see their own score;
  - whether the score affects pay.

## 5. Audit log

- Every create, change and delete, and every view or export of sensitive data, is recorded with the user, time and address.
- The log is chained and checked daily, so tampering is detected.
- Filter by user, company, action and date.
- Amounts and personal data in the log are shown only to readers allowed to see them.

## 6. Backup and restore

- A daily encrypted backup is taken. It is copied to off-site storage once that is set up; Backblaze is proposed but not yet enabled.
- **In-app restore:**
  1. Go to **Backups → choose a backup → Preview**.
  2. Confirm with two-step verification.
  3. A second administrator approves.
  4. A safety backup is taken first, and the restore can be undone.
- **Encryption keys:** keep an offline copy of the data-encryption key and the backup-encryption key in a safe place. Without them the data cannot be read.

## 7. Routine

| When | Task |
|---|---|
| Monthly | Review holders of sensitive permissions, account-link events, the Backups page and Railway costs |
| Quarterly | Restore drill on a copy; access review |
| Yearly | Public holidays for the new year; leave carry-over check; security review |

## 8. Out of scope (approved scope)

- Performance appraisal, goals and self-assessment.
- Document-expiry alerts.
- A clearance module.
- Mandatory loans.
- A native mobile app.
- E-mail, SMS and WhatsApp.
- GPS location.
- Fingerprint storage.
