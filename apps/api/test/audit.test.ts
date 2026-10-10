import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asAppRole, setup, type Session, type TestEnv } from './helpers.js';
import { redact } from '../src/audit/audit.service.js';

describe('audit trail (AUD-01..04)', () => {
  let env: TestEnv;
  let admin: Session;
  let A: string;

  beforeAll(async () => {
    env = await setup();
    admin = await env.login('admin');
    A = env.seeded.companies['DEMO-A']!;
  });
  afterAll(async () => env.close());

  it('records who changed what, with before and after values', async () => {
    const list = await admin.get(`/companies/${A}`);
    const r = await admin.patch(`/companies/${A}`, { nameEn: 'Renamed Trading', version: list.body.version });
    expect(r.status).toBe(200);
    const events = await admin.get('/audit-events?action=org.company.updated');
    const e = events.body.items[0];
    expect(e.actorUsername).toBe('admin');
    expect(e.companyId).toBe(A);
    expect(e.before.nameEn).toBe('Al Nokhba Trading');
    expect(e.after.nameEn).toBe('Renamed Trading');
    expect(e.ip).toBeTruthy();
  });

  it('records failed logins and access denials', async () => {
    await env.anon().post('/api/v1/auth/login').send({ username: 'hr.a', password: 'wrong-password-1' });
    const hr = await env.login('hr.a');
    await hr.post('/companies', { code: 'NO', nameAr: 'لا', nameEn: 'No' });
    const failures = await admin.get('/audit-events?action=auth.login&outcome=failure');
    expect(failures.body.items.length).toBeGreaterThan(0);
    const denied = await admin.get('/audit-events?action=access.denied');
    expect(denied.body.items[0].details.permission).toBe('org.company.create');
  });

  it('viewing the audit log is itself audited (AUD-03)', async () => {
    await admin.get('/audit-events?limit=1');
    const r = await admin.get('/audit-events?action=audit.viewed&limit=5');
    expect(r.body.items.length).toBeGreaterThan(0);
  });

  it('never stores secrets', async () => {
    expect(redact({ password: 'x', newPassword: 'y', totpSecretEnc: 'z', name: 'ok' })).toEqual({
      password: '[redacted]',
      newPassword: '[redacted]',
      totpSecretEnc: '[redacted]',
      name: 'ok',
    });
    const rows = await env.database.owner.query<{ c: number }>(
      `select count(*)::int as c from audit_event
       where coalesce(before::text,'') || coalesce(after::text,'') || coalesce(details::text,'') ~* 'Correct-Horse'`,
    );
    expect(rows[0]!.c).toBe(0);
  });

  it('is append-only for the runtime role (UPDATE, DELETE, TRUNCATE all fail)', async () => {
    for (const stmt of ['update audit_event set action = $1', 'delete from audit_event', 'truncate audit_event']) {
      await expect(
        asAppRole(env.database, { group: true, companyIds: [] }, (q) =>
          q(stmt, stmt.includes('$1') ? ['tampered'] : []),
        ),
      ).rejects.toThrow();
    }
  });

  it('is append-only even for the owner (trigger), short of disabling triggers', async () => {
    await expect(env.database.owner.exec(`update audit_event set action = 'x'`)).rejects.toThrow(/append-only/);
  });

  it('hash chain verifies, and detects tampering', async () => {
    const ok = await admin.post('/audit-events/verify');
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);
    expect(ok.body.checked).toBeGreaterThan(10);

    // Simulate an attacker with owner access who disables the trigger and edits history.
    await env.database.owner.session(async (db) => {
      await db.exec('alter table audit_event disable trigger audit_event_no_update');
      await db.exec(`update audit_event set details = '{"forged":true}' where id = (select min(id) + 3 from audit_event)`);
      await db.exec('alter table audit_event enable trigger audit_event_no_update');
    });
    const bad = await admin.post('/audit-events/verify');
    expect(bad.body.ok).toBe(false);
    expect(bad.body.firstBadId).toBeGreaterThan(0);
  });

  it('company-scoped audit viewers only see their companies\' events', async () => {
    const roles = await admin.get('/roles');
    const role = await admin.post('/roles', {
      key: 'company_auditor',
      nameAr: 'مدقق',
      nameEn: 'Company auditor',
      permissions: ['audit.view'],
    });
    expect(role.status).toBe(201);
    void roles;
    await admin.post(`/users/${env.seeded.users['hr.b']}/assignments`, {
      roleId: role.body.id,
      scopeType: 'COMPANY',
      companyId: env.seeded.companies['DEMO-B'],
    });
    const hrb = await env.login('hr.b');
    const r = await hrb.get('/audit-events?limit=200');
    expect(r.status).toBe(200);
    for (const e of r.body.items) {
      expect(e.companyId).toBe(env.seeded.companies['DEMO-B']);
      expect(e.action.startsWith('auth.')).toBe(false);
    }
  });
});
