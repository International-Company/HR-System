import { Inject, Injectable, Logger } from '@nestjs/common';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import pg from 'pg';
import type { RestorePreviewDto, RestoreRequestDto } from '@hrms/shared';
import { CONFIG, DATABASE, ENCRYPTOR } from '../common/tokens.js';
import type { AppConfig } from '../config.js';
import type { Database } from '../db/database.js';
import { poolRunner } from '../db/database.js';
import { currentSchemaVersion, migrate } from '../db/migrator.js';
import { backupRun, restoreRequest, role, roleAssignment, userAccount } from '../db/schema.js';
import { ApiError } from '../common/errors.js';
import type { Encryptor } from '../common/crypto.js';
import { uuidv7 } from '../common/ids.js';
import type { Principal } from '../access/principal.js';
import { AuditService } from '../audit/audit.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { PasswordService } from '../auth/password.service.js';
import { verifyTotp } from '../auth/totp.js';
import { LockoutService } from '../auth/lockout.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { BackupService, pgEnv, run } from './backup.service.js';

type RequestRow = typeof restoreRequest.$inferSelect;

const ident = (name: string) => {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new Error(`Unsafe database name: ${name}`);
  return `"${name}"`;
};

/**
 * In-app restore (BKP-06, D-16b, backup-recovery.md §3).
 * 1. Request: preview + password + TOTP + typed phrase (optional second administrator).
 * 2. Worker restores the backup into a scratch database, migrates it forward and verifies it.
 * 3. Confirm: worker takes a pre-restore backup, carries audit events forward, revokes all
 *    sessions in the restored copy and swaps the databases (old one is kept, renamed).
 * Production data is untouched until step 3.
 */
@Injectable()
export class RestoreService {
  private readonly logger = new Logger('Restore');

  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(ENCRYPTOR) private readonly encryptor: Encryptor,
    @Inject(BackupService) private readonly backups: BackupService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
    @Inject(LockoutService) private readonly lockout: LockoutService,
  ) {}

  get supported(): boolean {
    return !!this.config.DATABASE_URL && !this.config.PGLITE_DIR && this.backups.configured;
  }

  private dbName(): string {
    return decodeURIComponent(new URL(this.config.DATABASE_URL!).pathname.replace(/^\//, ''));
  }

  // --- step-up authentication ----------------------------------------------------------

  private async stepUp(principal: Principal, password: string, code: string): Promise<void> {
    const [u] = await this.database.system((tx) => tx.select().from(userAccount).where(eq(userAccount.id, principal.userId)));
    if (!u?.totpSecretEnc) {
      throw new ApiError(403, 'MFA_REQUIRED_BY_POLICY', 'Two-step verification must be enabled to restore');
    }
    const okPassword = await this.passwords.verify(u.passwordHash, password);
    const step = verifyTotp(this.encryptor.decryptString(u.totpSecretEnc, `totp:${u.id}`), code, { lastUsedStep: u.totpLastStep });
    if (!okPassword || step === null) {
      // Counts toward the account lockout; at the limit the account is locked and signed out.
      if (await this.lockout.failedSecret(principal, 'system.restore.step_up_failed')) {
        throw new ApiError(401, 'AUTH_REQUIRED', 'Too many failed attempts. The account is temporarily locked.');
      }
      throw new ApiError(400, 'PASSWORD_INCORRECT', 'Password or verification code is incorrect');
    }
    await this.database.system((tx) => tx.update(userAccount).set({ totpLastStep: step }).where(eq(userAccount.id, u.id)));
  }

  private async otherActiveAdmins(userId: string): Promise<string[]> {
    const rows = await this.database.system((tx) =>
      tx
        .selectDistinct({ id: roleAssignment.userId })
        .from(roleAssignment)
        .innerJoin(role, eq(role.id, roleAssignment.roleId))
        .innerJoin(userAccount, eq(userAccount.id, roleAssignment.userId))
        .where(
          and(
            eq(role.key, 'system_admin'),
            eq(roleAssignment.scopeType, 'GROUP'),
            sql`${roleAssignment.endedAt} is null`,
            eq(userAccount.status, 'active'),
            ne(roleAssignment.userId, userId),
          ),
        ),
    );
    return rows.map((r) => r.id);
  }

  // --- preview & request -----------------------------------------------------------------

  async preview(principal: Principal, backupRunId: string): Promise<RestorePreviewDto> {
    const [b] = await this.database.system((tx) => tx.select().from(backupRun).where(eq(backupRun.id, backupRunId)));
    if (!b || b.status !== 'succeeded' || b.kind === 'restore_test' || !b.finishedAt) throw ApiError.notFound('Backup');
    const current = await currentSchemaVersion(this.database.owner);
    const since = b.startedAt ?? b.createdAt;
    const counts = await this.database.system((tx) =>
      tx.execute<{ module: string; count: number }>(sql`
        select split_part(action, '.', 1) as module, count(*)::int as count
        from audit_event
        where at > ${since} and action not in ('audit.viewed', 'auth.login', 'auth.logout', 'auth.mfa_verify')
          and outcome = 'success'
        group by 1 order by 2 desc`),
    );
    const changesSince = (counts as unknown as { rows: { module: string; count: number }[] }).rows;
    const warnings: string[] = ['all_changes_after_backup_lost', 'all_users_signed_out'];
    if (changesSince.some((c) => c.module === 'employee')) warnings.push('employee_changes_lost');
    if (changesSince.some((c) => c.module === 'documents')) warnings.push('documents_uploaded_after_backup_unlinked');
    if (changesSince.some((c) => c.module === 'identity' || c.module === 'access')) warnings.push('accounts_or_permissions_changed');
    const policy = await this.settings.get('backup.restore');
    return {
      backupRunId: b.id,
      backupAt: b.finishedAt.toISOString(),
      schemaVersion: b.schemaVersion,
      currentSchemaVersion: current,
      compatible: !!b.schemaVersion && !!current && b.schemaVersion <= current,
      changesSince,
      warnings,
      confirmationPhrase: `RESTORE ${b.finishedAt.toISOString().slice(0, 10)}`,
      secondApproverRequired: policy.requireSecondApprover && (await this.otherActiveAdmins(principal.userId)).length > 0,
    };
  }

  async request(
    principal: Principal,
    input: { backupRunId: string; password: string; code: string; confirmation: string },
  ): Promise<RestoreRequestDto> {
    if (!this.supported) throw new ApiError(409, 'NOT_CONFIGURED', 'Restore needs PostgreSQL server access and configured backups');
    const preview = await this.preview(principal, input.backupRunId);
    if (!preview.compatible) throw ApiError.conflict('This backup was made by a newer version of the system and cannot be restored here');
    if (input.confirmation.trim() !== preview.confirmationPhrase) {
      throw ApiError.validation([{ path: 'confirmation', message: `Type exactly: ${preview.confirmationPhrase}` }]);
    }
    await this.stepUp(principal, input.password, input.code);
    const id = uuidv7();
    const status = preview.secondApproverRequired ? 'awaiting_approval' : 'requested';
    await this.database.system(async (tx) => {
      try {
        await tx.insert(restoreRequest).values({
          id,
          backupRunId: input.backupRunId,
          status,
          requestedBy: principal.userId,
          details: { backupAt: preview.backupAt, changesSince: preview.changesSince },
        });
      } catch (err) {
        if ((err as { cause?: { code?: string } }).cause?.code === '23505') throw ApiError.conflict('Another restore is already in progress');
        throw err;
      }
      await this.audit.record(tx, {
        action: 'system.restore.requested',
        entityType: 'restore_request',
        entityId: id,
        actor: { userId: principal.userId, username: principal.username },
        details: { backupRunId: input.backupRunId, backupAt: preview.backupAt, status },
      });
      const admins = await this.otherActiveAdmins(principal.userId);
      await this.notifications.notify(tx, {
        userIds: admins,
        eventType: 'system.restore.requested',
        title: {
          ar: status === 'awaiting_approval' ? 'طلب استعادة بانتظار موافقتك' : 'تم طلب استعادة النظام',
          en: status === 'awaiting_approval' ? 'A restore request awaits your approval' : 'A system restore was requested',
        },
        body: { ar: `نسخة ${preview.backupAt.slice(0, 16)}`, en: `Backup of ${preview.backupAt.slice(0, 16)}` },
        link: '/backups',
      });
    });
    return this.get(id);
  }

  async approve(principal: Principal, id: string, password: string, code: string): Promise<RestoreRequestDto> {
    const req = await this.load(id);
    if (req.status !== 'awaiting_approval') throw ApiError.conflict('This request is not awaiting approval');
    if (req.requestedBy === principal.userId) throw ApiError.forbidden('A second administrator must approve');
    await this.stepUp(principal, password, code);
    await this.transition(id, ['awaiting_approval'], 'requested', { approvedBy: principal.userId }, 'system.restore.approved', principal);
    return this.get(id);
  }

  async confirmSwitch(principal: Principal, id: string, password: string, code: string): Promise<RestoreRequestDto> {
    const req = await this.load(id);
    if (req.status !== 'ready') throw ApiError.conflict('The restored copy is not ready yet');
    await this.stepUp(principal, password, code);
    await this.transition(id, ['ready'], 'switching', { switchConfirmedBy: principal.userId }, 'system.restore.switch_confirmed', principal);
    return this.get(id);
  }

  async cancel(principal: Principal, id: string): Promise<RestoreRequestDto> {
    const req = await this.load(id);
    await this.transition(id, ['awaiting_approval', 'requested', 'ready'], 'cancelled', {}, 'system.restore.cancelled', principal);
    if (req.scratchDatabase) await this.dropDatabase(req.scratchDatabase).catch(() => {});
    return this.get(id);
  }

  private async transition(
    id: string,
    from: readonly RequestRow['status'][],
    to: RequestRow['status'],
    extra: Partial<typeof restoreRequest.$inferInsert>,
    action: string,
    principal?: Principal,
  ): Promise<void> {
    await this.database.system(async (tx) => {
      const rows = await tx
        .update(restoreRequest)
        .set({ status: to, updatedAt: new Date(), ...extra })
        .where(and(eq(restoreRequest.id, id), inArray(restoreRequest.status, [...from])))
        .returning({ id: restoreRequest.id });
      if (!rows.length) throw ApiError.conflict('The restore request changed state; reload');
      await this.audit.record(tx, {
        action,
        entityType: 'restore_request',
        entityId: id,
        ...(principal ? { actor: { userId: principal.userId, username: principal.username } } : { actor: { userId: null, username: 'system' } }),
      });
    });
  }

  async list(): Promise<RestoreRequestDto[]> {
    const rows = await this.database.system((tx) => tx.select().from(restoreRequest).orderBy(desc(restoreRequest.createdAt)).limit(20));
    return Promise.all(rows.map((r) => this.toDto(r)));
  }

  async get(id: string): Promise<RestoreRequestDto> {
    return this.toDto(await this.load(id));
  }

  private async load(id: string): Promise<RequestRow> {
    const [r] = await this.database.system((tx) => tx.select().from(restoreRequest).where(eq(restoreRequest.id, id)));
    if (!r) throw ApiError.notFound('Restore request');
    return r;
  }

  private async toDto(r: RequestRow): Promise<RestoreRequestDto> {
    const [u] = await this.database.system((tx) =>
      tx.select({ name: userAccount.displayName }).from(userAccount).where(eq(userAccount.id, r.requestedBy)),
    );
    return {
      id: r.id,
      backupRunId: r.backupRunId,
      backupAt: (r.details.backupAt as string | undefined) ?? null,
      status: r.status,
      requestedBy: r.requestedBy,
      requestedByName: u?.name ?? null,
      approvedBy: r.approvedBy,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      error: r.error,
      details: r.details,
    };
  }

  // --- worker steps -----------------------------------------------------------------------

  /** Worker: prepare one requested restore, or perform one confirmed switch. */
  async processNext(): Promise<boolean> {
    if (!this.supported) return false;
    const [next] = await this.database.system((tx) =>
      tx.select().from(restoreRequest).where(inArray(restoreRequest.status, ['requested', 'switching'])).limit(1),
    );
    if (!next) return false;
    if (next.status === 'requested') {
      await this.transition(next.id, ['requested'], 'preparing', {}, 'system.restore.preparing');
      try {
        const details = await this.prepare(next);
        await this.database.system((tx) =>
          tx
            .update(restoreRequest)
            .set({ status: 'ready', scratchDatabase: details.scratch, details: { ...next.details, ...details.info }, updatedAt: new Date() })
            .where(eq(restoreRequest.id, next.id)),
        );
        await this.audit.recordStandalone({ action: 'system.restore.ready', entityType: 'restore_request', entityId: next.id, actor: { userId: null, username: 'system' }, details: details.info });
      } catch (err) {
        await this.fail(next.id, err);
      }
      return true;
    }
    try {
      await this.performSwitch(next);
    } catch (err) {
      await this.fail(next.id, err);
    }
    return true;
  }

  private async fail(id: string, err: unknown) {
    const message = (err as Error).message.slice(0, 2000);
    this.logger.error(`Restore ${id} failed: ${message}`);
    const [r] = await this.database.system((tx) =>
      tx.update(restoreRequest).set({ status: 'failed', error: message, updatedAt: new Date() }).where(eq(restoreRequest.id, id)).returning(),
    );
    if (r?.scratchDatabase && r.status === 'failed') await this.dropDatabase(r.scratchDatabase).catch(() => {});
    await this.audit.recordStandalone({ action: 'system.restore.failed', outcome: 'failure', entityType: 'restore_request', entityId: id, actor: { userId: null, username: 'system' }, details: { error: message } });
  }

  private ownerUrl(database: string): string {
    const u = new URL(this.config.DATABASE_URL!);
    u.pathname = `/${database}`;
    return u.toString();
  }

  private async admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: this.ownerUrl('postgres') });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  private async dropDatabase(name: string) {
    await this.admin(async (c) => {
      await c.query(`drop database if exists ${ident(name)} with (force)`);
    });
  }

  /** Restore into a scratch database, migrate it forward and verify it. Production is untouched. */
  private async prepare(req: RequestRow): Promise<{ scratch: string; info: Record<string, unknown> }> {
    const [b] = await this.database.system((tx) => tx.select().from(backupRun).where(eq(backupRun.id, req.backupRunId)));
    if (!b?.objectKey) throw new Error('Backup file not found');
    const scratch = `hrms_restore_${req.id.replace(/-/g, '').slice(-12)}`;
    const dir = await mkdtemp(join(tmpdir(), 'hrms-restore-'));
    const file = join(dir, 'restore.dump');
    try {
      await pipeline(await this.backups.storagePort!.get(b.objectKey), this.backups.decryptStream(), createWriteStream(file));
      await this.admin(async (c) => {
        await c.query(`drop database if exists ${ident(scratch)} with (force)`);
        await c.query(`create database ${ident(scratch)}`);
      });
      await run('pg_restore', ['--no-owner', '--exit-on-error', '--dbname', scratch, file], pgEnv(this.config.DATABASE_URL!, scratch));
      const pool = new pg.Pool({ connectionString: this.ownerUrl(scratch), max: 2 });
      try {
        const runner = poolRunner(pool);
        const migrated = await migrate(runner, { appRole: this.config.DB_APP_ROLE });
        const [chain] = await runner.query<{ checked: string; first_bad_id: string | null }>('select checked, first_bad_id from audit_verify_chain()');
        if (chain?.first_bad_id) throw new Error(`Audit chain of the backup is broken at ${chain.first_bad_id}`);
        const [counts] = await runner.query<Record<string, number>>(
          `select (select count(*) from company)::int as companies, (select count(*) from employee)::int as employees,
                  (select count(*) from user_account)::int as users, (select max(id) from audit_event)::text as audit_max_id`,
        );
        return { scratch, info: { migrationsApplied: migrated.applied, verified: true, counts } };
      } finally {
        await pool.end();
      }
    } catch (err) {
      await this.dropDatabase(scratch).catch(() => {});
      throw err;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private async performSwitch(req: RequestRow): Promise<void> {
    if (!req.scratchDatabase) throw new Error('No restored copy to switch to');
    const live = this.dbName();
    const scratch = req.scratchDatabase;
    // Sortable name for the kept copy: <db>_pre_YYYYMMDDHHMMSS.
    const oldName = `${live}_pre_${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;

    // 1. Pre-restore backup of the current state (makes the restore undoable).
    const [pre] = await this.database.system((tx) =>
      tx.insert(backupRun).values({ id: uuidv7(), kind: 'manual', status: 'running', startedAt: new Date(), details: { preRestoreFor: req.id } }).returning(),
    );
    const result = await this.backups.executeBackup(pre!);
    await this.backups.finish(pre!, 'succeeded', result);
    await this.database.system((tx) => tx.update(restoreRequest).set({ preRestoreBackupId: pre!.id }).where(eq(restoreRequest.id, req.id)));

    // 2. Carry forward what must survive: audit history after the backup point, backup and
    //    restore records. Then sign everybody out of the restored copy.
    const scratchPool = new pg.Pool({ connectionString: this.ownerUrl(scratch), max: 1 });
    let carried = 0;
    try {
      const [{ m }] = (await scratchPool.query<{ m: string | null }>('select max(id)::text as m from audit_event')).rows as [{ m: string | null }];
      const newer = await this.database.owner.query<Record<string, unknown>>(
        `select * from audit_event where id > $1 order by id`,
        [m ?? '0'],
      );
      for (const e of newer) {
        await scratchPool.query(
          `insert into audit_event (id, actor_user_id, actor_username, session_id, action, entity_type, entity_id,
             company_id, before, after, ip, user_agent, outcome, details, hash)
           values (0, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, '\\x')`,
          [
            e.actor_user_id, e.actor_username, e.session_id, e.action, e.entity_type, e.entity_id, e.company_id,
            e.before, e.after, e.ip, e.user_agent, e.outcome,
            { ...((e.details as object) ?? {}), carriedForward: true, originalId: String(e.id), originalAt: e.at },
          ],
        );
        carried++;
      }
      for (const table of ['backup_run', 'restore_request'] as const) {
        const present = new Set((await scratchPool.query<{ id: string }>(`select id from ${table}`)).rows.map((r) => r.id));
        const rows = (await this.database.owner.query<Record<string, unknown>>(`select * from ${table}`)).filter((r) => !present.has(r.id as string));
        for (const r of rows) {
          const cols = Object.keys(r);
          await scratchPool.query(
            `insert into ${table} (${cols.map((c) => `"${c}"`).join(', ')}) values (${cols.map((_, n) => `$${n + 1}`).join(', ')})`,
            cols.map((c) => r[c]),
          );
        }
      }
      await scratchPool.query(`update session set revoked_at = now(), revoked_reason = 'system_restore' where revoked_at is null`);
      await scratchPool.query(
        `update restore_request set status = 'completed', updated_at = now(), details = details || $2::jsonb where id = $1`,
        [req.id, JSON.stringify({ carriedAuditEvents: carried, previousDatabase: oldName })],
      );
      await scratchPool.query(
        `insert into audit_event (id, action, entity_type, entity_id, outcome, details, hash)
         values (0, 'system.restore.completed', 'restore_request', $1, 'success', $2::jsonb, '\\x')`,
        [req.id, JSON.stringify({ backupRunId: req.backupRunId, carriedAuditEvents: carried, preRestoreBackupId: pre!.id })],
      );
    } finally {
      await scratchPool.end();
    }

    // 3. Swap databases. The old database is kept under a new name for manual fallback.
    await this.admin(async (c) => {
      await c.query(`alter database ${ident(live)} with allow_connections false`);
      await c.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname in ($1, $2) and pid <> pg_backend_pid()`, [live, scratch]);
      await c.query(`alter database ${ident(live)} rename to ${ident(oldName)}`);
      await c.query(`alter database ${ident(scratch)} rename to ${ident(live)}`);
      await c.query(`alter database ${ident(oldName)} with allow_connections true`);
    });
    this.logger.log(`Restore ${req.id} completed: ${live} now serves the restored data (previous kept as ${oldName})`);
  }

  /** Remove copies kept by earlier restores, keeping the most recent one. */
  async pruneOldCopies(): Promise<string[]> {
    if (!this.supported) return [];
    const live = this.dbName();
    return this.admin(async (c) => {
      const res = await c.query<{ datname: string }>(
        `select datname from pg_database where datname like $1 order by datname desc`,
        [`${live}\\_pre\\_%`],
      );
      const dropped: string[] = [];
      for (const r of res.rows.slice(1)) {
        await c.query(`drop database if exists ${ident(r.datname)} with (force)`);
        dropped.push(r.datname);
      }
      return dropped;
    });
  }
}

