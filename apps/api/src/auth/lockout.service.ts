import { Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { DATABASE } from '../common/tokens.js';
import type { Database, Tx } from '../db/database.js';
import { userAccount } from '../db/schema.js';
import type { Principal } from '../access/principal.js';
import { AuditService } from '../audit/audit.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { SessionService } from './session.service.js';

type LockoutPolicy = { maxFailures: number; lockMinutes: number };

/**
 * One failed-attempt counter per account (user_account.failed_login_count) shared by every secret
 * check: sign-in password, MFA codes, and re-entering the password or code inside a session
 * (password change, turning MFA off, restore step-up).
 */
@Injectable()
export class LockoutService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}

  policy(): Promise<LockoutPolicy> {
    return this.settings.get('security.lockout');
  }

  /** Atomic increment (concurrent requests cannot reuse an old value); returns the new count. */
  async countFailure(tx: Tx, userId: string): Promise<number> {
    const [r] = await tx
      .update(userAccount)
      .set({ failedLoginCount: sql`${userAccount.failedLoginCount} + 1` })
      .where(eq(userAccount.id, userId))
      .returning({ n: userAccount.failedLoginCount });
    return r?.n ?? 0;
  }

  /** Locks the account when the limit is reached; returns the lock end, or null. */
  async lockIfReached(tx: Tx, userId: string, failures: number, policy: LockoutPolicy): Promise<Date | null> {
    if (failures < policy.maxFailures) return null;
    const lockedUntil = new Date(Date.now() + policy.lockMinutes * 60_000);
    await tx.update(userAccount).set({ failedLoginCount: 0, lockedUntil }).where(eq(userAccount.id, userId));
    return lockedUntil;
  }

  /**
   * A wrong password or code inside a signed-in session. It counts toward the lockout; at the
   * limit the account is locked and all its sessions end. Returns true if the account was locked.
   */
  async failedSecret(principal: Principal, action: string): Promise<boolean> {
    const policy = await this.policy(); // read before opening the tx
    return this.database.system(async (tx) => {
      const failures = await this.countFailure(tx, principal.userId);
      const lockedUntil = await this.lockIfReached(tx, principal.userId, failures, policy);
      if (lockedUntil) await this.sessions.revokeAllForUser(tx, principal.userId, 'account_locked');
      await this.audit.record(tx, { action, outcome: 'failure', details: { failures, locked: !!lockedUntil } });
      if (lockedUntil) {
        await this.audit.record(tx, {
          action: 'auth.lockout',
          entityType: 'user',
          entityId: principal.userId,
          details: { lockedUntil, lockMinutes: policy.lockMinutes },
        });
      }
      return !!lockedUntil;
    });
  }
}
