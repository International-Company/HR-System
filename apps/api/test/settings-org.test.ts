import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, type Session, type TestEnv } from './helpers.js';
import { ModulesService } from '../src/settings/modules.service.js';

describe('settings, modules and organisation', () => {
  let env: TestEnv;
  let admin: Session;
  let A: string, B: string;

  beforeAll(async () => {
    env = await setup();
    admin = await env.login('admin');
    A = env.seeded.companies['DEMO-A']!;
    B = env.seeded.companies['DEMO-B']!;
  });
  afterAll(async () => env.close());

  describe('settings (SET-01, SET-02, ORG-06, I18N-01..03)', () => {
    it('public settings expose only language/format data', async () => {
      const r = await env.anon().get('/api/v1/settings/public');
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ language: 'ar', timezone: 'UTC', dateFormat: 'DD/MM/YYYY' });
      expect(JSON.stringify(r.body)).not.toMatch(/password|lockout|mfa/i);
    });

    it('validates values against the typed schema', async () => {
      expect((await admin.put('/settings/general.language', { value: 'fr' })).status).toBe(400);
      expect((await admin.put('/settings/general.timezone', { value: 'Mars/Olympus' })).status).toBe(400);
      expect((await admin.put('/settings/security.passwordPolicy', { value: { minLength: 6 } })).status).toBe(400);
      expect((await admin.put('/settings/unknown.key', { value: 1 })).status).toBe(404);
      expect((await admin.put('/settings/general.timezone', { value: 'Europe/Berlin' })).status).toBe(204);
      expect((await admin.put('/settings/general.language', { value: 'en' })).status).toBe(204);
      const pub = await env.anon().get('/api/v1/settings/public');
      expect(pub.body.language).toBe('en');
      expect(pub.body.timezone).toBe('Europe/Berlin');
    });

    it('supports company overrides only where allowed', async () => {
      expect((await admin.put('/settings/general.language', { value: 'ar', companyId: A })).status).toBe(400);
      expect((await admin.put('/settings/general.defaultCurrency', { value: 'USD', companyId: A })).status).toBe(204);
      const forA = await admin.get(`/settings?companyId=${A}`);
      const forB = await admin.get(`/settings?companyId=${B}`);
      const cur = (b: { key: string; value: unknown }[]) => b.find((x) => x.key === 'general.defaultCurrency')!.value;
      expect(cur(forA.body)).toBe('USD');
      expect(cur(forB.body)).toBe('EUR');
      expect((await admin.del(`/settings/general.defaultCurrency?companyId=${A}`)).status).toBe(204);
      expect(cur((await admin.get(`/settings?companyId=${A}`)).body)).toBe('EUR');
    });

    it('applies security policy changes (lockout threshold)', async () => {
      expect((await admin.put('/settings/security.lockout', { value: { maxFailures: 3, lockMinutes: 5 } })).status).toBe(204);
      for (let i = 0; i < 2; i++) {
        expect((await env.anon().post('/api/v1/auth/login').send({ username: 'manager.a', password: 'nope-nope-nope' })).status).toBe(401);
      }
      const third = await env.anon().post('/api/v1/auth/login').send({ username: 'manager.a', password: 'nope-nope-nope' });
      expect(third.status).toBe(423);
    });
  });

  describe('modules (ORG-07, ORG-08)', () => {
    it('can be disabled per group and per company without deleting anything', async () => {
      const modules = env.app.get(ModulesService);
      expect(await modules.access('payroll', A)).toBe('enabled');
      expect((await admin.put(`/modules/payroll/companies/${A}`, { enabled: false })).status).toBe(204);
      expect(await modules.access('payroll', A)).toBe('read_only');
      expect(await modules.access('payroll', B)).toBe('enabled');
      expect((await admin.patch('/modules/payroll', { groupEnabled: false, disablePolicy: 'hidden' })).status).toBe(204);
      expect(await modules.access('payroll', B)).toBe('hidden');
      const list = await admin.get('/modules');
      const payroll = (list.body as { key: string; groupEnabled: boolean; companies: unknown[] }[]).find((m) => m.key === 'payroll')!;
      expect(payroll.groupEnabled).toBe(false);
      expect(payroll.companies).toHaveLength(1);
      expect((await admin.patch('/modules/unknown', { groupEnabled: false })).status).toBe(404);
    });
  });

  describe('organisation (ORG-01, ORG-09, ORG-10)', () => {
    it('creates departments and locations; codes are unique per company only', async () => {
      const d1 = await admin.post(`/companies/${A}/departments`, { code: 'IT', nameAr: 'تقنية', nameEn: 'IT' });
      const d2 = await admin.post(`/companies/${B}/departments`, { code: 'IT', nameAr: 'تقنية', nameEn: 'IT' });
      expect(d1.status).toBe(201);
      expect(d2.status).toBe(201);
      const dup = await admin.post(`/companies/${A}/departments`, { code: 'it', nameAr: 'تقنية', nameEn: 'IT' });
      expect(dup.status).toBe(409);
      const loc = await admin.post(`/companies/${A}/locations`, { code: 'WH1', nameAr: 'مستودع', nameEn: 'Warehouse', address: 'Zone 1' });
      expect(loc.status).toBe(201);
    });

    it('a parent department must belong to the same company and cycles are rejected', async () => {
      const salesA = env.seeded.departments['DEMO-A/SALES']!;
      const opsB = env.seeded.departments['DEMO-B/OPS']!;
      const cross = await admin.post(`/companies/${B}/departments`, { code: 'SUB', nameAr: 'فرعي', nameEn: 'Sub', parentId: salesA });
      expect(cross.status).toBe(400);
      const child = await admin.post(`/companies/${A}/departments`, { code: 'SUB', nameAr: 'فرعي', nameEn: 'Sub', parentId: salesA });
      expect(child.status).toBe(201);
      const depts = await admin.get(`/companies/${A}/departments`);
      const sales = (depts.body as { id: string; version: number }[]).find((d) => d.id === salesA)!;
      const cycle = await admin.patch(`/departments/${salesA}`, { parentId: child.body.id, version: sales.version });
      expect(cycle.status).toBe(400);
      void opsB;
    });

    it('rejects stale updates (optimistic concurrency)', async () => {
      const c = await admin.get(`/companies/${B}`);
      expect((await admin.patch(`/companies/${B}`, { nameEn: 'One', version: c.body.version })).status).toBe(200);
      const stale = await admin.patch(`/companies/${B}`, { nameEn: 'Two', version: c.body.version });
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe('VERSION_CONFLICT');
    });

    it('companies are deactivated, never deleted', async () => {
      const c = await admin.get(`/companies/${B}`);
      const r = await admin.patch(`/companies/${B}`, { status: 'inactive', version: c.body.version });
      expect(r.body.status).toBe('inactive');
      expect((await admin.get('/companies')).body.length).toBeGreaterThanOrEqual(3);
    });

    it('validates input and returns field errors', async () => {
      const r = await admin.post('/companies', { code: 'bad code!', nameAr: '', nameEn: 'X' });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('VALIDATION_FAILED');
      expect(r.body.errors.map((e: { path: string }) => e.path)).toEqual(expect.arrayContaining(['code', 'nameAr']));
    });
  });

  describe('health', () => {
    it('reports readiness without secrets', async () => {
      const r = await env.anon().get('/api/v1/health/ready');
      expect(r.status).toBe(200);
      expect(r.body.checks).toEqual({ database: 'ok', migrations: 'ok' });
    });
    it('sets security headers', async () => {
      const r = await env.anon().get('/api/v1/health/live');
      expect(r.headers['content-security-policy']).toMatch(/default-src 'self'/);
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['permissions-policy']).toMatch(/geolocation=\(\)/);
      expect(r.headers['x-powered-by']).toBeUndefined();
    });
  });
});
