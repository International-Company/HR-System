import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import type { SessionState } from '@hrms/shared';
import { CONFIG, DATABASE } from '../common/tokens.js';
import type { AppConfig } from '../config.js';
import type { Database, Tx } from '../db/database.js';
import { session, userAccount } from '../db/schema.js';
import { hmacSha256, randomToken, safeEqual, sha256 } from '../common/crypto.js';
import { uuidv7 } from '../common/ids.js';
import { SettingsService } from '../settings/settings.service.js';

export type SessionRow = typeof session.$inferSelect;
export type UserRow = typeof userAccount.$inferSelect;

export interface ResolvedSession {
  session: SessionRow;
  user: UserRow;
}

const TOUCH_INTERVAL_MS = 60_000;

/** Server-side sessions (D-07): opaque random token in an HttpOnly cookie, SHA-256 in the DB. */
@Injectable()
export class SessionService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(SettingsService) private readonly settings: SettingsService,
  ) {}

  get cookieName(): string {
    // The __Host- prefix forces Secure, Path=/ and no Domain attribute.
    return this.config.cookieSecure ? '__Host-hrms_sid' : 'hrms_sid';
  }

  /**
   * Must not query the database outside `tx` (PGlite has a single connection, so a nested
   * transaction would deadlock): callers pass the session lifetime in.
   */
  async create(
    tx: Tx,
    userId: string,
    meta: { ip: string | null; userAgent: string | null },
    absoluteHours: number,
  ): Promise<{ token: string; session: SessionRow }> {
    const token = randomToken(32);
    const [row] = await tx
      .insert(session)
      .values({
        id: uuidv7(),
        userId,
        tokenHash: sha256(token),
        expiresAt: new Date(Date.now() + absoluteHours * 3_600_000),
        ip: meta.ip,
        userAgent: meta.userAgent?.slice(0, 500) ?? null,
      })
      .returning();
    return { token, session: row! };
  }

  /** Resolve a cookie token; returns null if missing, revoked, expired, idle or user disabled. */
  async resolve(token: string | undefined): Promise<ResolvedSession | null> {
    if (!token || token.length > 200) return null;
    const policy = await this.settings.get('security.session');
    const now = Date.now();
    return this.database.system(async (tx) => {
      const [row] = await tx
        .select({ s: session, u: userAccount })
        .from(session)
        .innerJoin(userAccount, eq(userAccount.id, session.userId))
        .where(and(eq(session.tokenHash, sha256(token)), isNull(session.revokedAt)));
      if (!row) return null;
      const { s, u } = row;
      let reason: string | null = null;
      if (u.status !== 'active') reason = 'user_disabled';
      else if (s.expiresAt.getTime() <= now) reason = 'expired';
      else if (s.lastSeenAt.getTime() + policy.idleMinutes * 60_000 <= now) reason = 'idle_timeout';
      if (reason) {
        await tx
          .update(session)
          .set({ revokedAt: new Date(), revokedReason: reason })
          .where(eq(session.id, s.id));
        return null;
      }
      if (now - s.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
        await tx.update(session).set({ lastSeenAt: new Date() }).where(eq(session.id, s.id));
      }
      return { session: s, user: u };
    });
  }

  computeState(
    user: UserRow,
    s: SessionRow,
    roleKeys: ReadonlySet<string>,
    mfaRequiredRoles: readonly string[],
  ): SessionState {
    if (user.totpEnabledAt && !s.mfaVerifiedAt) return 'mfa_required';
    if (user.mustChangePassword) return 'password_change_required';
    if (!user.totpEnabledAt && mfaRequiredRoles.some((r) => roleKeys.has(r))) {
      return 'mfa_setup_required';
    }
    return 'active';
  }

  /** Stateless CSRF token bound to the session (synchroniser-token pattern). */
  csrfToken(sessionId: string): string {
    return hmacSha256(this.config.SESSION_SECRET, `csrf:${sessionId}`).toString('base64url');
  }

  checkCsrf(sessionId: string, provided: string | undefined): boolean {
    return !!provided && safeEqual(this.csrfToken(sessionId), provided);
  }

  async revoke(tx: Tx, sessionId: string, reason: string): Promise<void> {
    await tx
      .update(session)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(and(eq(session.id, sessionId), isNull(session.revokedAt)));
  }

  async revokeAllForUser(
    tx: Tx,
    userId: string,
    reason: string,
    exceptSessionId?: string,
  ): Promise<number> {
    const rows = await tx
      .update(session)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(
        and(
          eq(session.userId, userId),
          isNull(session.revokedAt),
          exceptSessionId ? ne(session.id, exceptSessionId) : sql`true`,
        ),
      )
      .returning({ id: session.id });
    return rows.length;
  }

  async listActive(userId: string): Promise<SessionRow[]> {
    const policy = await this.settings.get('security.session');
    const rows = await this.database.system((tx) =>
      tx
        .select()
        .from(session)
        .where(and(eq(session.userId, userId), isNull(session.revokedAt))),
    );
    const now = Date.now();
    return rows
      .filter(
        (s) =>
          s.expiresAt.getTime() > now &&
          s.lastSeenAt.getTime() + policy.idleMinutes * 60_000 > now,
      )
      .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime());
  }
}
