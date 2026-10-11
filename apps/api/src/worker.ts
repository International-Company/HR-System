import 'reflect-metadata';
import { ConsoleLogger, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Cron } from 'croner';
import { sql } from 'drizzle-orm';
import { loadConfig } from './config.js';
import { openDatabase } from './db/database.js';
import { WorkerModule } from './app.module.js';
import { BackupService } from './backup/backup.service.js';
import { AuditService } from './audit/audit.service.js';
import { NotificationsService } from './notifications/notifications.service.js';
import { RestoreService } from './backup/restore.service.js';
import { AttendanceService } from './attendance/attendance.service.js';
import { LeaveService } from './leave/leave.service.js';
import { ContractsService } from './contracts/contracts.service.js';
import { SeparationService } from './separation/separation.service.js';
import { ReportsService } from './reports/reports.service.js';
import { assertNoSeedAccounts } from './provisioning.js';

/**
 * Background worker (separate Railway service, same image). Jobs use advisory locks or
 * row claiming, so running more than one worker is safe.
 */
async function main() {
  const config = loadConfig();
  const database = await openDatabase(config);
  await assertNoSeedAccounts(database, config);
  const ctx = await NestFactory.createApplicationContext(WorkerModule.register({ config, database }), {
    logger: new ConsoleLogger({ json: config.logJson, colors: !config.logJson }),
  });
  const log = new Logger('Worker');
  const backups = ctx.get(BackupService);
  const audit = ctx.get(AuditService);
  const notifications = ctx.get(NotificationsService);
  const restores = ctx.get(RestoreService);
  const attendance = ctx.get(AttendanceService);
  const leave = ctx.get(LeaveService);
  const contracts = ctx.get(ContractsService);
  const separations = ctx.get(SeparationService);
  const reports = ctx.get(ReportsService);

  const guarded = (name: string, fn: () => Promise<void>) => async () => {
    try {
      await fn();
    } catch (err) {
      log.error(`Job ${name} failed: ${(err as Error).message}`);
    }
  };

  const jobs = [
    // Attendance: recompute the last two days hourly (absence detection, auto-closure).
    new Cron('20 * * * *', { protect: true }, guarded('attendance', async () => {
      await attendance.dailyRecompute(2);
    })),
    // Leave: accrual, carryover and expiry entries, daily shortly after midnight.
    new Cron('40 0 * * *', { protect: true }, guarded('leave-accrual', async () => {
      await leave.dailyAccrual();
    })),
    // Contracts: automatic renewals, expiry and expiry/probation alerts, daily.
    new Cron('50 0 * * *', { protect: true }, guarded('contracts', async () => {
      await contracts.daily();
    })),
    // Separation: apply the exit policy after the last working day (TRM-05), daily.
    new Cron('10 0 * * *', { protect: true }, guarded('separation', async () => {
      await separations.daily();
    })),
    // Scheduled reports, delivered in the app (C-03), checked every hour; old files pruned daily.
    new Cron('5 * * * *', { protect: true }, guarded('reports', async () => {
      await reports.runSchedules();
    })),
    new Cron('30 4 * * *', { protect: true }, guarded('report-files', async () => {
      await reports.pruneOutputs();
    })),
    // Web Push delivery of new notifications, every 15 seconds.
    new Cron('*/15 * * * * *', { protect: true }, guarded('push', async () => {
      await notifications.dispatchPush();
    })),
    // In-app restore: prepare requested restores / perform confirmed switches (BKP-06).
    new Cron('*/15 * * * * *', { protect: true }, guarded('restore', async () => {
      await restores.processNext();
    })),
    // Keep only the most recent pre-restore database copy, daily 05:00 UTC.
    new Cron('0 5 * * *', { protect: true }, guarded('restore-prune', async () => {
      const dropped = await restores.pruneOldCopies();
      if (dropped.length) log.log(`Dropped old pre-restore copies: ${dropped.join(', ')}`);
    })),
    // Backup requests (manual, scheduled, restore tests) are picked up every minute.
    new Cron('* * * * *', { protect: true }, guarded('backups', async () => {
      await backups.ensureScheduled();
      while (await backups.processNext()) {
        /* drain queue */
      }
    })),
    // Monthly automated restore test (BKP-05), 1st of the month 04:00 UTC.
    new Cron('0 4 1 * *', { protect: true }, guarded('restore-test', async () => {
      if (!backups.configured) return;
      await database.system(async (tx) => {
        await tx.execute(sql`insert into backup_run (id, kind, status)
          select gen_random_uuid(), 'restore_test', 'requested'
          where not exists (select 1 from backup_run where kind = 'restore_test'
                            and created_at > now() - interval '20 days')`);
      });
    })),
    // Daily audit-chain verification (AUD-04), 03:30 UTC.
    new Cron('30 3 * * *', { protect: true }, guarded('audit-verify', async () => {
      const result = await database.system((tx) =>
        tx.execute<{ checked: string; first_bad_id: string | null }>(
          sql`select checked, first_bad_id from audit_verify_chain()`,
        ),
      );
      const row = (result as unknown as { rows: { checked: string; first_bad_id: string | null }[] }).rows[0]!;
      const ok = row.first_bad_id === null;
      await audit.recordStandalone({
        action: 'audit.chain_verified',
        outcome: ok ? 'success' : 'failure',
        actor: { userId: null, username: 'system' },
        details: { checked: Number(row.checked), firstBadId: row.first_bad_id, scheduled: true },
      });
      if (!ok) log.error(`Audit chain verification FAILED at id ${row.first_bad_id}`);
    })),
    // Housekeeping: mark expired sessions as revoked, hourly.
    new Cron('15 * * * *', { protect: true }, guarded('sessions', async () => {
      await database.system((tx) =>
        tx.execute(sql`update session set revoked_at = now(), revoked_reason = 'expired'
                       where revoked_at is null and expires_at < now()`),
      );
    })),
  ];

  log.log(`HRMS worker started (${config.APP_ENV}); backups ${backups.configured ? 'configured' : 'NOT configured'}`);
  const shutdown = async () => {
    jobs.forEach((j) => j.stop());
    await ctx.close();
    await database.close();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}

main().catch((err: unknown) => {
  console.error((err as Error).message ?? err);
  process.exit(1);
});
