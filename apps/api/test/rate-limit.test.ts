import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { API, TEST_PASSWORD, setup, type TestEnv } from './helpers.js';
import { RateLimiter, pruneRateLimits } from '../src/common/rate-limit.js';
import { AuthService } from '../src/auth/auth.service.js';

/** Residual risks R2 and R3 of the Phase 12 review: shared rate limits and in-session secret checks. */
describe('shared rate limits and in-session lockout', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup();
  });
  afterAll(async () => env.close());

  const rows = async () =>
    ((await env.database.system((tx) => tx.execute(sql`select key, hits, reset_at from rate_limit`))) as unknown as { rows: { key: Buffer; hits: number }[] }).rows;

  it('two processes share one limit, and only hashed keys are stored', async () => {
    const a = new RateLimiter(env.database, 'secret-0123456789-0123456789-0123', 'test', 3, 60_000);
    const b = new RateLimiter(env.database, 'secret-0123456789-0123456789-0123', 'test', 3, 60_000);
    expect(await a.hit('203.0.113.7')).toBe(true);
    expect(await b.hit('203.0.113.7')).toBe(true);
    expect(await a.hit('203.0.113.7')).toBe(true);
    expect(await b.hit('203.0.113.7')).toBe(false);
    expect(await b.hit('203.0.113.8')).toBe(true);
    expect(JSON.stringify(await rows())).not.toContain('203.0.113');
    // A new window starts once the old one has expired, and expired windows are pruned.
    await env.database.system((tx) => tx.execute(sql`update rate_limit set reset_at = now() - interval '1 second'`));
    expect(await a.hit('203.0.113.7')).toBe(true);
    await env.database.system((tx) => tx.execute(sql`update rate_limit set reset_at = now() - interval '1 second'`));
    await pruneRateLimits(env.database);
    expect(await rows()).toHaveLength(0);
  });

  it('login attempts for one username are limited (429)', async () => {
    const auth = env.app.get(AuthService);
    await auth.ipLimiter.reset();
    await auth.userLimiter.reset();
    const statuses: number[] = [];
    for (let i = 0; i < 16; i++) {
      statuses.push((await env.anon().post(`${API}/auth/login`).send({ username: 'nobody.here', password: 'wrong-password-1' })).status);
    }
    expect(statuses.slice(0, 15).every((s) => s === 401)).toBe(true);
    expect(statuses[15]).toBe(429);
  });

  it('wrong current passwords in a session lock the account and end its sessions', async () => {
    const s = await env.login('finance.a');
    const other = await env.login('finance.a');
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      statuses.push((await s.post('/auth/password/change', { currentPassword: `wrong-password-${i}`, newPassword: 'Another-strong-passphrase-42' })).status);
    }
    expect(statuses.slice(0, 4)).toEqual([400, 400, 400, 400]);
    expect(statuses[4]).toBe(401);
    expect((await other.get('/auth/session')).status).toBe(401);
    await env.app.get(AuthService).userLimiter.reset();
    expect((await env.anon().post(`${API}/auth/login`).send({ username: 'finance.a', password: TEST_PASSWORD })).status).toBe(423);
  });
});
