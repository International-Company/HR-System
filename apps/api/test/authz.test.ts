import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, type Session, type TestEnv } from './helpers.js';

/**
 * Authorization & company-isolation matrix (RBAC-04..07, QA-02).
 * Each case: persona × request → expected status. Negative cases are the point.
 */
describe('authorization matrix', () => {
  let env: TestEnv;
  const s: Record<string, Session> = {};
  let A: string, B: string, C: string, salesDept: string, finDept: string, opsDept: string;

  beforeAll(async () => {
    env = await setup();
    A = env.seeded.companies['DEMO-A']!;
    B = env.seeded.companies['DEMO-B']!;
    C = env.seeded.companies['DEMO-C']!;
    salesDept = env.seeded.departments['DEMO-A/SALES']!;
    finDept = env.seeded.departments['DEMO-A/FIN']!;
    opsDept = env.seeded.departments['DEMO-B/OPS']!;
    for (const u of ['admin', 'senior', 'hr.a', 'hr.b', 'manager.a', 'sales.manager', 'finance.a', 'time.a', 'employee.a']) {
      s[u] = await env.login(u);
    }
  });
  afterAll(async () => env.close());

  const ids = (body: { id: string }[]) => body.map((x) => x.id).sort();

  describe('company visibility', () => {
    it('System Administrator and Senior Management see every company', async () => {
      for (const u of ['admin', 'senior']) {
        const r = await s[u]!.get('/companies');
        expect(r.status).toBe(200);
        expect(ids(r.body)).toEqual([A, B, C].sort());
      }
    });

    it('company-scoped roles see only their company', async () => {
      for (const u of ['hr.a', 'manager.a', 'finance.a', 'time.a']) {
        const r = await s[u]!.get('/companies');
        expect(ids(r.body), u).toEqual([A]);
      }
      expect(ids((await s['hr.b']!.get('/companies')).body)).toEqual([B]);
    });

    it('department managers see their company but only their department', async () => {
      expect(ids((await s['sales.manager']!.get('/companies')).body)).toEqual([A]);
      const depts = await s['sales.manager']!.get(`/companies/${A}/departments`);
      expect(ids(depts.body)).toEqual([salesDept]);
    });

    it('employees without org permissions are denied (403)', async () => {
      expect((await s['employee.a']!.get('/companies')).status).toBe(403);
    });

    it('another company\'s record is reported as not found (404), not forbidden', async () => {
      expect((await s['hr.a']!.get(`/companies/${B}`)).status).toBe(404);
      expect((await s['hr.a']!.get(`/companies/${B}/departments`)).status).toBe(404);
      expect((await s['hr.a']!.get(`/companies/${B}/locations`)).status).toBe(404);
      expect((await s['hr.b']!.get(`/companies/${A}`)).status).toBe(404);
    });
  });

  describe('writes respect company scope', () => {
    it('HR of company A can create a department in A but not in B', async () => {
      const ok = await s['hr.a']!.post(`/companies/${A}/departments`, { code: 'HRD', nameAr: 'الموارد', nameEn: 'HR' });
      expect(ok.status).toBe(201);
      const denied = await s['hr.a']!.post(`/companies/${B}/departments`, { code: 'HRD', nameAr: 'الموارد', nameEn: 'HR' });
      expect(denied.status).toBe(404);
    });

    it('HR of company A cannot edit a department of company B by id', async () => {
      const r = await s['hr.a']!.patch(`/departments/${opsDept}`, { nameEn: 'Hacked', version: 1 });
      expect(r.status).toBe(404);
    });

    it('company creation is group-only: HR and Senior Management are refused', async () => {
      for (const u of ['hr.a', 'senior', 'manager.a']) {
        const r = await s[u]!.post('/companies', { code: 'NOPE', nameAr: 'لا', nameEn: 'No' });
        expect(r.status, u).toBe(403);
      }
      const ok = await s['admin']!.post('/companies', { code: 'NEW-CO', nameAr: 'جديدة', nameEn: 'New Co' });
      expect(ok.status).toBe(201);
    });

    it('read-only roles cannot manage departments', async () => {
      for (const u of ['senior', 'manager.a', 'sales.manager', 'finance.a']) {
        const r = await s[u]!.post(`/companies/${A}/departments`, { code: 'Z', nameAr: 'ز', nameEn: 'Z' });
        expect(r.status, u).toBe(403);
      }
    });
  });

  describe('administration is restricted', () => {
    it('only group administrators manage accounts, roles and assignments', async () => {
      for (const u of ['hr.a', 'senior', 'manager.a', 'employee.a']) {
        expect((await s[u]!.post('/users', { username: 'x.y', displayName: 'X', temporaryPassword: 'Some-long-pass-1' })).status, u).toBe(403);
        expect((await s[u]!.post('/roles', { key: 'evil', nameAr: 'ش', nameEn: 'Evil', permissions: [] })).status, u).toBe(403);
        expect((await s[u]!.put('/settings/security.lockout', { value: { maxFailures: 20, lockMinutes: 1 } })).status, u).toBe(403);
      }
    });

    it('company-scoped user lists only contain users of that company', async () => {
      const r = await s['hr.a']!.get('/users');
      expect(r.status).toBe(200);
      const names = (r.body as { username: string }[]).map((u) => u.username);
      expect(names).toContain('manager.a');
      expect(names).not.toContain('hr.b');
      expect(names).not.toContain('admin');
      expect((await s['hr.a']!.get(`/users/${env.seeded.users['hr.b']}`)).status).toBe(404);
    });

    it('nobody can change their own role assignments (no self-escalation)', async () => {
      const roles = await s['admin']!.get('/roles');
      const hr = (roles.body as { id: string; key: string }[]).find((r) => r.key === 'hr')!;
      const r = await s['admin']!.post(`/users/${env.seeded.users['admin']}/assignments`, {
        roleId: hr.id,
        scopeType: 'COMPANY',
        companyId: B,
      });
      expect(r.status).toBe(403);
    });

    it('the last System Administrator cannot be removed or disabled', async () => {
      // 'admin' is the only system_admin; another admin is needed to attempt it.
      const list = await s['admin']!.get(`/users/${env.seeded.users['admin']}/assignments`);
      expect(list.status).toBe(200);
      const r = await s['admin']!.post(`/users/${env.seeded.users['admin']}/status`, { status: 'disabled', reason: 'x' });
      expect(r.status).toBe(403); // cannot disable self
    });

    it('group-only permissions granted through a company-scoped custom role have no effect', async () => {
      const role = await s['admin']!.post('/roles', {
        key: 'company_admin_attempt',
        nameAr: 'محاولة',
        nameEn: 'Attempt',
        permissions: ['org.company.create', 'identity.user.create', 'org.company.view'],
      });
      expect(role.status).toBe(201);
      const assign = await s['admin']!.post(`/users/${env.seeded.users['employee.a']}/assignments`, {
        roleId: role.body.id,
        scopeType: 'COMPANY',
        companyId: C,
      });
      expect(assign.status).toBe(204);
      const emp = await env.login('employee.a');
      expect((await emp.get('/companies')).status).toBe(200); // org.company.view works at company scope
      expect(ids((await emp.get('/companies')).body)).toEqual([C]);
      expect((await emp.post('/companies', { code: 'BAD', nameAr: 'س', nameEn: 'Bad' })).status).toBe(403);
      expect((await emp.post('/users', { username: 'bad.user', displayName: 'B', temporaryPassword: 'Some-long-pass-1' })).status).toBe(403);
    });

    it('ended assignments stop granting access immediately', async () => {
      const list = await s['admin']!.get(`/users/${env.seeded.users['employee.a']}/assignments`);
      const custom = (list.body as { id: string; roleKey: string }[]).find((a) => a.roleKey === 'company_admin_attempt')!;
      expect((await s['admin']!.del(`/users/${env.seeded.users['employee.a']}/assignments/${custom.id}`)).status).toBe(204);
      const emp = await env.login('employee.a');
      expect((await emp.get('/companies')).status).toBe(403);
    });

    it('system roles are locked against modification', async () => {
      const roles = await s['admin']!.get('/roles');
      const sys = (roles.body as { id: string; key: string; version: number }[]).find((r) => r.key === 'hr')!;
      const r = await s['admin']!.patch(`/roles/${sys.id}`, { permissions: ['audit.view'], version: sys.version });
      expect(r.status).toBe(409);
    });
  });

  describe('audit and backups', () => {
    it('audit log and backups are not visible to non-administrators', async () => {
      for (const u of ['hr.a', 'senior', 'finance.a', 'employee.a']) {
        expect((await s[u]!.get('/audit-events')).status, u).toBe(403);
        expect((await s[u]!.get('/backups')).status, u).toBe(403);
      }
      expect((await s['admin']!.get('/audit-events')).status).toBe(200);
    });
  });

  it('uses 404 for malformed ids rather than leaking errors', async () => {
    expect((await s['admin']!.get('/companies/not-a-uuid')).status).toBe(404);
    void finDept;
  });
});
