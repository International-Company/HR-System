import { Inject, Injectable } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { SessionDto, SessionInfo } from '@hrms/shared';
import { CONFIG, DATABASE, ENCRYPTOR } from '../common/tokens.js';
import type { AppConfig } from '../config.js';
import type { Database, Tx } from '../db/database.js';
import { mfaRecoveryCode, session, userAccount } from '../db/schema.js';
import { ApiError } from '../common/errors.js';
import { hmacSha256, type Encryptor } from '../common/crypto.js';
import { uuidv7 } from '../common/ids.js';
import { RateLimiter } from '../common/rate-limit.js';
import type { Principal } from '../access/principal.js';
import { AuditService } from '../audit/audit.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { PasswordService } from './password.service.js';
import { SessionService, type UserRow } from './session.service.js';
import { LockoutService } from './lockout.service.js';
import { generateTotpSecret, otpauthUrl, verifyTotp } from './totp.js';

const MAX_MFA_ATTEMPTS = 5;
const RECOVERY_CODE_COUNT = 10;

export interface ClientMeta {
  ip: string | null;
  userAgent: string | null;
}

@Injectable()
export class AuthService {
  readonly ipLimiter: RateLimiter;
  readonly userLimiter: RateLimiter;

  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(ENCRYPTOR) private readonly encryptor: Encryptor,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(LockoutService) private readonly lockout: LockoutService,
  ) {
    // Shared across processes (database), so the limits hold with several replicas.
    this.ipLimiter = new RateLimiter(database, config.SESSION_SECRET, 'login-ip', 30, 5 * 60_000);
    this.userLimiter = new RateLimiter(database, config.SESSION_SECRET, 'login-user', 15, 5 * 60_000);
  }

  /** AUTH-01, AUTH-06: password login with lockout. Returns the new session token. */
  async login(username: string, password: string, meta: ClientMeta): Promise<{ token: string }> {
    const uname = username.trim().toLowerCase();
    if (!(await this.ipLimiter.hit(meta.ip ?? 'unknown')) || !(await this.userLimiter.hit(uname))) {
      await this.audit.recordStandalone({
        action: 'auth.login',
        outcome: 'denied',
        actor: { userId: null, username: null },
        details: { username: uname, reason: 'rate_limited' },
      });
      throw new ApiError(429, 'AUTH_RATE_LIMITED', 'Too many attempts. Try again later.');
    }

    const [user] = await this.database.system((tx) =>
      tx.select().from(userAccount).where(eq(userAccount.username, uname)),
    );
    if (!user) {
      await this.passwords.verifyDummy(password);
      await this.audit.recordStandalone({
        action: 'auth.login',
        outcome: 'failure',
        actor: { userId: null, username: null },
        details: { username: uname, reason: 'unknown_user' },
      });
      throw this.invalidCredentials();
    }
    const actor = { userId: user.id, username: user.username };

    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      await this.audit.recordStandalone({
        action: 'auth.login',
        outcome: 'denied',
        actor,
        details: { reason: 'locked' },
      });
      throw new ApiError(423, 'AUTH_LOCKED', 'The account is temporarily locked', {
        meta: { lockedUntil: user.lockedUntil.toISOString() },
      });
    }

    const ok = await this.passwords.verify(user.passwordHash, password);
    if (!ok) {
      const lockout = await this.lockout.policy(); // read before opening the tx
      let failures = 0;
      let lock = false;
      let lockedUntil: Date | null = null;
      await this.database.system(async (tx) => {
        failures = await this.lockout.countFailure(tx, user.id);
        lockedUntil = await this.lockout.lockIfReached(tx, user.id, failures, lockout);
        lock = !!lockedUntil;
        await this.audit.record(tx, {
          action: 'auth.login',
          outcome: 'failure',
          actor,
          details: { reason: 'bad_password', failures },
        });
        if (lock) {
          await this.audit.record(tx, {
            action: 'auth.lockout',
            entityType: 'user',
            entityId: user.id,
            actor,
            details: { lockedUntil, lockMinutes: lockout.lockMinutes },
          });
        }
      });
      if (lock) {
        throw new ApiError(423, 'AUTH_LOCKED', 'The account is temporarily locked', {
          meta: { lockedUntil: (lockedUntil as Date | null)?.toISOString() },
        });
      }
      throw this.invalidCredentials();
    }

    if (user.status !== 'active') {
      await this.audit.recordStandalone({
        action: 'auth.login',
        outcome: 'denied',
        actor,
        details: { reason: 'disabled' },
      });
      // Same answer as a wrong password: a correct password of a disabled account is not revealed.
      throw this.invalidCredentials();
    }

    const sessionPolicy = await this.settings.get('security.session');
    return this.database.system(async (tx) => {
      await tx
        .update(userAccount)
        .set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() })
        .where(eq(userAccount.id, user.id));
      const created = await this.sessions.create(tx, user.id, meta, sessionPolicy.absoluteHours);
      await this.audit.record(tx, {
        action: 'auth.login',
        actor,
        entityType: 'session',
        entityId: created.session.id,
        details: { mfaPending: !!user.totpEnabledAt },
      });
      return { token: created.token };
    });
  }

  private invalidCredentials(): ApiError {
    return new ApiError(401, 'AUTH_INVALID_CREDENTIALS', 'Incorrect username or password');
  }

  async logout(principal: Principal): Promise<void> {
    await this.database.system(async (tx) => {
      await this.sessions.revoke(tx, principal.sessionId, 'logout');
      await this.audit.record(tx, {
        action: 'auth.logout',
        entityType: 'session',
        entityId: principal.sessionId,
      });
    });
  }

  async sessionInfo(principal: Principal): Promise<SessionInfo> {
    const [row] = await this.database.system((tx) =>
      tx
        .select({ u: userAccount, s: session })
        .from(userAccount)
        .innerJoin(session, eq(session.id, principal.sessionId))
        .where(eq(userAccount.id, principal.userId)),
    );
    if (!row) throw new ApiError(401, 'AUTH_REQUIRED');
    const roles = await this.database.system((tx) =>
      tx.execute<{ key: string; scope_type: string; company_id: string | null }>(
        // Lightweight read for the UI header; authorization never relies on it.
        sqlRoles(principal.userId),
      ),
    );
    return {
      state: principal.state,
      csrfToken: this.sessions.csrfToken(principal.sessionId),
      user: {
        id: row.u.id,
        username: row.u.username,
        displayName: row.u.displayName,
        email: row.u.email,
        mfaEnabled: !!row.u.totpEnabledAt,
        employeeId: row.u.employeeId,
      },
      permissions: principal.permissions(),
      roles: rowsOf<{ key: string; scope_type: string; company_id: string | null }>(roles).map((r) => ({
        key: r.key,
        scopeType: r.scope_type as SessionInfo['roles'][number]['scopeType'],
        companyId: r.company_id,
      })),
      expiresAt: row.s.expiresAt.toISOString(),
    };
  }

  async changePassword(
    principal: Principal,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const user = await this.loadUser(principal.userId);
    if (!(await this.passwords.verify(user.passwordHash, currentPassword))) {
      await this.wrongSecret(principal, 'auth.password_change');
      throw new ApiError(400, 'PASSWORD_INCORRECT', 'The current password is incorrect');
    }
    const policy = await this.settings.get('security.passwordPolicy');
    this.passwords.assertPolicy(newPassword, { ...policy, username: user.username });
    if (await this.passwords.verify(user.passwordHash, newPassword)) {
      throw new ApiError(400, 'PASSWORD_POLICY', 'Choose a password different from the current one', {
        meta: { reasons: ['same_as_current'], minLength: policy.minLength },
      });
    }
    const passwordHash = await this.passwords.hash(newPassword);
    await this.database.system(async (tx) => {
      await tx
        .update(userAccount)
        .set({
          passwordHash,
          passwordChangedAt: new Date(),
          mustChangePassword: false,
          failedLoginCount: 0,
          updatedBy: user.id,
        })
        .where(eq(userAccount.id, user.id));
      const revoked = await this.sessions.revokeAllForUser(
        tx,
        user.id,
        'password_changed',
        principal.sessionId,
      );
      await this.audit.record(tx, {
        action: 'auth.password_change',
        entityType: 'user',
        entityId: user.id,
        details: { otherSessionsRevoked: revoked },
      });
    });
  }

  // --- MFA (TOTP) -----------------------------------------------------------

  async startTotpSetup(principal: Principal): Promise<{ secret: string; otpauthUrl: string }> {
    const user = await this.loadUser(principal.userId);
    if (user.totpEnabledAt) throw ApiError.conflict('MFA is already enabled');
    const secret = generateTotpSecret();
    await this.database.system(async (tx) => {
      await tx
        .update(userAccount)
        .set({ totpPendingEnc: this.encryptor.encrypt(secret, `totp:${user.id}`) })
        .where(eq(userAccount.id, user.id));
    });
    const issuer = (await this.settings.publicSettings()).groupName?.en ?? 'HRMS';
    return { secret, otpauthUrl: otpauthUrl(secret, user.username, issuer) };
  }

  async confirmTotpSetup(principal: Principal, code: string): Promise<{ recoveryCodes: string[] }> {
    const user = await this.loadUser(principal.userId);
    if (user.totpEnabledAt) throw ApiError.conflict('MFA is already enabled');
    if (!user.totpPendingEnc) throw ApiError.conflict('Start MFA setup first');
    const secret = this.encryptor.decryptString(user.totpPendingEnc, `totp:${user.id}`);
    const step = verifyTotp(secret, code);
    if (step === null) throw new ApiError(400, 'MFA_INVALID', 'The code is not valid');

    const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, () => formatRecoveryCode());
    await this.database.system(async (tx) => {
      await tx
        .update(userAccount)
        .set({
          totpSecretEnc: this.encryptor.encrypt(secret, `totp:${user.id}`),
          totpPendingEnc: null,
          totpEnabledAt: new Date(),
          totpLastStep: step,
        })
        .where(eq(userAccount.id, user.id));
      await tx
        .update(mfaRecoveryCode)
        .set({ usedAt: new Date() })
        .where(and(eq(mfaRecoveryCode.userId, user.id), isNull(mfaRecoveryCode.usedAt)));
      await tx.insert(mfaRecoveryCode).values(
        recoveryCodes.map((c) => ({
          id: uuidv7(),
          userId: user.id,
          codeHash: this.hashRecoveryCode(c),
        })),
      );
      // The current session proved possession of the new factor.
      await tx
        .update(session)
        .set({ mfaVerifiedAt: new Date() })
        .where(eq(session.id, principal.sessionId));
      await this.audit.record(tx, { action: 'auth.mfa_enabled', entityType: 'user', entityId: user.id });
    });
    return { recoveryCodes };
  }

  /** A wrong password or code inside a session: counts toward the lockout (ends all sessions at the limit). */
  private async wrongSecret(principal: Principal, action: string): Promise<void> {
    if (await this.lockout.failedSecret(principal, action)) {
      throw new ApiError(401, 'AUTH_REQUIRED', 'Too many failed attempts. The account is temporarily locked.');
    }
  }

  async verifyMfa(
    principal: Principal,
    input: { code: string } | { recoveryCode: string },
  ): Promise<void> {
    const user = await this.loadUser(principal.userId);
    if (!user.totpSecretEnc) throw ApiError.conflict('MFA is not enabled');

    let ok: boolean;
    let method = 'totp';
    let usedStep: number | null = null;
    if ('code' in input) {
      const secret = this.encryptor.decryptString(user.totpSecretEnc, `totp:${user.id}`);
      usedStep = verifyTotp(secret, input.code, { lastUsedStep: user.totpLastStep });
      ok = usedStep !== null;
    } else {
      method = 'recovery_code';
      // Typed codes may mix up look-alike characters (O/0, I/1/L): every reading is tried.
      const hashes = recoveryCandidates(normalizeRecoveryCode(input.recoveryCode)).map((c) => this.hashRecoveryCode(c));
      ok = await this.database.system(async (tx) => {
        const [match] = await tx
          .select({ id: mfaRecoveryCode.id })
          .from(mfaRecoveryCode)
          .where(and(eq(mfaRecoveryCode.userId, user.id), inArray(mfaRecoveryCode.codeHash, hashes), isNull(mfaRecoveryCode.usedAt)))
          .limit(1)
          .for('update');
        if (!match) return false;
        const used = await tx
          .update(mfaRecoveryCode)
          .set({ usedAt: new Date() })
          .where(and(eq(mfaRecoveryCode.id, match.id), isNull(mfaRecoveryCode.usedAt)))
          .returning({ id: mfaRecoveryCode.id });
        return used.length === 1;
      });
    }

    if (!ok) {
      const lockout = await this.lockout.policy();
      const revoked = await this.database.system(async (tx) => {
        const [s] = await tx
          .update(session)
          .set({ mfaFailedAttempts: sql`${session.mfaFailedAttempts} + 1` })
          .where(eq(session.id, principal.sessionId))
          .returning({ attempts: session.mfaFailedAttempts });
        const attempts = s?.attempts ?? MAX_MFA_ATTEMPTS;
        // Wrong codes also count toward the account lockout (no unlimited retries by signing in again).
        const accountFailures = await this.lockout.countFailure(tx, user.id);
        const lockAccount = !!(await this.lockout.lockIfReached(tx, user.id, accountFailures, lockout));
        const kill = attempts >= MAX_MFA_ATTEMPTS || lockAccount;
        if (kill) await this.sessions.revoke(tx, principal.sessionId, lockAccount ? 'account_locked' : 'mfa_attempts_exceeded');
        await this.audit.record(tx, {
          action: 'auth.mfa_verify',
          outcome: 'failure',
          details: { method, attempts, sessionRevoked: kill },
        });
        return kill;
      });
      if (revoked) throw new ApiError(401, 'AUTH_REQUIRED', 'Too many invalid codes. Sign in again.');
      throw new ApiError(400, 'MFA_INVALID', 'The code is not valid');
    }

    await this.database.system(async (tx) => {
      if (usedStep !== null) {
        await tx.update(userAccount).set({ totpLastStep: usedStep }).where(eq(userAccount.id, user.id));
      }
      await tx
        .update(session)
        .set({ mfaVerifiedAt: new Date() })
        .where(eq(session.id, principal.sessionId));
      await this.audit.record(tx, { action: 'auth.mfa_verify', details: { method } });
    });
  }

  async disableOwnTotp(principal: Principal, password: string, code: string): Promise<void> {
    const user = await this.loadUser(principal.userId);
    if (!user.totpSecretEnc) throw ApiError.conflict('MFA is not enabled');
    const mfa = await this.settings.get('security.mfa');
    if (mfa.requiredForRoles.some((r) => principal.roleKeys.has(r))) {
      throw new ApiError(403, 'MFA_REQUIRED_BY_POLICY', 'MFA is required for your role');
    }
    if (!(await this.passwords.verify(user.passwordHash, password))) {
      await this.wrongSecret(principal, 'auth.mfa_disable');
      throw new ApiError(400, 'PASSWORD_INCORRECT', 'The current password is incorrect');
    }
    const secret = this.encryptor.decryptString(user.totpSecretEnc, `totp:${user.id}`);
    if (verifyTotp(secret, code, { lastUsedStep: user.totpLastStep }) === null) {
      await this.wrongSecret(principal, 'auth.mfa_disable');
      throw new ApiError(400, 'MFA_INVALID', 'The code is not valid');
    }
    await this.database.system(async (tx) => {
      await clearTotp(tx, user.id);
      await this.audit.record(tx, { action: 'auth.mfa_disabled', entityType: 'user', entityId: user.id });
    });
  }

  async listOwnSessions(principal: Principal): Promise<SessionDto[]> {
    const rows = await this.sessions.listActive(principal.userId);
    return rows.map((s) => toSessionDto(s, principal.sessionId));
  }

  async revokeOwnSession(principal: Principal, sessionId: string): Promise<void> {
    await this.database.system(async (tx) => {
      const rows = await tx
        .update(session)
        .set({ revokedAt: new Date(), revokedReason: 'revoked_by_user' })
        .where(
          and(
            eq(session.id, sessionId),
            eq(session.userId, principal.userId),
            isNull(session.revokedAt),
          ),
        )
        .returning({ id: session.id });
      if (!rows.length) throw ApiError.notFound('Session');
      await this.audit.record(tx, { action: 'auth.session_revoked', entityType: 'session', entityId: sessionId });
    });
  }

  private async loadUser(id: string): Promise<UserRow> {
    const [user] = await this.database.system((tx) =>
      tx.select().from(userAccount).where(eq(userAccount.id, id)),
    );
    if (!user) throw new ApiError(401, 'AUTH_REQUIRED');
    return user;
  }

  hashRecoveryCode(code: string): Buffer {
    return hmacSha256(this.config.SESSION_SECRET, `recovery:${normalizeRecoveryCode(code)}`);
  }
}

export async function clearTotp(tx: Tx, userId: string): Promise<void> {
  await tx
    .update(userAccount)
    .set({ totpSecretEnc: null, totpPendingEnc: null, totpEnabledAt: null, totpLastStep: null })
    .where(eq(userAccount.id, userId));
  await tx
    .update(mfaRecoveryCode)
    .set({ usedAt: new Date() })
    .where(and(eq(mfaRecoveryCode.userId, userId), isNull(mfaRecoveryCode.usedAt)));
}

/** Characters that cannot be mistaken for one another when read or typed (no 0/O, 1/I/L, U/V). */
const RECOVERY_ALPHABET = '23456789ABCDEFGHJKMNPQRSTWXYZ';

function formatRecoveryCode(): string {
  const raw = Array.from({ length: 10 }, () => RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)]).join('');
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

/** Upper case, Western digits (Arabic-Indic and Persian digits accepted), letters and digits only. */
export function normalizeRecoveryCode(code: string): string {
  return code
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

/** The typed code plus its look-alike readings (codes issued before the safe alphabet contain them). */
export function recoveryCandidates(normalized: string): string[] {
  const groups: Record<string, string[]> = { '0': ['0', 'O'], O: ['0', 'O'], '1': ['1', 'I', 'L'], I: ['1', 'I', 'L'], L: ['1', 'I', 'L'] };
  let out = [''];
  for (const ch of normalized) {
    const options = groups[ch] ?? [ch];
    out = out.flatMap((prefix) => options.map((o) => prefix + o));
    if (out.length > 512) return [normalized];
  }
  return out;
}

export function toSessionDto(s: typeof session.$inferSelect, currentId?: string): SessionDto {
  return {
    id: s.id,
    createdAt: s.createdAt.toISOString(),
    lastSeenAt: s.lastSeenAt.toISOString(),
    expiresAt: s.expiresAt.toISOString(),
    ip: s.ip,
    userAgent: s.userAgent,
    current: s.id === currentId,
  };
}

function sqlRoles(userId: string) {
  return sql`select r.key, a.scope_type, a.company_id
    from role_assignment a join role r on r.id = a.role_id
    where a.user_id = ${userId} and a.ended_at is null
      and a.valid_from <= current_date and (a.valid_to is null or a.valid_to >= current_date)
    order by r.key`;
}

function rowsOf<T>(result: unknown): T[] {
  // node-postgres returns { rows }, PGlite returns { rows } as well.
  return ((result as { rows?: T[] }).rows ?? (result as T[])) as T[];
}
