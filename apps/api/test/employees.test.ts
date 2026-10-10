import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asAppRole, grant, setup, type Session, type TestEnv } from './helpers.js';
import { lookupValue } from '../src/db/schema.js';

const today = () => new Date().toISOString().slice(0, 10);
const daysFromNow = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

describe('employees (EMP-01..11, ORG-05)', () => {
  let env: TestEnv;
  const s: Record<string, Session> = {};
  let A: string, B: string, salesA: string, fullTime: string, openEnded: string, transportType: string;
  let created: string;

  beforeAll(async () => {
    env = await setup();
    A = env.seeded.companies['DEMO-A']!;
    B = env.seeded.companies['DEMO-B']!;
    salesA = env.seeded.departments['DEMO-A/SALES']!;
    const lookups = await env.database.system((tx) => tx.select().from(lookupValue));
    fullTime = lookups.find((l) => l.code === 'full_time')!.id;
    openEnded = lookups.find((l) => l.code === 'open_ended')!.id;
    transportType = lookups.find((l) => l.code === 'TRANSPORT')!.id;
    for (const u of ['admin', 'hr.a', 'hr.b', 'manager.a', 'sales.manager', 'finance.a', 'employee.a', 'senior']) {
      s[u] = await env.login(u);
    }
  });
  afterAll(async () => env.close());

  const newEmployee = (over: Record<string, unknown> = {}) => ({
    personal: {
      fullNameAr: 'نور الدين',
      fullNameEn: 'Nour Aldeen',
      idType: 'national_id',
      idNumber: 'TEST-778899',
      gender: 'male',
      nationality: 'DE',
      email: 'nour@example.test',
    },
    hireDate: today(),
    probationEndDate: daysFromNow(90),
    assignment: { companyId: A, departmentId: salesA, employmentCategoryId: fullTime, contractTypeId: openEnded },
    compensation: {
      baseSalary: '4200.50',
      currency: 'EUR',
      paymentMethod: 'bank_transfer',
      items: [{ kind: 'allowance', typeId: transportType, calc: 'fixed', amount: '200' }],
    },
    bankAccount: { bankName: 'Demo Bank', iban: 'DE89 3704 0044 0532 0130 00', isPrimary: true },
    ...over,
  });

  it('HR creates an employee with a group-wide number, probation status and salary', async () => {
    const r = await s['hr.a']!.post('/employees', newEmployee());
    expect(r.status, r.text).toBe(201);
    created = r.body.id;
    expect(r.body.employeeNo).toMatch(/^EMP-\d{6}$/);
    expect(r.body.status).toBe('probation');
    expect(r.body.compensation.baseSalary).toBe('4200.5');
    expect(r.body.compensation.items).toHaveLength(1);
    expect(r.body.idNumber).toBe('TEST-778899');
    expect(r.body.current.companyId).toBe(A);
  });

  it('cannot create employees in another company (HR of company B)', async () => {
    const r = await s['hr.b']!.post('/employees', newEmployee({ personal: { fullNameAr: 'س', fullNameEn: 'X' } }));
    expect(r.status).toBe(404);
  });

  it('rejects a duplicate identity number, even across companies', async () => {
    await grant(env, 'hr.b', 'hr', 'COMPANY', 'DEMO-A');
    const r = await s['hr.a']!.post('/employees', newEmployee());
    expect(r.status).toBe(409);
  });

  it('stores identity numbers and IBANs encrypted, never in plain text', async () => {
    const rows = await env.database.owner.query<{ t: string }>(
      `select coalesce(encode(id_number_enc, 'escape'), '') as t from employee
       union all select coalesce(encode(iban_enc, 'escape'), '') from bank_account`,
    );
    for (const r of rows) {
      expect(r.t).not.toContain('TEST-778899');
      expect(r.t).not.toContain('DE89');
    }
    const audit = await env.database.owner.query<{ c: number }>(
      `select count(*)::int as c from audit_event where coalesce(after::text,'') || coalesce(before::text,'') ~ '(TEST-778899|DE89370400)'`,
    );
    expect(audit[0]!.c).toBe(0);
  });

  it('hides salary and bank data from roles without the financial permission (EMP-09)', async () => {
    const mgr = await s['manager.a']!.get(`/employees/${created}`);
    expect(mgr.status).toBe(200);
    expect(mgr.body.compensation).toBeNull();
    expect(mgr.body.idNumber).toMatch(/^••••/);
    expect(mgr.body.idNumberMasked).toBe(true);
    expect((await s['manager.a']!.get(`/employees/${created}/bank-accounts`)).status).toBe(403);

    const fin = await s['finance.a']!.get(`/employees/${created}`);
    expect(fin.body.compensation.baseSalary).toBe('4200.5');
    const bank = await s['hr.a']!.get(`/employees/${created}/bank-accounts`);
    expect(bank.body[0].iban).toBe('DE89370400440532013000');
  });

  it('employees see their own profile, current salary and masked bank only (EMP-10)', async () => {
    const own = env.seeded.employees['employee.a']!;
    const list = await s['employee.a']!.get('/employees');
    expect(list.body.map((e: { id: string }) => e.id)).toEqual([own]);
    const me = await s['employee.a']!.get(`/employees/${own}`);
    expect(me.status).toBe(200);
    expect(me.body.compensation.baseSalary).toBe('3100');
    expect(me.body.access.self).toBe(true);
    expect((await s['employee.a']!.get(`/employees/${created}`)).status).toBe(404);
    expect((await s['employee.a']!.get(`/employees/${env.seeded.employees['emp.fin']}`)).status).toBe(404);
    const session = await s['employee.a']!.get('/auth/session');
    expect(session.body.user.employeeId).toBe(own);
  });

  it('department managers see only their department (and no salaries)', async () => {
    const list = await s['sales.manager']!.get('/employees');
    const ids = list.body.map((e: { id: string }) => e.id);
    expect(ids).toContain(env.seeded.employees['employee.a']);
    expect(ids).not.toContain(env.seeded.employees['emp.fin']);
    expect((await s['sales.manager']!.get(`/employees/${env.seeded.employees['emp.fin']}`)).status).toBe(404);
    const rep = await s['sales.manager']!.get(`/employees/${env.seeded.employees['employee.a']}`);
    expect(rep.body.compensation).toBeNull();
  });

  it('company-scoped lists never include other companies', async () => {
    const a = await s['hr.b']!.get(`/employees?companyId=${B}`);
    expect(a.body.every((e: { companyId: string }) => e.companyId === B)).toBe(true);
    const raw = await asAppRole(env.database, { group: false, companyIds: [B] }, (q) =>
      q('select id from employee where id = $1', [created]),
    );
    expect(raw).toEqual([]);
  });

  it('confirms probation and records the lifecycle event', async () => {
    const r = await s['hr.a']!.post(`/employees/${created}/status`, { status: 'active', effectiveDate: today(), reason: 'Probation passed' });
    expect(r.status, r.text).toBe(201);
    expect(r.body.status).toBe('active');
    const h = await s['hr.a']!.get(`/employees/${created}/history`);
    expect(h.body.events.map((e: { type: string }) => e.type)).toContain('probation_confirmed');
  });

  it('changes salary effective-dated, keeping history; rejects back-dating over the current period', async () => {
    const bad = await s['hr.a']!.post(`/employees/${created}/compensation`, {
      baseSalary: '5000', currency: 'EUR', paymentMethod: 'bank_transfer', items: [],
      effectiveDate: today(), event: 'salary_change', reason: 'x',
    });
    expect(bad.status).toBe(400);
    const ok = await s['hr.a']!.post(`/employees/${created}/compensation`, {
      baseSalary: '5000', currency: 'EUR', paymentMethod: 'bank_transfer', items: [],
      effectiveDate: daysFromNow(30), event: 'promotion', reason: 'Annual review',
    });
    expect(ok.status, ok.text).toBe(201);
    const h = await s['hr.a']!.get(`/employees/${created}/history`);
    expect(h.body.compensation).toHaveLength(2);
    expect(h.body.compensation[1].validTo).toBe(daysFromNow(29));
    // Finance-less users do not see salary events.
    const mgrHistory = await s['manager.a']!.get(`/employees/${created}/history`);
    expect(mgrHistory.body.compensation).toBeNull();
  });

  it('transfers between companies keeping the employee number and history (ORG-05)', async () => {
    const before = await s['hr.a']!.get(`/employees/${created}`);
    const denied = await s['manager.a']!.post(`/employees/${created}/assignments`, {
      companyId: B, effectiveDate: daysFromNow(60), event: 'transfer', reason: 'x',
    });
    expect(denied.status).toBe(403);
    // A salary change is scheduled for +30 days, so a transfer at +60 days is allowed.
    const r = await s['hr.b']!.post(`/employees/${created}/assignments`, {
      companyId: B,
      departmentId: env.seeded.departments['DEMO-B/OPS'],
      effectiveDate: daysFromNow(60),
      event: 'transfer',
      reason: 'Group reorganisation',
    });
    expect(r.status, r.text).toBe(201);
    expect(r.body.employeeNo).toBe(before.body.employeeNo);
    const h = await s['hr.b']!.get(`/employees/${created}/history`);
    expect(h.body.assignments).toHaveLength(2);
    expect(h.body.assignments[0].companyId).toBe(B);
    expect(h.body.compensation.at(0).companyId).toBe(B);
  });

  it('the employee number can never be changed, even directly in the database', async () => {
    await expect(env.database.owner.exec(`update employee set employee_no = 'X-1' where id = '${created}'`)).rejects.toThrow(/immutable/);
  });

  it('the database rejects overlapping employment periods', async () => {
    await expect(
      env.database.owner.exec(
        `insert into employment_assignment (id, employee_id, company_id, valid_from)
         values (gen_random_uuid(), '${created}', '${A}', current_date)`,
      ),
    ).rejects.toThrow();
  });

  it('a new number format applies only to new employees (C-01)', async () => {
    expect((await s['admin']!.put('/settings/employee.numberFormat', { value: { prefix: 'G', padding: 4 } })).status).toBe(204);
    const r = await s['hr.a']!.post('/employees', newEmployee({
      personal: { fullNameAr: 'هبة', fullNameEn: 'Heba' },
      compensation: undefined,
      bankAccount: undefined,
    }));
    expect(r.body.employeeNo).toMatch(/^G\d{4}$/);
    const old = await s['hr.b']!.get(`/employees/${created}`);
    expect(old.body.employeeNo).toMatch(/^EMP-/);
  });

  it('master lists are company-scoped and validated on use', async () => {
    const t = await s['hr.a']!.post('/lookups', { kind: 'job_title', companyId: A, code: 'A_ONLY', nameAr: 'خاص', nameEn: 'A only' });
    expect(t.status).toBe(201);
    const bList = await s['hr.b']!.get(`/lookups?kind=job_title&companyId=${B}`);
    expect(bList.body.map((x: { code: string }) => x.code)).not.toContain('A_ONLY');
    const groupWide = await s['hr.a']!.post('/lookups', { kind: 'job_title', code: 'GLOBAL_X', nameAr: 'س', nameEn: 'X' });
    expect(groupWide.status).toBe(403);
    const misuse = await s['hr.b']!.post('/employees', newEmployee({
      personal: { fullNameAr: 'ع', fullNameEn: 'Z' },
      assignment: { companyId: B, jobTitleId: t.body.id },
      compensation: undefined,
      bankAccount: undefined,
    }));
    expect(misuse.status).toBe(400);
  });

  it('qualifications can be added and removed (EMP-04)', async () => {
    const q = await s['hr.a']!.post(`/employees/${env.seeded.employees['emp.fin']}/qualifications`, {
      level: 'bachelor', specialization: 'Accounting', institution: 'Demo University', country: 'DE', graduationYear: 2015,
    });
    expect(q.status).toBe(201);
    const list = await s['hr.a']!.get(`/employees/${env.seeded.employees['emp.fin']}/qualifications`);
    expect(list.body).toHaveLength(1);
    expect((await s['hr.a']!.del(`/employees/${env.seeded.employees['emp.fin']}/qualifications/${q.body.id}`)).status).toBe(204);
    expect((await s['hr.a']!.get(`/employees/${env.seeded.employees['emp.fin']}/qualifications`)).body).toHaveLength(0);
  });

  it('only group administrators link user accounts to employees', async () => {
    const target = env.seeded.employees['emp.fin']!;
    const userId = env.seeded.users['finance.a']!;
    expect((await s['hr.a']!.put(`/employees/${target}/user`, { userId })).status).toBe(403);
    // Administrators need to see the employee: grant read access via HR role at group scope.
    await grant(env, 'admin', 'hr', 'GROUP');
    const admin = await env.login('admin');
    expect((await admin.put(`/employees/${target}/user`, { userId })).status).toBe(204);
    const fin = await env.login('finance.a');
    expect((await fin.get('/auth/session')).body.user.employeeId).toBe(target);
    const dup = await admin.put(`/employees/${env.seeded.employees['emp.ops']}/user`, { userId });
    expect(dup.status).toBe(409);
  });

  it('every change is audited', async () => {
    const admin = await env.login('admin');
    const r = await admin.get(`/audit-events?entityType=employee&entityId=${created}&limit=50`);
    const actions = r.body.items.map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['employee.created', 'employee.probation_confirmed', 'employee.promotion', 'employee.transfer']));
  });
});
