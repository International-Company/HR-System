import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { API, TEST_PASSWORD, setup, type Session, type TestEnv } from './helpers.js';
import { uuidv7 } from '../src/common/ids.js';
import { role, roleAssignment, rolePermission, userAccount } from '../src/db/schema.js';
import { addDays } from '../src/attendance/time.js';

const PDF = Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\ntrailer << >>\n%%EOF\n');

/** Regression tests for the P12 security review findings. */
describe('security review fixes (P12)', () => {
  let env: TestEnv;
  const s: Record<string, Session> = {};
  let A: string;
  let emp: string;
  const today = new Date().toISOString().slice(0, 10);
  const userId = async (username: string) => (await env.database.system((tx) => tx.select().from(userAccount).where(eq(userAccount.username, username))))[0]!.id;

  beforeAll(async () => {
    env = await setup();
    A = env.seeded.companies['DEMO-A']!;
    emp = env.seeded.employees['employee.a']!;
    for (const u of ['admin', 'hr.a', 'manager.a', 'finance.a', 'sales.manager', 'employee.a']) s[u] = await env.login(u);
    const days = [1, 2, 3, 4, 5, 6, 7].map((d) => ({ isoWeekday: d, isWorkday: true, startTime: '08:00', endTime: '16:00', breaks: [] }));
    const sched = await s['hr.a']!.post('/schedules', { companyId: A, code: 'ALL', nameAr: 'كل الأيام', nameEn: 'All days', graceInMinutes: 10, graceOutMinutes: 5, days });
    await s['hr.a']!.post('/schedule-assignments', { scheduleId: sched.body.id, targetType: 'company', companyId: A, validFrom: '2020-01-01' });
  });
  afterAll(async () => env.close());

  it('accounts: no linking of one’s own or an administrator account', async () => {
    const fin = env.seeded.employees['emp.fin']!;
    expect((await s['admin']!.put(`/employees/${fin}/user`, { userId: await userId('admin') })).status).toBe(403);
    expect((await s['admin']!.put(`/employees/${fin}/user`, { userId: await userId('admin') })).body.detail).toMatch(/own account/);
  });

  it('roles: nobody widens a role they hold', async () => {
    await env.database.system(async (tx) => {
      const id = uuidv7();
      await tx.insert(role).values({ id, key: 'delegated_admin', nameAr: 'مدير مفوض', nameEn: 'Delegated admin' });
      await tx.insert(rolePermission).values([{ roleId: id, permissionKey: 'access.role.manage' }, { roleId: id, permissionKey: 'access.role.view' }]);
      await tx.insert(roleAssignment).values({ id: uuidv7(), userId: (await tx.select().from(userAccount).where(eq(userAccount.username, 'time.a')))[0]!.id, roleId: id, scopeType: 'GROUP' });
    });
    const t = await env.login('time.a');
    const roles = await t.get('/roles');
    const mine = roles.body.find((r: { key: string }) => r.key === 'delegated_admin');
    const r = await t.patch(`/roles/${mine.id}`, { permissions: ['access.role.manage', 'access.role.view', 'employee.financial.view'], version: mine.version ?? 1 });
    expect(r.status).toBe(403);
  });

  it('login: parallel wrong passwords cannot get around the lockout', async () => {
    await Promise.all(Array.from({ length: 8 }, () => env.anon().post(`${API}/auth/login`).send({ username: 'finance.a', password: 'wrong-password-1' })));
    const ok = await env.anon().post(`${API}/auth/login`).send({ username: 'finance.a', password: TEST_PASSWORD });
    expect(ok.status).toBe(423);
  });

  it('audit: personal amounts are masked without the financial permission', async () => {
    const period = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
    const hr = s['hr.a']!;
    // HR adjusts a leave balance (no amounts) and a salary-related payroll item is audited by finance.
    const run = await s['finance.a']!.post('/payroll/runs', { companyId: A, period });
    expect(run.status, run.text).toBe(201);
    await s['finance.a']!.post(`/payroll/runs/${run.body.id}/employees/${emp}/items`, { kind: 'earning', label: 'Bonus', amount: 777 });
    const audit = await s['admin']!.get('/audit-events?action=payroll.manual_item_added');
    const item = audit.body.items[0];
    expect(item.after.amount).toBe('•••');
    // Only the data fields: the hash and timestamp of the record may contain "777" by chance.
    expect(JSON.stringify({ before: item.before, after: item.after, details: item.details })).not.toMatch(/\b777\b/);
    expect(hr).toBeTruthy();
  });

  it('contracts: a signed copy needs a company signer and a version sent for signature', async () => {
    const lookups = await s['admin']!.get('/lookups');
    const fixed = lookups.body.find((l: { kind: string; code: string }) => l.kind === 'contract_type' && l.code === 'fixed_term');
    const tpl = await s['admin']!.post('/contracts/templates', { companyId: null, contractTypeId: fixed.id, code: 'SIMPLE', name: 'Simple', language: 'en', body: 'Contract {{contract.number}} for {{employee.nameEn}}.' });
    const c = await s['hr.a']!.post('/contracts', { employeeId: emp, templateId: tpl.body.id, startDate: today, endDate: addDays(today, 365), probationEnd: null });
    expect(c.status, c.text).toBe(201);
    const v = c.body.versions[0].id;
    const upload = (who: string) => s[who]!.agent.post(`${API}/contracts/${c.body.id}/versions/${v}/signed-copy`).set('x-csrf-token', s[who]!.csrf).attach('file', PDF, 'signed.pdf');
    expect((await upload('hr.a')).status).toBe(409); // a draft must be sent for signature first
    expect((await upload('manager.a')).status).toBe(403); // a signer without the right to manage contracts
    await s['hr.a']!.post(`/contracts/${c.body.id}/versions/${v}/send`);
    expect((await upload('hr.a')).status).toBe(201);
  });

  it('push: only the browsers’ push services are accepted', async () => {
    const keys = { p256dh: 'BOr7cS7z0n7Jm0h4w2b6x9VQnq2uZb2y9mXb5G0rZ1o', auth: 'k2Gx1pLmQ8q3R9s0' };
    expect((await s['employee.a']!.post('/notifications/push/subscribe', { endpoint: 'https://10.0.0.5:8443/admin', keys })).status).toBe(400);
    expect((await s['employee.a']!.post('/notifications/push/subscribe', { endpoint: 'https://internal.example.com/x', keys })).status).toBe(400);
  });

  it('single records need a scope check, not only the row policy', async () => {
    const types = await s['employee.a']!.get('/leave/types');
    const unpaid = types.body.find((t: { code: string }) => t.code === 'UNPAID');
    const req = await s['employee.a']!.post('/leave/requests', { leaveTypeId: unpaid.id, startDate: addDays(today, 40), endDate: addDays(today, 40), reason: 'Private' });
    expect(req.status, req.text).toBe(201);
    expect((await s['finance.a']!.get(`/leave/requests/${req.body.id}`)).status).toBe(404);
    expect((await s['hr.a']!.get(`/leave/requests/${req.body.id}`)).status).toBe(200);
    expect((await s['sales.manager']!.get(`/leave/requests/${req.body.id}`)).status).toBe(200); // direct manager and same department
  });

  it('candidate identity files need the restricted permission', async () => {
    const cats = (await s['hr.a']!.get('/document-categories')).body as { id: string; code: string }[];
    const identity = cats.find((x) => x.code === 'identity')!.id;
    const cand = await s['hr.a']!.post('/recruitment/candidates', { companyId: A, fullNameAr: 'هالة', fullNameEn: 'Hala', source: 'direct' });
    const up = await s['hr.a']!.agent.post(`${API}/recruitment/candidates/${cand.body.id}/files`).set('x-csrf-token', s['hr.a']!.csrf).field('categoryId', identity).field('title', 'Passport').attach('file', PDF, 'passport.pdf');
    expect(up.status, up.text).toBe(201);
    expect((await s['hr.a']!.get(`/recruitment/candidates/${cand.body.id}/files/${up.body.id}`)).status).toBe(200);
    expect((await s['manager.a']!.get(`/recruitment/candidates/${cand.body.id}/files/${up.body.id}`)).status).toBe(404);
  });

  it('dashboards respect department scope', async () => {
    await s['admin']!.put('/settings/dashboard.layouts', { value: { roles: { department_manager: [{ widget: 'headcount', size: 'small' }] } } });
    const w = await s['sales.manager']!.get('/dashboard');
    const head = w.body.find((x: { widget: string }) => x.widget === 'headcount');
    expect(head.data.companies[0].count).toBe(2); // SALES only, not the whole company (3)
  });
});
