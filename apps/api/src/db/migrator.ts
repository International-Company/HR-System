import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import type { SqlRunner } from './database.js';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));

interface MigrationFile {
  version: string;
  name: string;
  sql: string;
  checksum: string;
}

export async function loadMigrations(dir = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const files = (await readdir(dir)).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();
  return Promise.all(
    files.map(async (f) => {
      const sql = await readFile(join(dir, f), 'utf8');
      return {
        version: f.slice(0, 4),
        name: f,
        sql,
        checksum: createHash('sha256').update(sql).digest('hex'),
      };
    }),
  );
}

/**
 * Forward-only migrations. Each file runs in its own transaction; applied files are
 * checksummed so an edited migration is detected instead of silently skipped.
 */
export async function migrate(
  owner: SqlRunner,
  opts: { dir?: string; appRole?: string; log?: (msg: string) => void } = {},
): Promise<{ applied: string[]; current: string | null }> {
  return owner.session((runner) => migrateOn(runner, opts));
}

async function migrateOn(
  runner: SqlRunner,
  opts: { dir?: string; appRole?: string; log?: (msg: string) => void },
): Promise<{ applied: string[]; current: string | null }> {
  const log = opts.log ?? (() => {});
  await runner.exec(`create table if not exists schema_migrations (
    version text primary key,
    name text not null,
    checksum text not null,
    applied_at timestamptz not null default now()
  )`);
  // Serialise concurrent migrators (e.g. two deploys).
  await runner.exec('select pg_advisory_lock(7745000)');
  try {
    const applied = new Map(
      (await runner.query<{ version: string; checksum: string }>(
        'select version, checksum from schema_migrations',
      )).map((r) => [r.version, r.checksum]),
    );
    const files = await loadMigrations(opts.dir);
    const done: string[] = [];
    for (const m of files) {
      const prev = applied.get(m.version);
      if (prev) {
        if (prev !== m.checksum) {
          throw new Error(`Migration ${m.name} was modified after being applied (checksum mismatch)`);
        }
        continue;
      }
      log(`Applying ${m.name}`);
      await runner.exec('begin');
      try {
        await runner.exec(m.sql);
        await runner.query(
          'insert into schema_migrations (version, name, checksum) values ($1, $2, $3)',
          [m.version, m.name, m.checksum],
        );
        await runner.exec('commit');
      } catch (err) {
        await runner.exec('rollback');
        throw new Error(`Migration ${m.name} failed: ${(err as Error).message}`, { cause: err });
      }
      done.push(m.name);
    }
    if (opts.appRole) {
      await runner.exec(`grant select on schema_migrations to ${opts.appRole}`);
    }
    const current = files.at(-1)?.version ?? null;
    return { applied: done, current };
  } finally {
    await runner.exec('select pg_advisory_unlock(7745000)');
  }
}

export async function currentSchemaVersion(runner: SqlRunner): Promise<string | null> {
  const rows = await runner.query<{ version: string }>(
    'select max(version) as version from schema_migrations',
  );
  return rows[0]?.version ?? null;
}
