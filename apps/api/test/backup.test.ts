import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DecryptStream, EncryptStream } from '../src/backup/stream-crypto.js';
import { LocalDirStorage } from '../src/backup/storage.js';
import { BackupService } from '../src/backup/backup.service.js';
import { setup, type TestEnv } from './helpers.js';

async function roundTrip(data: Buffer, chunk = 7): Promise<Buffer> {
  const key = randomBytes(32);
  const enc = new EncryptStream(key, 'b1');
  const out: Buffer[] = [];
  const chunks = [];
  for (let i = 0; i < data.length; i += chunk) chunks.push(data.subarray(i, i + chunk));
  const encrypted: Buffer[] = [];
  await pipeline(Readable.from(chunks), enc, async function* (src) {
    for await (const c of src) encrypted.push(c as Buffer);
  });
  await pipeline(Readable.from(encrypted), new DecryptStream(new Map([['b1', key]])), async function* (src) {
    for await (const c of src) out.push(c as Buffer);
  });
  return Buffer.concat(out);
}

describe('backup encryption stream', () => {
  it('round-trips data of any size', async () => {
    for (const size of [0, 1, 15, 16, 17, 1000, 100_000]) {
      const data = randomBytes(size);
      expect((await roundTrip(data, 13)).equals(data)).toBe(true);
    }
  });

  it('fails on tampering and on the wrong key', async () => {
    const key = randomBytes(32);
    const enc = new EncryptStream(key, 'b1');
    const parts: Buffer[] = [];
    await pipeline(Readable.from([Buffer.from('secret payroll data')]), enc, async function* (src) {
      for await (const c of src) parts.push(c as Buffer);
    });
    const blob = Buffer.concat(parts);
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 20]! ^= 1;
    const sink = async function* (src: AsyncIterable<unknown>) {
      for await (const _ of src) void _;
    };
    await expect(pipeline(Readable.from([tampered]), new DecryptStream(new Map([['b1', key]])), sink)).rejects.toThrow();
    await expect(pipeline(Readable.from([blob]), new DecryptStream(new Map([['b1', randomBytes(32)]])), sink)).rejects.toThrow();
    await expect(pipeline(Readable.from([blob]), new DecryptStream(new Map([['other', key]])), sink)).rejects.toThrow(/Unknown backup key/);
  });
});

describe('backup requests', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup();
  });
  afterAll(async () => env.close());

  it('refuses to start a backup when storage is not configured', async () => {
    const admin = await env.login('admin');
    const r = await admin.post('/backups');
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('NOT_CONFIGURED');
    const status = await admin.get('/backups');
    expect(status.body.configured).toBe(false);
  });
});

/**
 * Full backup → restore test against a real PostgreSQL server with pg_dump/pg_restore.
 * Runs in CI (TEST_DATABASE_URL + client tools installed); skipped otherwise.
 */
const hasTools = (() => {
  try {
    execSync('pg_dump --version', { stdio: 'ignore' });
    execSync('pg_restore --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.runIf(!!process.env.TEST_DATABASE_URL && hasTools)('backup and restore test (server)', () => {
  let env: TestEnv;
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hrms-bk-'));
    env = await setup({
      env: { BACKUP_ENCRYPTION_KEY: randomBytes(32).toString('base64'), BACKUP_LOCAL_DIR: dir },
      backupStorage: new LocalDirStorage(dir),
    });
  });
  afterAll(async () => {
    await env.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('creates an encrypted backup and proves it restores', async () => {
    const admin = await env.login('admin');
    expect((await admin.post('/backups')).status).toBe(201);
    const svc = env.app.get(BackupService);
    expect(await svc.processNext()).toBe(true);
    let status = await admin.get('/backups');
    expect(status.body.lastBackup.status).toBe('succeeded');
    expect(status.body.lastBackup.sizeBytes).toBeGreaterThan(1000);

    expect((await admin.post('/backups/restore-tests')).status).toBe(201);
    expect(await svc.processNext()).toBe(true);
    status = await admin.get('/backups');
    expect(status.body.lastRestoreTest.status, status.body.lastRestoreTest.error ?? '').toBe('succeeded');
  });
});
