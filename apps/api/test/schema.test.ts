import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { PERMISSIONS, SYSTEM_ROLES } from '@hrms/shared';
import { schema } from '../src/db/schema.js';
import { migrate } from '../src/db/migrator.js';
import { loadConfig } from '../src/config.js';
import { setup, testEnv, type TestEnv } from './helpers.js';

describe('schema & migrations', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup();
  });
  afterAll(async () => env.close());

  it('Drizzle definitions match the SQL migrations (no drift)', async () => {
    const cols = await env.database.owner.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns where table_schema = 'public'`,
    );
    for (const table of Object.values(schema) as PgTable[]) {
      const cfg = getTableConfig(table);
      const dbCols = cols.filter((c) => c.table_name === cfg.name).map((c) => c.column_name).sort();
      expect(dbCols.length, `table ${cfg.name} exists`).toBeGreaterThan(0);
      expect(cfg.columns.map((c) => c.name).sort(), `columns of ${cfg.name}`).toEqual(dbCols);
    }
  });

  it('migrations are idempotent and checksummed', async () => {
    const again = await migrate(env.database.owner);
    expect(again.applied).toEqual([]);
    await env.database.owner.exec(`update schema_migrations set checksum = 'tampered' where version = '0001'`);
    await expect(migrate(env.database.owner)).rejects.toThrow(/checksum mismatch/);
  });

  it('the permission catalogue and system roles are synced', async () => {
    const perms = await env.database.owner.query<{ key: string }>('select key from permission');
    expect(perms.map((p) => p.key).sort()).toEqual(PERMISSIONS.map((p) => p.key).sort());
    const roles = await env.database.owner.query<{ key: string }>('select key from role where is_system');
    expect(roles.map((r) => r.key).sort()).toEqual(SYSTEM_ROLES.map((r) => r.key).sort());
  });

  it('configuration refuses unsafe production settings', () => {
    const base = testEnv({ APP_ENV: 'production', DATABASE_URL: 'postgres://u:p@h/db' });
    expect(() => loadConfig(base)).toThrow(/DB_APP_PASSWORD/);
    expect(() => loadConfig({ ...base, DB_APP_PASSWORD: 'x'.repeat(30), PGLITE_DIR: 'memory://' })).toThrow(/PGLITE_DIR/);
    expect(() => loadConfig({ ...base, DB_APP_PASSWORD: 'x'.repeat(30), COOKIE_SECURE: 'true' })).not.toThrow();
  });
});
