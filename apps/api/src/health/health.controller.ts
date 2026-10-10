import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { sql } from 'drizzle-orm';
import { DATABASE } from '../common/tokens.js';
import type { Database } from '../db/database.js';
import { loadMigrations } from '../db/migrator.js';
import { Public } from '../auth/decorators.js';

export const APP_VERSION = process.env.APP_VERSION ?? process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? 'dev';

/** Liveness and readiness for Railway health checks. No secrets or internals are exposed. */
@Controller('health')
export class HealthController {
  private expectedVersion: Promise<string | null> | null = null;

  constructor(@Inject(DATABASE) private readonly database: Database) {}

  @Public()
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Public()
  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    this.expectedVersion ??= loadMigrations().then((m) => m.at(-1)?.version ?? null);
    const checks: Record<string, 'ok' | 'fail'> = {};
    try {
      const result = await this.database.system((tx) =>
        tx.execute<{ version: string | null }>(sql`select max(version) as version from schema_migrations`),
      );
      const version = (result as unknown as { rows: { version: string | null }[] }).rows[0]?.version ?? null;
      checks.database = 'ok';
      checks.migrations = version === (await this.expectedVersion) ? 'ok' : 'fail';
    } catch {
      checks.database = 'fail';
      checks.migrations = 'fail';
    }
    const ok = Object.values(checks).every((v) => v === 'ok');
    res.status(ok ? 200 : 503);
    return { status: ok ? 'ok' : 'unavailable', version: APP_VERSION, checks };
  }
}
