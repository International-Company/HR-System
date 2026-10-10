import { sql } from 'drizzle-orm';
import { drizzle as drizzleNodePg } from 'drizzle-orm/node-postgres';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import type { PgDatabase, PgQueryResultHKT, PgTransaction } from 'drizzle-orm/pg-core';
import type { ExtractTablesWithRelations } from 'drizzle-orm';
import pg from 'pg';
import type { PGlite } from '@electric-sql/pglite';
import type { AppConfig } from '../config.js';
import { schema } from './schema.js';

type Schema = typeof schema;
export type Db = PgDatabase<PgQueryResultHKT, Schema>;
export type Tx = PgTransaction<PgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>;

/** Row-level-security context applied to every transaction (D-03). */
export interface RlsScope {
  group: boolean;
  companyIds: readonly string[];
  userId: string | null;
  /** The caller's own employee record (SELF access), if linked. */
  employeeId?: string | null;
}

export const SYSTEM_SCOPE: RlsScope = { group: true, companyIds: [], userId: null, employeeId: null };

/** Raw SQL access for migrations and maintenance (runs with the owner's privileges). */
export interface SqlRunner {
  exec(sqlText: string): Promise<void>;
  query<T = Record<string, unknown>>(sqlText: string, params?: unknown[]): Promise<T[]>;
  /** Run `fn` on one dedicated connection (needed for BEGIN/COMMIT and session locks). */
  session<T>(fn: (conn: SqlRunner) => Promise<T>): Promise<T>;
}

const ROLE_RE = /^[a-z_][a-z0-9_]*$/;

export class Database {
  constructor(
    readonly db: Db,
    /** Owner-privileged runner (migrations). Same connection as db for PGlite. */
    readonly owner: SqlRunner,
    /** When set, every transaction runs `SET LOCAL ROLE` to this role (dev/test). */
    private readonly setRole: string | null,
    private readonly closer: () => Promise<void>,
  ) {
    if (setRole && !ROLE_RE.test(setRole)) throw new Error('Invalid role name');
  }

  /** Run `fn` in a transaction with the given RLS scope, as the least-privileged role. */
  async tx<T>(scope: RlsScope, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      if (this.setRole) await tx.execute(sql.raw(`set local role ${this.setRole}`));
      await tx.execute(sql`select
        set_config('app.group_scope', ${scope.group ? 'on' : 'off'}, true),
        set_config('app.company_ids', ${toPgUuidArray(scope.companyIds)}, true),
        set_config('app.user_id', ${scope.userId ?? ''}, true),
        set_config('app.employee_id', ${scope.employeeId ?? ''}, true)`);
      return fn(tx as Tx);
    });
  }

  /** Group-wide scope for system operations (login, jobs). Use sparingly. */
  system<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.tx(SYSTEM_SCOPE, fn);
  }

  close(): Promise<void> {
    return this.closer();
  }
}

function toPgUuidArray(ids: readonly string[]): string {
  for (const id of ids) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Invalid uuid in scope');
  }
  return `{${ids.join(',')}}`;
}

/** Build the runtime database from configuration. */
export async function openDatabase(cfg: AppConfig): Promise<Database> {
  if (cfg.PGLITE_DIR) {
    const { PGlite } = await import('@electric-sql/pglite');
    const { btree_gist } = await import('@electric-sql/pglite/contrib/btree_gist');
    const { citext } = await import('@electric-sql/pglite/contrib/citext');
    if (!cfg.PGLITE_DIR.includes('://')) {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(cfg.PGLITE_DIR, { recursive: true });
    }
    const client = await PGlite.create(cfg.PGLITE_DIR, { extensions: { btree_gist, citext } });
    return fromPglite(client, cfg.DB_APP_ROLE);
  }
  const ownerUrl = cfg.DATABASE_URL!;
  const ownerPool = guard(new pg.Pool({ connectionString: ownerUrl, max: 2 }));
  if (cfg.DB_APP_PASSWORD) {
    const appUrl = new URL(ownerUrl);
    appUrl.username = cfg.DB_APP_ROLE;
    appUrl.password = cfg.DB_APP_PASSWORD;
    const appPool = guard(new pg.Pool({ connectionString: appUrl.toString(), max: cfg.DB_POOL_MAX }));
    return new Database(
      drizzleNodePg({ client: appPool, schema }) as unknown as Db,
      poolRunner(ownerPool),
      null,
      async () => {
        await appPool.end();
        await ownerPool.end();
      },
    );
  }
  // Development fallback: owner connection + SET LOCAL ROLE.
  const pool = guard(new pg.Pool({ connectionString: ownerUrl, max: cfg.DB_POOL_MAX }));
  return new Database(
    drizzleNodePg({ client: pool, schema }) as unknown as Db,
    poolRunner(pool),
    cfg.DB_APP_ROLE,
    async () => {
      await pool.end();
      await ownerPool.end();
    },
  );
}

/**
 * Idle connections can be terminated by the server (restarts, failover, the in-app restore
 * switch). Without a listener node-postgres would crash the process; the pool simply opens
 * a fresh connection on the next query.
 */
function guard(pool: pg.Pool): pg.Pool {
  pool.on('error', (err) => {
    console.error(`Database connection dropped: ${err.message}`);
  });
  return pool;
}

export function fromPglite(client: PGlite, appRole: string): Database {
  const runner: SqlRunner = {
    exec: async (text) => {
      await client.exec(text);
    },
    query: async <T>(text: string, params: unknown[] = []) =>
      (await client.query<T>(text, params)).rows,
    session: (fn) => fn(runner),
  };
  return new Database(
    drizzlePglite({ client, schema }) as unknown as Db,
    runner,
    appRole,
    async () => {
      await client.close();
    },
  );
}

function clientRunner(client: pg.PoolClient): SqlRunner {
  const runner: SqlRunner = {
    exec: async (text) => {
      await client.query(text);
    },
    query: async <T>(text: string, params: unknown[] = []) =>
      (await client.query(text, params)).rows as T[],
    session: (fn) => fn(runner),
  };
  return runner;
}

export function poolRunner(pool: pg.Pool): SqlRunner {
  return {
    exec: async (text) => {
      await pool.query(text);
    },
    query: async <T>(text: string, params: unknown[] = []) =>
      (await pool.query(text, params)).rows as T[],
    session: async (fn) => {
      const client = await pool.connect();
      try {
        return await fn(clientRunner(client));
      } finally {
        client.release();
      }
    },
  };
}
