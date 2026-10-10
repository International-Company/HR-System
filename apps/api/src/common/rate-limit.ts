/**
 * Small fixed-window rate limiter (in-memory, per process). Sufficient for a single
 * web replica; account lockout in the database is the authoritative brute-force control.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  private lastSweep = Date.now();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Returns true if the action is allowed. */
  hit(key: string, now = Date.now()): boolean {
    this.sweep(now);
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }

  reset(): void {
    this.hits.clear();
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < this.windowMs) return;
    this.lastSweep = now;
    for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
  }
}
