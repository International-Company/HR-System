import { sql } from 'drizzle-orm';
import type { Database } from '../db/database.js';
import { hmacSha256 } from './crypto.js';

/**
 * Fixed-window rate limiter kept in the database (table rate_limit), so the limit holds across
 * processes, restarts and replicas. Keys are stored as HMACs only. Account lockout in
 * user_account remains the authoritative brute-force control.
 */
export class RateLimiter {
  constructor(
    private readonly database: Database,
    private readonly secret: string,
    private readonly scope: string,
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Counts one hit atomically; returns true if the action is allowed. */
  async hit(key: string): Promise<boolean> {
    const k = this.keyOf(key);
    const result = await this.database.system((tx) =>
      tx.execute<{ hits: number }>(sql`
        insert into rate_limit (key, hits, reset_at)
        values (${k}, 1, now() + ${this.windowMs} * interval '1 millisecond')
        on conflict (key) do update set
          hits = case when rate_limit.reset_at <= now() then 1 else rate_limit.hits + 1 end,
          reset_at = case when rate_limit.reset_at <= now() then excluded.reset_at else rate_limit.reset_at end
        returning hits`),
    );
    const hits = (result as unknown as { rows: { hits: number }[] }).rows[0]?.hits ?? 1;
    return hits <= this.limit;
  }

  /** Clears one key (or, without a key, every key; tests only). */
  async reset(key?: string): Promise<void> {
    await this.database.system((tx) =>
      key === undefined ? tx.execute(sql`delete from rate_limit`) : tx.execute(sql`delete from rate_limit where key = ${this.keyOf(key)}`),
    );
  }

  private keyOf(key: string): Buffer {
    return hmacSha256(this.secret, `rate:${this.scope}:${key}`);
  }
}

/** Removes expired windows (daily maintenance). */
export async function pruneRateLimits(database: Database): Promise<void> {
  await database.system((tx) => tx.execute(sql`delete from rate_limit where reset_at < now()`));
}
