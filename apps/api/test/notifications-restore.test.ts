import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { eq } from 'drizzle-orm';
import { API, grant, setup, type Session, type TestEnv } from './helpers.js';
import { DisabledMailer, NotificationsService, type PushSender } from '../src/notifications/notifications.service.js';
import { BackupService } from '../src/backup/backup.service.js';
import { RestoreService } from '../src/backup/restore.service.js';
import { LocalDirStorage } from '../src/backup/storage.js';
import { backupRun, company } from '../src/db/schema.js';
import { currentStep, totpAt } from '../src/auth/totp.js';
import { uuidv7 } from '../src/common/ids.js';

class FakePush implements PushSender {
  sent: { endpoint: string; payload: string }[] = [];
  gone = new Set<string>();
  async send(sub: { endpoint: string }, payload: string) {
    if (this.gone.has(sub.endpoint)) return 'gone' as const;
    this.sent.push({ endpoint: sub.endpoint, payload });
    return 'ok' as const;
  }
}

describe('notification centre and push (NOT-01..06)', () => {
  let env: TestEnv;
  let push: FakePush;
  const s: Record<string, Session> = {};

  beforeAll(async () => {
    push = new FakePush();
    env = await setup({ pushSender: push });
    for (const u of ['hr.a', 'employee.a']) s[u] = await env.login(u);
    await env.database.system((tx) =>
      env.app.get(NotificationsService).notify(tx, {
        userIds: [env.seeded.users['hr.a']!],
        eventType: 'test.event',
        title: { ar: 'تنبيه', en: 'Notice' },
        link: '/employees',
      }),
    );
  });
  afterAll(async () => env.close());

  it('is personal: list, unread count, mark read', async () => {
    const list = await s['hr.a']!.get('/notifications');
    expect(list.body).toHaveLength(1);
    expect(list.body[0].title.ar).toBe('تنبيه');
    expect((await s['hr.a']!.get('/notifications/unread-count')).body.count).toBe(1);
    expect((await s['employee.a']!.get('/notifications')).body).toHaveLength(0);
    // Another user cannot mark it read.
    expect((await s['employee.a']!.post('/notifications/read', { ids: [list.body[0].id] })).body.updated).toBe(0);
    expect((await s['hr.a']!.post('/notifications/read', { all: true })).body.updated).toBe(1);
    expect((await s['hr.a']!.get('/notifications/unread-count')).body.count).toBe(0);
  });

  it('delivers push with stored VAPID keys and drops expired subscriptions', async () => {
    const key = await s['employee.a']!.get('/notifications/push/public-key');
    expect(key.body.publicKey).toMatch(/^[A-Za-z0-9_-]{80,}$/);
    const raw = await env.database.owner.query<{ v: string }>(`select encode(value_enc, 'escape') as v from system_secret where key = 'vapid'`);
    expect(raw[0]!.v).not.toContain(key.body.publicKey);

    const endpoint = 'https://push.example.test/abc';
    expect((await s['employee.a']!.post('/notifications/push/subscribe', { endpoint, keys: { p256dh: 'BKey', auth: 'auth' } })).status).toBe(204);
    await env.database.system((tx) =>
      env.app.get(NotificationsService).notify(tx, { userIds: [env.seeded.users['employee.a']!], eventType: 'x', title: { ar: 'أ', en: 'A' } }),
    );
    expect(await env.app.get(NotificationsService).dispatchPush()).toBe(1);
    expect(JSON.parse(push.sent[0]!.payload).title.en).toBe('A');
    expect(await env.app.get(NotificationsService).dispatchPush()).toBe(0); // not sent twice

    push.gone.add(endpoint);
    await env.database.system((tx) =>
      env.app.get(NotificationsService).notify(tx, { userIds: [env.seeded.users['employee.a']!], eventType: 'x', title: { ar: 'ب', en: 'B' } }),
    );
    await env.app.get(NotificationsService).dispatchPush();
    const subs = await env.database.owner.query<{ revoked: boolean }>(`select revoked_at is not null as revoked from push_subscription`);
    expect(subs[0]!.revoked).toBe(true);
  });

  it('never sends e-mail in this release (NOT-05)', () => {
    expect(new DisabledMailer().enabled).toBe(false);
  });
});

describe('in-app restore: access and safeguards (BKP-06)', () => {
  let env: TestEnv;
  const s: Record<string, Session> = {};

  beforeAll(async () => {
    env = await setup();
    for (const u of ['admin', 'hr.a', 'senior']) s[u] = await env.login(u);
  });
  afterAll(async () => env.close());

  it('only the System Administrator role can restore; the permission cannot go into custom roles', async () => {
    for (const u of ['hr.a', 'senior']) expect((await s[u]!.get('/backups/restores')).status, u).toBe(403);
    const r = await s['admin']!.post('/roles', { key: 'restorer', nameAr: 'م', nameEn: 'R', permissions: ['system.backup.restore'] });
    expect(r.status).toBe(400);
  });

  it('previews the impact and the confirmation phrase', async () => {
    const id = uuidv7();
    await env.database.system((tx) =>
      tx.insert(backupRun).values({ id, kind: 'manual', status: 'succeeded', startedAt: new Date(Date.now() - 3_600_000), finishedAt: new Date(Date.now() - 3_500_000), schemaVersion: '0003', objectKey: 'x' }),
    );
    await s['admin']!.post('/companies', { code: 'AFTER', nameAr: 'بعد', nameEn: 'After' });
    const p = await s['admin']!.get(`/backups/${id}/restore-preview`);
    expect(p.status, p.text).toBe(200);
    expect(p.body.confirmationPhrase).toMatch(/^RESTORE \d{4}-\d{2}-\d{2}$/);
    expect(p.body.compatible).toBe(true);
    expect(p.body.changesSince.find((c: { module: string }) => c.module === 'org').count).toBeGreaterThan(0);
    expect(p.body.warnings).toContain('all_users_signed_out');
    expect(p.body.secondApproverRequired).toBe(false); // only one administrator
    await grant(env, 'senior', 'system_admin', 'GROUP');
    expect((await s['admin']!.get(`/backups/${id}/restore-preview`)).body.secondApproverRequired).toBe(true);
  });

  it('is refused where the server tools are not available (embedded database)', async () => {
    const list = await s['admin']!.get('/backups/restores');
    if (!process.env.TEST_DATABASE_URL) {
      expect(list.body.supported).toBe(false);
      const r = await s['admin']!.post('/backups/restores', { backupRunId: randomUUID(), password: 'x', code: '000000', confirmation: 'x' });
      expect(r.status).toBe(409);
    }
  });
});

const hasTools = (() => {
  try {
    execSync('pg_dump --version', { stdio: 'ignore' });
    execSync('pg_restore --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/** Full restore on a real PostgreSQL server (CI). */
describe.runIf(!!process.env.TEST_DATABASE_URL && hasTools)('in-app restore end to end (server)', () => {
  let env: TestEnv;
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hrms-restore-'));
    env = await setup({
      env: { BACKUP_ENCRYPTION_KEY: randomBytes(32).toString('base64'), BACKUP_LOCAL_DIR: dir },
      backupStorage: new LocalDirStorage(dir),
    });
  });
  afterAll(async () => {
    const live = new URL(env.config.DATABASE_URL!).pathname.slice(1);
    await env.close();
    const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await c.connect();
    const old = await c.query<{ datname: string }>(`select datname from pg_database where datname like $1`, [`${live}\\_pre\\_%`]);
    for (const r of old.rows) await c.query(`drop database if exists "${r.datname}" with (force)`);
    await c.end();
    await rm(dir, { recursive: true, force: true });
  });

  it('restores a backup, keeps audit history, signs everyone out', async () => {
    const admin = await env.login('admin');
    const setupMfa = await admin.post('/auth/mfa/totp/setup');
    const secret: string = setupMfa.body.secret;
    await admin.post('/auth/mfa/totp/confirm', { code: totpAt(secret, currentStep()) });

    expect((await admin.post('/backups')).status).toBe(201);
    expect(await env.app.get(BackupService).processNext()).toBe(true);
    const status = await admin.get('/backups');
    const backupId = status.body.lastBackup.id;

    expect((await admin.post('/companies', { code: 'LATE', nameAr: 'متأخرة', nameEn: 'Late' })).status).toBe(201);

    const preview = await admin.get(`/backups/${backupId}/restore-preview`);
    const req = await admin.post('/backups/restores', {
      backupRunId: backupId,
      password: 'Correct-Horse-Battery-9',
      code: totpAt(secret, currentStep() + 1),
      confirmation: preview.body.confirmationPhrase,
    });
    expect(req.status, req.text).toBe(201);
    expect(req.body.status).toBe('requested');

    const restores = env.app.get(RestoreService);
    expect(await restores.processNext()).toBe(true);
    const list = await admin.get('/backups/restores');
    expect(list.body.requests[0].status, list.body.requests[0].error ?? '').toBe('ready');

    // Production untouched until the switch.
    expect((await admin.get('/companies')).body.map((c: { code: string }) => c.code)).toContain('LATE');

    // A new TOTP step is needed for the confirmation (codes cannot be replayed).
    await new Promise((r) => setTimeout(r, 31_000));
    const confirm = await admin.post(`/backups/restores/${req.body.id}/confirm`, {
      password: 'Correct-Horse-Battery-9',
      code: totpAt(secret, currentStep() + 1),
    });
    expect(confirm.status, confirm.text).toBe(201);
    expect(await restores.processNext()).toBe(true);

    // Everyone is signed out; data is back at the backup point; audit carried forward.
    expect((await admin.get('/companies')).status).toBe(401);
    const companies = await env.database.system((tx) => tx.select({ code: company.code }).from(company));
    expect(companies.map((c) => c.code)).not.toContain('LATE');
    const audit = await env.database.owner.query<{ action: string; carried: boolean }>(
      `select action, (details->>'carriedForward')::boolean as carried from audit_event order by id desc limit 50`,
    );
    expect(audit.some((a) => a.action === 'system.restore.completed')).toBe(true);
    expect(audit.some((a) => a.action === 'org.company.created' && a.carried)).toBe(true);
    const [chain] = await env.database.owner.query<{ first_bad_id: string | null }>('select first_bad_id from audit_verify_chain()');
    expect(chain!.first_bad_id).toBeNull();
    const [rr] = await env.database.owner.query<{ status: string }>(`select status from restore_request where id = $1`, [req.body.id]);
    expect(rr!.status).toBe('completed');
    void API;
    void eq;
  }, 180_000);
});
