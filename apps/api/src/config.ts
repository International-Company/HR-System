import { z } from 'zod';
import { isUsableKeySecret } from './common/crypto.js';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

/** 32 bytes base64, or any random string of 40+ characters (key derived with HKDF). */
const keySecret = z
  .string()
  .refine(isUsableKeySecret, 'must be 32 bytes base64-encoded, or a random string of at least 40 characters');

const envSchema = z.object({
  APP_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_JSON: bool.optional(),

  /** Owner/migrator connection (Railway's DATABASE_URL). Used by migrations and backups. */
  DATABASE_URL: z.string().min(1).optional(),
  /** Runtime role. When DB_APP_PASSWORD is set, the app logs in as this role. */
  DB_APP_ROLE: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*$/)
    .default('hrms_app'),
  DB_APP_PASSWORD: z.string().min(24).optional(),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  /** Development only: embedded PostgreSQL (PGlite). A directory path or "memory://". */
  PGLITE_DIR: z.string().min(1).optional(),

  SESSION_SECRET: z.string().min(32),
  DATA_ENCRYPTION_KEY: keySecret,
  DATA_ENCRYPTION_KEY_ID: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,32}$/)
    .default('k1'),
  /** JSON object {keyId: base64Key} of retired keys still needed for decryption. */
  DATA_ENCRYPTION_OLD_KEYS: z.string().optional(),

  COOKIE_SECURE: bool.optional(),
  /** Number of trusted reverse-proxy hops (Railway edge = 1). 0 = trust none. */
  TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),
  PUBLIC_URL: z.url().optional(),
  WEB_DIST_DIR: z.string().optional(),

  BOOTSTRAP_ADMIN_USERNAME: z.string().optional(),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().optional(),
  BOOTSTRAP_ADMIN_DISPLAY_NAME: z.string().optional(),
  BOOTSTRAP_GROUP_NAME_AR: z.string().optional(),
  BOOTSTRAP_GROUP_NAME_EN: z.string().optional(),

  BACKUP_S3_ENDPOINT: z.url().optional(),
  BACKUP_S3_REGION: z.string().optional(),
  BACKUP_S3_BUCKET: z.string().optional(),
  BACKUP_S3_ACCESS_KEY_ID: z.string().optional(),
  BACKUP_S3_SECRET_ACCESS_KEY: z.string().optional(),
  BACKUP_S3_PREFIX: z.string().default('hrms'),
  BACKUP_ENCRYPTION_KEY: keySecret.optional(),
  BACKUP_ENCRYPTION_KEY_ID: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,32}$/)
    .default('b1'),
  /** Development/test only: write backups to a local directory instead of S3. */
  BACKUP_LOCAL_DIR: z.string().optional(),
});

export type RawConfig = z.infer<typeof envSchema>;

export interface AppConfig extends RawConfig {
  isProduction: boolean;
  cookieSecure: boolean;
  logJson: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${issues.join('\n')}`);
  }
  const raw = parsed.data;
  const isProduction = raw.APP_ENV === 'production';
  const deployed = raw.APP_ENV === 'production' || raw.APP_ENV === 'staging';
  const cfg: AppConfig = {
    ...raw,
    isProduction,
    cookieSecure: raw.COOKIE_SECURE ?? deployed,
    logJson: raw.LOG_JSON ?? deployed,
  };

  const problems: string[] = [];
  if (!cfg.DATABASE_URL && !cfg.PGLITE_DIR) problems.push('DATABASE_URL or PGLITE_DIR is required');
  if (deployed) {
    if (cfg.PGLITE_DIR) problems.push('PGLITE_DIR is not allowed outside development/test');
    if (!cfg.DATABASE_URL) problems.push('DATABASE_URL is required');
    if (!cfg.DB_APP_PASSWORD) problems.push('DB_APP_PASSWORD is required (least-privilege role)');
    if (!cfg.cookieSecure) problems.push('COOKIE_SECURE must be true');
    if (cfg.BACKUP_LOCAL_DIR) problems.push('BACKUP_LOCAL_DIR is not allowed outside development/test');
  }
  if (problems.length) throw new Error(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
  return cfg;
}
