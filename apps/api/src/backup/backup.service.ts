import { Inject, Injectable, Logger } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { desc, eq, sql } from 'drizzle-orm';
import pg from 'pg';
import type { BackupRunDto } from '@hrms/shared';
import { BACKUP_STORAGE, CONFIG, DATABASE } from '../common/tokens.js';
import type { AppConfig } from '../config.js';
import type { Database } from '../db/database.js';
import { currentSchemaVersion } from '../db/migrator.js';
import { backupRun } from '../db/schema.js';
import { ApiError } from '../common/errors.js';
import { uuidv7 } from '../common/ids.js';
import type { Principal } from '../access/principal.js';
import { AuditService } from '../audit/audit.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { APP_VERSION } from '../health/health.controller.js';
import type { StoragePort } from './storage.js';
import { DecryptStream, EncryptStream } from './stream-crypto.js';

type RunRow = typeof backupRun.$inferSelect;
const SCRATCH_DB = 'hrms_restore_check';

const toDto = (r: RunRow): BackupRunDto => ({
  id: r.id,
  kind: r.kind,
  status: r.status,
  requestedBy: r.requestedBy,
  createdAt: r.createdAt.toISOString(),
  startedAt: r.startedAt?.toISOString() ?? null,
  finishedAt: r.finishedAt?.toISOString() ?? null,
  sizeBytes: r.sizeBytes,
  objectKey: r.objectKey,
  error: r.error,
});

/** pg connection settings passed through the environment so the password never hits argv. */
export function pgEnv(url: string, database?: string): NodeJS.ProcessEnv {
  const u = new URL(url);
  return {
    ...process.env,
    PGHOST: u.hostname,
    PGPORT: u.port || '5432',
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: database ?? decodeURIComponent(u.pathname.replace(/^\//, '')),
    PGSSLMODE: u.searchParams.get('sslmode') ?? process.env.PGSSLMODE ?? 'prefer',
  };
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-4000)));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}: ${stderr.trim()}`)),
    );
  });
}

function zonedParts(date: Date, timeZone: string): { day: string; hm: string } {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}` };
}

/**
 * Encrypted logical backups to off-site storage and automated restore tests
 * (backup-recovery.md L2, BKP-01..05).
 */
@Injectable()
export class BackupService {
  private readonly logger = new Logger('Backup');

  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(BACKUP_STORAGE) private readonly storage: StoragePort | null,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SettingsService) private readonly settings: SettingsService,
  ) {}

  get configured(): boolean {
    return !!(this.storage && this.config.BACKUP_ENCRYPTION_KEY && this.config.DATABASE_URL);
  }

  async status() {
    const runs = await this.recent(20);
    const lastBackup = runs.find((r) => r.kind !== 'restore_test' && r.status === 'succeeded') ?? null;
    const lastRestoreTest = runs.find((r) => r.kind === 'restore_test' && r.status !== 'requested') ?? null;
    return {
      configured: this.configured,
      destination: this.storage?.description ?? null,
      encrypted: !!this.config.BACKUP_ENCRYPTION_KEY,
      policy: await this.settings.get('backup.policy'),
      lastBackup,
      lastRestoreTest,
      runs,
    };
  }

  async recent(limit = 50): Promise<BackupRunDto[]> {
    const rows = await this.database.system((tx) =>
      tx.select().from(backupRun).orderBy(desc(backupRun.createdAt)).limit(limit),
    );
    return rows.map(toDto);
  }

  async request(principal: Principal, kind: 'manual' | 'restore_test'): Promise<BackupRunDto> {
    if (!this.configured) {
      throw new ApiError(409, 'NOT_CONFIGURED', 'Backup storage or encryption key is not configured');
    }
    return this.database.tx(principal.rls(), async (tx) => {
      const [row] = await tx
        .insert(backupRun)
        .values({ id: uuidv7(), kind, status: 'requested', requestedBy: principal.userId })
        .returning();
      await this.audit.record(tx, {
        action: kind === 'manual' ? 'system.backup.requested' : 'system.restore_test.requested',
        entityType: 'backup_run',
        entityId: row!.id,
      });
      return toDto(row!);
    });
  }

  /** Worker: create today's scheduled backup request once the configured time has passed. */
  async ensureScheduled(now = new Date()): Promise<boolean> {
    if (!this.configured) return false;
    const policy = await this.settings.get('backup.policy');
    if (!policy.enabled) return false;
    const tz = await this.settings.get('general.timezone');
    const { day, hm } = zonedParts(now, tz);
    if (hm < policy.dailyAt) return false;
    return this.database.system(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(7745010)`);
      const existing = await tx.execute(
        sql`select 1 from backup_run where kind = 'scheduled' and details->>'day' = ${day} limit 1`,
      );
      if ((existing as unknown as { rows: unknown[] }).rows.length) return false;
      await tx.insert(backupRun).values({
        id: uuidv7(),
        kind: 'scheduled',
        status: 'requested',
        details: { day },
      });
      return true;
    });
  }

  /** Worker: claim and execute one pending request. Returns false if none. */
  async processNext(): Promise<boolean> {
    const claimed = await this.database.system(async (tx) => {
      const result = await tx.execute<{ id: string }>(sql`
        update backup_run set status = 'running', started_at = now()
        where id = (select id from backup_run where status = 'requested'
                    order by created_at limit 1 for update skip locked)
        returning id`);
      return (result as unknown as { rows: { id: string }[] }).rows[0]?.id ?? null;
    });
    if (!claimed) return false;
    const [runRow] = await this.database.system((tx) =>
      tx.select().from(backupRun).where(eq(backupRun.id, claimed)),
    );
    try {
      const details =
        runRow!.kind === 'restore_test' ? await this.executeRestoreTest() : await this.executeBackup(runRow!);
      await this.finish(runRow!, 'succeeded', details);
    } catch (err) {
      this.logger.error(`Backup run ${claimed} failed: ${(err as Error).message}`);
      await this.finish(runRow!, 'failed', {}, (err as Error).message.slice(0, 2000));
    }
    return true;
  }

  private async finish(
    runRow: RunRow,
    status: 'succeeded' | 'failed',
    result: { objectKey?: string; sizeBytes?: number; sha256?: Buffer; schemaVersion?: string | null; details?: Record<string, unknown> },
    error?: string,
  ) {
    await this.database.system(async (tx) => {
      await tx
        .update(backupRun)
        .set({
          status,
          finishedAt: new Date(),
          objectKey: result.objectKey ?? null,
          sizeBytes: result.sizeBytes ?? null,
          sha256: result.sha256 ?? null,
          schemaVersion: result.schemaVersion ?? null,
          details: { ...((runRow.details as object) ?? {}), ...(result.details ?? {}) },
          error: error ?? null,
        })
        .where(eq(backupRun.id, runRow.id));
      await this.audit.record(tx, {
        action: runRow.kind === 'restore_test' ? 'system.restore_test.completed' : 'system.backup.completed',
        entityType: 'backup_run',
        entityId: runRow.id,
        outcome: status === 'succeeded' ? 'success' : 'failure',
        actor: { userId: null, username: 'system' },
        details: { kind: runRow.kind, sizeBytes: result.sizeBytes ?? null, error: error ?? null, ...(result.details ?? {}) },
      });
    });
  }

  private async executeBackup(runRow: RunRow) {
    const url = this.config.DATABASE_URL!;
    const schemaVersion = await currentSchemaVersion(this.database.owner);
    const stamp = runRow.createdAt.toISOString().replace(/[:.]/g, '-');
    const day = runRow.createdAt.toISOString().slice(0, 10).replace(/-/g, '/');
    const objectKey = `${this.config.BACKUP_S3_PREFIX}/db/${day}/${stamp}-${runRow.kind}-${runRow.id}.dump.enc`;

    const enc = new EncryptStream(
      Buffer.from(this.config.BACKUP_ENCRYPTION_KEY!, 'base64'),
      this.config.BACKUP_ENCRYPTION_KEY_ID,
    );
    const child = spawn('pg_dump', ['--format=custom', '--compress=6', '--no-owner'], {
      env: pgEnv(url),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-4000)));
    const exited = new Promise<void>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`pg_dump exited with ${code}: ${stderr.trim()}`)),
      );
    });
    const body = new PassThrough();
    const upload = this.storage!.put(objectKey, body, 'application/octet-stream');
    await Promise.all([pipeline(child.stdout, enc, body), exited, upload]);

    const sha = enc.digest.digest();
    const manifest = {
      format: 'hrms-backup-v1',
      runId: runRow.id,
      kind: runRow.kind,
      createdAt: runRow.createdAt.toISOString(),
      appVersion: APP_VERSION,
      schemaVersion,
      sizeBytes: enc.bytesOut,
      sha256: sha.toString('hex'),
      encryption: { algorithm: 'AES-256-GCM', keyId: this.config.BACKUP_ENCRYPTION_KEY_ID },
    };
    await this.storage!.put(
      objectKey.replace(/\.dump\.enc$/, '.manifest.json'),
      Readable.from([Buffer.from(JSON.stringify(manifest, null, 2))]),
      'application/json',
    );
    return { objectKey, sizeBytes: enc.bytesOut, sha256: sha, schemaVersion, details: { destination: this.storage!.description } };
  }

  /**
   * Restore the latest successful backup into a scratch database, verify it, drop it.
   * Proves the backup is restorable without touching production data.
   */
  private async executeRestoreTest() {
    const url = this.config.DATABASE_URL!;
    const [latest] = await this.database.system((tx) =>
      tx.execute<{ id: string; object_key: string; schema_version: string | null }>(sql`
        select id, object_key, schema_version from backup_run
        where status = 'succeeded' and kind in ('manual', 'scheduled')
        order by finished_at desc limit 1`),
    ).then((r) => (r as unknown as { rows: { id: string; object_key: string; schema_version: string | null }[] }).rows);
    if (!latest) throw new Error('No successful backup to test');

    const dir = await mkdtemp(join(tmpdir(), 'hrms-restore-'));
    const file = join(dir, 'restore.dump');
    const owner = new pg.Client({ connectionString: url });
    await owner.connect();
    try {
      const keys = new Map([[this.config.BACKUP_ENCRYPTION_KEY_ID, Buffer.from(this.config.BACKUP_ENCRYPTION_KEY!, 'base64')]]);
      await pipeline(await this.storage!.get(latest.object_key), new DecryptStream(keys), createWriteStream(file));

      await owner.query(`drop database if exists ${SCRATCH_DB}`);
      await owner.query(`create database ${SCRATCH_DB}`);
      await run('pg_restore', ['--no-owner', '--exit-on-error', '--dbname', SCRATCH_DB, file], pgEnv(url, SCRATCH_DB));

      const scratchUrl = new URL(url);
      scratchUrl.pathname = `/${SCRATCH_DB}`;
      const check = new pg.Client({ connectionString: scratchUrl.toString() });
      await check.connect();
      let details: Record<string, unknown>;
      try {
        const version = (await check.query('select max(version) as v from schema_migrations')).rows[0]?.v ?? null;
        const chain = (await check.query('select checked, first_bad_id from audit_verify_chain()')).rows[0];
        const counts = (
          await check.query(`select
            (select count(*) from company)::int as companies,
            (select count(*) from user_account)::int as users,
            (select count(*) from audit_event)::int as audit_events`)
        ).rows[0];
        if (version !== latest.schema_version) throw new Error(`Schema version mismatch: ${version} vs ${latest.schema_version}`);
        if (chain.first_bad_id !== null) throw new Error(`Audit chain broken at id ${chain.first_bad_id}`);
        details = { testedBackupId: latest.id, schemaVersion: version, auditChecked: Number(chain.checked), counts };
      } finally {
        await check.end();
      }
      return { details };
    } finally {
      await owner.query(`drop database if exists ${SCRATCH_DB}`).catch(() => {});
      await owner.end();
      await rm(dir, { recursive: true, force: true });
    }
  }
}
