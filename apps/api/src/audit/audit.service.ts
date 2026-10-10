import { Inject, Injectable } from '@nestjs/common';
import { DATABASE } from '../common/tokens.js';
import type { Database, Tx } from '../db/database.js';
import { auditEvent } from '../db/schema.js';
import { requestContext } from '../common/request-context.js';

export interface AuditInput {
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  companyId?: string | null;
  before?: unknown;
  after?: unknown;
  outcome?: 'success' | 'denied' | 'failure';
  details?: Record<string, unknown> | null;
  /** Override the actor (e.g. failed login for a known user, system jobs). */
  actor?: { userId: string | null; username: string | null };
}

const SECRET_KEY = /(password|secret|token|totp|recovery|codehash|enc$)/i;

/** Remove secret-looking fields before anything reaches the audit log. */
export function redact(value: unknown): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (Array.isArray(value)) return value.map(redact);
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return '[binary]';
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? '[redacted]' : redact(v);
    }
    return out;
  }
  return value;
}

/** Append-only, hash-chained audit trail (AUD-01..04). */
@Injectable()
export class AuditService {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  /** Record inside the caller's transaction: rolled back together with the change. */
  async record(tx: Tx, input: AuditInput): Promise<void> {
    const ctx = requestContext.get();
    const actorUserId =
      input.actor !== undefined ? input.actor.userId : (ctx?.actorUserId ?? null);
    const actorUsername =
      input.actor !== undefined ? input.actor.username : (ctx?.actorUsername ?? null);
    await tx.insert(auditEvent).values({
      // id, at, prev_hash and hash are assigned by the chain trigger.
      id: 0,
      at: new Date(),
      hash: Buffer.alloc(0),
      actorUserId,
      actorUsername,
      sessionId: ctx?.sessionId ?? null,
      action: input.action,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      companyId: input.companyId ?? null,
      before: (redact(input.before) ?? null) as object | null,
      after: (redact(input.after) ?? null) as object | null,
      ip: ctx?.ip ?? null,
      userAgent: ctx?.userAgent?.slice(0, 500) ?? null,
      outcome: input.outcome ?? 'success',
      details: (redact(input.details) ?? null) as object | null,
    });
  }

  /** Record in its own transaction (for denials and failures whose main tx is rolled back). */
  async recordStandalone(input: AuditInput): Promise<void> {
    await this.database.system((tx) => this.record(tx, input));
  }
}
