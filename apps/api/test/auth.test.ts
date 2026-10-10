import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { API, TEST_PASSWORD, setup, type TestEnv } from './helpers.js';
import { session as sessionTable, userAccount } from '../src/db/schema.js';
import { AuthService } from '../src/auth/auth.service.js';

describe('authentication & sessions (AUTH-01, AUTH-06, AUTH-07)', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup();
  });
  afterAll(async () => env.close());
  beforeEach(() => {
    env.app.get(AuthService).ipLimiter.reset();
    env.app.get(AuthService).userLimiter.reset();
  });

  const resetUser = (username: string) =>
    env.database.system((tx) =>
      tx.update(userAccount).set({ failedLoginCount: 0, lockedUntil: null }).where(eq(userAccount.username, username)),
    );

  it('logs in and sets a hardened session cookie', async () => {
    const res = await env.anon().post(`${API}/auth/login`).send({ username: 'hr.a', password: TEST_PASSWORD });
    expect(res.status).toBe(204);
    const cookie = res.headers['set-cookie']?.[0] ?? '';
    expect(cookie).toMatch(/^hrms_sid=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
  });

  it('rejects wrong password and unknown user with the same generic error', async () => {
    const a = await env.anon().post(`${API}/auth/login`).send({ username: 'hr.a', password: 'wrong-password-123' });
    const b = await env.anon().post(`${API}/auth/login`).send({ username: 'nobody', password: 'wrong-password-123' });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.code).toBe('AUTH_INVALID_CREDENTIALS');
    expect(b.body.code).toBe('AUTH_INVALID_CREDENTIALS');
    expect(a.headers['content-type']).toMatch(/application\/problem\+json/);
    await resetUser('hr.a');
  });

  it('locks the account after the configured number of failures (even with the right password)', async () => {
    for (let i = 0; i < 4; i++) {
      const r = await env.anon().post(`${API}/auth/login`).send({ username: 'hr.b', password: 'bad-password-xyz' });
      expect(r.status).toBe(401);
    }
    const fifth = await env.anon().post(`${API}/auth/login`).send({ username: 'hr.b', password: 'bad-password-xyz' });
    expect(fifth.status).toBe(423);
    const correct = await env.anon().post(`${API}/auth/login`).send({ username: 'hr.b', password: TEST_PASSWORD });
    expect(correct.status).toBe(423);
    expect(correct.body.code).toBe('AUTH_LOCKED');
    await resetUser('hr.b');
  });

  it('rejects requests without a session (401) and unsafe requests without CSRF (403)', async () => {
    const noSession = await env.anon().get(`${API}/companies`);
    expect(noSession.status).toBe(401);
    const s = await env.login('admin');
    const noCsrf = await s.agent.post(`${API}/companies`).send({ code: 'X1', nameAr: 'س', nameEn: 'X' });
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.code).toBe('CSRF_INVALID');
    const badCsrf = await s.agent
      .post(`${API}/companies`)
      .set('x-csrf-token', 'forged')
      .send({ code: 'X1', nameAr: 'س', nameEn: 'X' });
    expect(badCsrf.body.code).toBe('CSRF_INVALID');
  });

  it('logout revokes the session server-side', async () => {
    const s = await env.login('manager.a');
    expect((await s.post('/auth/logout')).status).toBe(204);
    expect((await s.get('/companies')).status).toBe(401);
  });

  it('expires idle sessions and sessions past their absolute lifetime', async () => {
    const s1 = await env.login('finance.a');
    await env.database.system((tx) =>
      tx.execute(sql`update session set last_seen_at = now() - interval '2 hours'
                     where user_id = (select id from user_account where username = 'finance.a')`),
    );
    expect((await s1.get('/companies')).status).toBe(401);

    const s2 = await env.login('finance.a');
    await env.database.system((tx) =>
      tx.execute(sql`update session set expires_at = now() - interval '1 second'
                     where user_id = (select id from user_account where username = 'finance.a') and revoked_at is null`),
    );
    expect((await s2.get('/companies')).status).toBe(401);
  });

  it('disabled users cannot log in and their sessions end', async () => {
    const admin = await env.login('admin');
    const victim = await env.login('time.a');
    const id = env.seeded.users['time.a']!;
    const r = await admin.post(`/users/${id}/status`, { status: 'disabled', reason: 'test' });
    expect(r.status).toBe(201);
    expect((await victim.get('/auth/session')).status).toBe(401);
    const login = await env.anon().post(`${API}/auth/login`).send({ username: 'time.a', password: TEST_PASSWORD });
    expect(login.status).toBe(403);
    expect(login.body.code).toBe('AUTH_DISABLED');
    await admin.post(`/users/${id}/status`, { status: 'active', reason: 'restore' });
  });

  it('forces a password change for new accounts and enforces the password policy', async () => {
    const admin = await env.login('admin');
    const create = await admin.post('/users', {
      username: 'new.user',
      displayName: 'New User',
      temporaryPassword: 'Temporary-Pass-001',
    });
    expect(create.status).toBe(201);

    const s = await env.login('new.user', 'Temporary-Pass-001');
    const info = await s.get('/auth/session');
    expect(info.body.state).toBe('password_change_required');
    expect((await s.get('/companies')).status).toBe(403);

    const weak = await s.post('/auth/password/change', { currentPassword: 'Temporary-Pass-001', newPassword: 'short' });
    expect(weak.status).toBe(400);
    expect(weak.body.code).toBe('PASSWORD_POLICY');
    const common = await s.post('/auth/password/change', { currentPassword: 'Temporary-Pass-001', newPassword: 'password1234' });
    expect(common.body.meta.reasons).toContain('too_common');

    const ok = await s.post('/auth/password/change', {
      currentPassword: 'Temporary-Pass-001',
      newPassword: 'A-much-better-passphrase-77',
    });
    expect(ok.status).toBe(204);
    expect((await s.get('/auth/session')).body.state).toBe('active');
  });

  it('changing the password ends the user\'s other sessions', async () => {
    const other = await env.login('employee.a');
    const current = await env.login('employee.a');
    const r = await current.post('/auth/password/change', {
      currentPassword: TEST_PASSWORD,
      newPassword: 'Another-strong-passphrase-42',
    });
    expect(r.status).toBe(204);
    expect((await other.get('/auth/session')).status).toBe(401);
    expect((await current.get('/auth/session')).status).toBe(200);
  });

  it('lists own sessions and can revoke one remotely', async () => {
    const a = await env.login('senior');
    const b = await env.login('senior');
    const list = await a.get('/auth/sessions');
    expect(list.status).toBe(200);
    const other = (list.body as { id: string; current: boolean }[]).find((x) => !x.current)!;
    expect(other).toBeTruthy();
    expect((await a.del(`/auth/sessions/${other.id}`)).status).toBe(204);
    expect((await b.get('/auth/session')).status).toBe(401);
  });

  it('stores only a hash of the session token', async () => {
    const rows = await env.database.system((tx) => tx.select().from(sessionTable).limit(5));
    for (const r of rows) expect(r.tokenHash.length).toBe(32);
  });
});
