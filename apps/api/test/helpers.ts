import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import request from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import { openDatabase, type Database } from '../src/db/database.js';
import { createApp } from '../src/create-app.js';
import { provision } from '../src/provisioning.js';
import { seed, type SeedResult } from '../src/seed.js';
import { AuthService } from '../src/auth/auth.service.js';
import { eq } from 'drizzle-orm';
import { role, roleAssignment, userAccount } from '../src/db/schema.js';
import { uuidv7 } from '../src/common/ids.js';
import { LocalDirStorage, type StoragePort } from '../src/backup/storage.js';
import type { PushSender } from '../src/notifications/notifications.service.js';

export const TEST_PASSWORD = 'Correct-Horse-Battery-9';
export const API = '/api/v1';

export interface TestEnv {
  app: INestApplication;
  database: Database;
  config: AppConfig;
  seeded: SeedResult;
  /** Local directory holding (encrypted) uploaded documents. */
  filesDir: string;
  /** Log in a seeded persona; returns an agent carrying the session cookie and CSRF token. */
  login(username: string, password?: string): Promise<Session>;
  anon(): TestAgent;
  close(): Promise<void>;
}

export interface Session {
  agent: TestAgent;
  csrf: string;
  get(url: string): request.Test;
  post(url: string, body?: unknown): request.Test;
  patch(url: string, body?: unknown): request.Test;
  put(url: string, body?: unknown): request.Test;
  del(url: string): request.Test;
}

export function testEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    APP_ENV: 'test',
    SESSION_SECRET: randomBytes(32).toString('hex'),
    DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    COOKIE_SECURE: 'false',
    ...extra,
  };
}

/**
 * Fresh, isolated database per test file:
 *  - default: in-memory PGlite (no installation needed);
 *  - TEST_DATABASE_URL set (CI): a new database on a real PostgreSQL server.
 */
export async function setup(
  opts: {
    env?: Record<string, string>;
    backupStorage?: StoragePort | null;
    relaxMfa?: boolean;
    pushSender?: PushSender;
  } = {},
): Promise<TestEnv> {
  let dropDb: (() => Promise<void>) | null = null;
  let env: NodeJS.ProcessEnv;
  if (process.env.TEST_DATABASE_URL) {
    const name = `hrms_test_${randomBytes(6).toString('hex')}`;
    const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.connect();
    await admin.query(`create database ${name}`);
    await admin.end();
    const url = new URL(process.env.TEST_DATABASE_URL);
    url.pathname = `/${name}`;
    env = testEnv({ DATABASE_URL: url.toString(), ...opts.env });
    dropDb = async () => {
      const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
      await c.connect();
      await c.query(`drop database if exists ${name} with (force)`);
      await c.end();
    };
  } else {
    env = testEnv({ PGLITE_DIR: 'memory://', ...opts.env });
  }
  const config = loadConfig(env);
  const database = await openDatabase(config);
  await provision(database, config, () => {});
  const seeded = await seed(database, config, {
    password: TEST_PASSWORD,
    relaxMfa: opts.relaxMfa ?? true,
  });
  const filesDir = mkdtempSync(join(tmpdir(), 'hrms-files-'));
  const app = await createApp(
    {
      config,
      database,
      backupStorage: opts.backupStorage ?? null,
      fileStorage: new LocalDirStorage(filesDir),
      // Tests never contact real push services.
      pushSender: opts.pushSender ?? { send: async () => 'ok' as const },
    },
    { logger: false },
  );
  const server = app.getHttpServer();

  const login = async (username: string, password = TEST_PASSWORD): Promise<Session> => {
    await app.get(AuthService).ipLimiter.reset();
    await app.get(AuthService).userLimiter.reset();
    const agent = request.agent(server);
    const res = await agent.post(`${API}/auth/login`).send({ username, password });
    if (res.status !== 204) throw new Error(`login ${username} failed: ${res.status} ${res.text}`);
    const s = await agent.get(`${API}/auth/session`);
    return session(agent, s.body.csrfToken as string);
  };

  return {
    app,
    database,
    config,
    seeded,
    filesDir,
    login,
    anon: () => request.agent(server),
    close: async () => {
      await app.close();
      await database.close();
      if (dropDb) await dropDb();
      rmSync(filesDir, { recursive: true, force: true });
    },
  };
}

export function session(agent: TestAgent, csrf: string): Session {
  return {
    agent,
    csrf,
    get: (url) => agent.get(`${API}${url}`),
    post: (url, body) => agent.post(`${API}${url}`).set('x-csrf-token', csrf).send(body as object),
    patch: (url, body) => agent.patch(`${API}${url}`).set('x-csrf-token', csrf).send(body as object),
    put: (url, body) => agent.put(`${API}${url}`).set('x-csrf-token', csrf).send(body as object),
    del: (url) => agent.delete(`${API}${url}`).set('x-csrf-token', csrf),
  };
}

/** Run raw SQL as the least-privileged runtime role inside an RLS scope. */
export async function asAppRole<T>(
  database: Database,
  scope: { group: boolean; companyIds: string[] },
  fn: (q: (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>) => Promise<T>,
): Promise<T> {
  const { sql } = await import('drizzle-orm');
  return database.tx({ ...scope, userId: null }, async (tx) =>
    fn(async (text, params = []) => {
      // Build a parameterised statement from $n placeholders.
      const parts = text.split(/\$(\d+)/);
      const chunks = [];
      for (let i = 0; i < parts.length; i++) {
        if (i % 2 === 0) chunks.push(sql.raw(parts[i]!));
        else chunks.push(sql`${params[Number(parts[i]) - 1]}`);
      }
      const res = await tx.execute(sql.join(chunks, sql.raw('')));
      return (res as unknown as { rows: Record<string, unknown>[] }).rows;
    }),
  );
}

/** Give a seeded user an extra role assignment directly (test setup only). */
export async function grant(env: TestEnv, username: string, roleKey: string, scope: 'GROUP' | 'COMPANY', company?: string) {
  await env.database.system(async (tx) => {
    const [u] = await tx.select().from(userAccount).where(eq(userAccount.username, username));
    const [r] = await tx.select().from(role).where(eq(role.key, roleKey));
    await tx.insert(roleAssignment).values({
      id: uuidv7(),
      userId: u!.id,
      roleId: r!.id,
      scopeType: scope,
      companyId: company ? env.seeded.companies[company]! : null,
    });
  });
}

