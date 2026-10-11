import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gt, inArray, isNull, ne } from 'drizzle-orm';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { AttendanceDeviceDto } from '@hrms/shared';
import { DATABASE } from '../common/tokens.js';
import type { Database } from '../db/database.js';
import { attendanceDevice, authChallenge, employmentAssignment, userAccount, webauthnCredential } from '../db/schema.js';
import { ApiError } from '../common/errors.js';
import { randomToken, sha256 } from '../common/crypto.js';
import { uuidv7 } from '../common/ids.js';
import type { Principal } from '../access/principal.js';
import { AuditService } from '../audit/audit.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { PasswordService } from '../auth/password.service.js';
import type { AttendancePolicy } from './compute.js';

const MAX_PIN_FAILURES = 5;
const CHALLENGE_TTL_MS = 5 * 60_000;

/**
 * Attendance devices (ATT-03..05). Biometrics stay on the device: the server only stores a
 * WebAuthn public key (never fingerprint data). PINs are bound to a device token (C-06).
 */
@Injectable()
export class DevicesService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(PasswordService) private readonly passwords: PasswordService,
  ) {}

  private toDto(d: typeof attendanceDevice.$inferSelect, userName: string | null = null): AttendanceDeviceDto {
    return {
      id: d.id,
      userId: d.userId,
      userName,
      employeeId: d.employeeId,
      label: d.label,
      kind: d.kind,
      status: d.status,
      createdAt: d.createdAt.toISOString(),
      lastUsedAt: d.lastUsedAt?.toISOString() ?? null,
    };
  }

  private async employeeCompany(principal: Principal): Promise<string | null> {
    if (!principal.employeeId) return null;
    const [a] = await this.database.tx(principal.rls(), (tx) =>
      tx
        .select({ c: employmentAssignment.companyId })
        .from(employmentAssignment)
        .where(and(eq(employmentAssignment.employeeId, principal.employeeId!), isNull(employmentAssignment.validTo))),
    );
    return a?.c ?? null;
  }

  async myDevices(principal: Principal): Promise<AttendanceDeviceDto[]> {
    const rows = await this.database.tx(principal.rls(), (tx) =>
      tx
        .select()
        .from(attendanceDevice)
        .where(and(eq(attendanceDevice.userId, principal.userId), ne(attendanceDevice.status, 'revoked')))
        .orderBy(desc(attendanceDevice.createdAt)),
    );
    return rows.map((d) => this.toDto(d));
  }

  private async initialStatus(companyId: string | null): Promise<'pending' | 'approved'> {
    const policy = await this.settings.get('attendance.policy', companyId);
    return policy.deviceApproval ? 'pending' : 'approved';
  }

  // --- PIN ------------------------------------------------------------------------------

  async registerPin(principal: Principal, label: string, pin: string, userAgent: string | null): Promise<{ device: AttendanceDeviceDto; deviceToken: string }> {
    if (!principal.employeeId) throw ApiError.forbidden('Your account is not linked to an employee record');
    if (/^(\d)\1{3}$/.test(pin) || ['1234', '4321', '0123', '9876'].includes(pin)) {
      throw new ApiError(400, 'PASSWORD_POLICY', 'Choose a less predictable PIN', { meta: { reasons: ['too_common'], minLength: 4 } });
    }
    const companyId = await this.employeeCompany(principal);
    const status = await this.initialStatus(companyId);
    const token = randomToken(32);
    const pinHash = await this.passwords.hash(`${pin}:${token}`);
    const id = uuidv7();
    const row = await this.database.tx(principal.rls(), async (tx) => {
      const [d] = await tx
        .insert(attendanceDevice)
        .values({
          id,
          userId: principal.userId,
          employeeId: principal.employeeId,
          companyId,
          label,
          kind: 'pin',
          status,
          tokenHash: sha256(token),
          pinHash,
          userAgent: userAgent?.slice(0, 300) ?? null,
        })
        .returning();
      await this.audit.record(tx, { action: 'attendance.device_registered', entityType: 'attendance_device', entityId: id, companyId, details: { kind: 'pin', status } });
      return d!;
    });
    // The device token is shown once and kept only on this device.
    return { device: this.toDto(row), deviceToken: token };
  }

  // --- WebAuthn -----------------------------------------------------------------------------

  async registrationOptions(principal: Principal, rp: { rpId: string; rpName: string }) {
    const [user] = await this.database.system((tx) => tx.select().from(userAccount).where(eq(userAccount.id, principal.userId)));
    const creds = await this.database.tx(principal.rls(), (tx) =>
      tx.select({ id: webauthnCredential.credentialId, t: webauthnCredential.transports }).from(webauthnCredential).where(eq(webauthnCredential.userId, principal.userId)),
    );
    const options = await generateRegistrationOptions({
      rpName: rp.rpName,
      rpID: rp.rpId,
      userName: user!.username,
      userDisplayName: user!.displayName,
      userID: new TextEncoder().encode(user!.id),
      attestationType: 'none',
      excludeCredentials: creds.map((c) => ({ id: c.id, transports: c.t })),
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
    });
    await this.storeChallenge(principal, 'register', options.challenge);
    return options;
  }

  async verifyRegistration(
    principal: Principal,
    label: string,
    response: unknown,
    rp: { rpId: string; origin: string },
    userAgent: string | null,
  ): Promise<AttendanceDeviceDto> {
    if (!principal.employeeId) throw ApiError.forbidden('Your account is not linked to an employee record');
    const challenge = await this.takeChallenge(principal, 'register');
    let verified;
    try {
      verified = await verifyRegistrationResponse({
        response: response as RegistrationResponseJSON,
        expectedChallenge: challenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpId,
        requireUserVerification: true,
      });
    } catch (err) {
      throw ApiError.validation([{ path: 'response', message: (err as Error).message.slice(0, 200) }]);
    }
    if (!verified.verified) throw ApiError.validation([{ path: 'response', message: 'Registration could not be verified' }]);
    const info = verified.registrationInfo;
    const companyId = await this.employeeCompany(principal);
    const status = await this.initialStatus(companyId);
    const id = uuidv7();
    const row = await this.database.tx(principal.rls(), async (tx) => {
      const [d] = await tx
        .insert(attendanceDevice)
        .values({ id, userId: principal.userId, employeeId: principal.employeeId, companyId, label, kind: 'webauthn', status, userAgent: userAgent?.slice(0, 300) ?? null })
        .returning();
      await tx.insert(webauthnCredential).values({
        id: uuidv7(),
        deviceId: id,
        userId: principal.userId,
        credentialId: info.credential.id,
        publicKey: Buffer.from(info.credential.publicKey),
        counter: info.credential.counter,
        transports: info.credential.transports ?? [],
        rpId: rp.rpId,
      });
      await this.audit.record(tx, { action: 'attendance.device_registered', entityType: 'attendance_device', entityId: id, companyId, details: { kind: 'webauthn', status, rpId: rp.rpId } });
      return d!;
    });
    return this.toDto(row);
  }

  async authenticationOptions(principal: Principal, rp: { rpId: string }) {
    const creds = await this.database.tx(principal.rls(), (tx) =>
      tx
        .select({ id: webauthnCredential.credentialId, t: webauthnCredential.transports })
        .from(webauthnCredential)
        .innerJoin(attendanceDevice, eq(attendanceDevice.id, webauthnCredential.deviceId))
        .where(and(eq(webauthnCredential.userId, principal.userId), eq(attendanceDevice.status, 'approved'), eq(webauthnCredential.rpId, rp.rpId))),
    );
    if (!creds.length) throw ApiError.conflict('Register this device for attendance first');
    const options = await generateAuthenticationOptions({
      rpID: rp.rpId,
      allowCredentials: creds.map((c) => ({ id: c.id, transports: c.t as never })),
      userVerification: 'required',
    });
    await this.storeChallenge(principal, 'authenticate', options.challenge);
    return options;
  }

  private async storeChallenge(principal: Principal, purpose: 'register' | 'authenticate', challenge: string) {
    await this.database.tx(principal.rls(), (tx) =>
      tx.insert(authChallenge).values({ id: uuidv7(), userId: principal.userId, purpose, challenge, expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS) }),
    );
  }

  private async takeChallenge(principal: Principal, purpose: 'register' | 'authenticate'): Promise<string> {
    return this.database.tx(principal.rls(), async (tx) => {
      const [c] = await tx
        .select()
        .from(authChallenge)
        .where(and(eq(authChallenge.userId, principal.userId), eq(authChallenge.purpose, purpose), isNull(authChallenge.usedAt), gt(authChallenge.expiresAt, new Date())))
        .orderBy(desc(authChallenge.expiresAt))
        .limit(1);
      if (!c) throw ApiError.validation([{ path: 'response', message: 'The verification expired; try again' }]);
      await tx.update(authChallenge).set({ usedAt: new Date() }).where(eq(authChallenge.id, c.id));
      return c.challenge;
    });
  }

  // --- verification at punch time ---------------------------------------------------------------

  async verifyForPunch(
    principal: Principal,
    input: { assertion?: Record<string, unknown> | undefined; deviceToken?: string | undefined; pin?: string | undefined },
    rp: { rpId: string; origin: string },
    policy: AttendancePolicy,
  ): Promise<{ method: 'webauthn' | 'pin'; deviceId: string }> {
    const allowWebauthn = policy.verification === 'webauthn' || policy.verification === 'webauthn_or_pin';
    const allowPin = policy.verification === 'pin' || policy.verification === 'webauthn_or_pin';
    if (input.assertion && allowWebauthn) return this.verifyAssertion(principal, input.assertion, rp);
    if (input.deviceToken && input.pin && allowPin) return this.verifyPin(principal, input.deviceToken, input.pin);
    throw new ApiError(403, 'FORBIDDEN', 'Device verification is required to record attendance', {
      meta: { reason: 'verification_required', verification: policy.verification },
    });
  }

  private async verifyAssertion(principal: Principal, assertion: Record<string, unknown>, rp: { rpId: string; origin: string }) {
    const response = assertion as unknown as AuthenticationResponseJSON;
    const [cred] = await this.database.tx(principal.rls(), (tx) =>
      tx
        .select({ c: webauthnCredential, d: attendanceDevice })
        .from(webauthnCredential)
        .innerJoin(attendanceDevice, eq(attendanceDevice.id, webauthnCredential.deviceId))
        .where(and(eq(webauthnCredential.credentialId, String(response.id ?? '')), eq(webauthnCredential.userId, principal.userId))),
    );
    if (!cred || cred.d.status !== 'approved') throw ApiError.forbidden('This device is not approved for attendance');
    const challenge = await this.takeChallenge(principal, 'authenticate');
    let result;
    try {
      result = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpId,
        credential: { id: cred.c.credentialId, publicKey: new Uint8Array(cred.c.publicKey), counter: cred.c.counter, transports: cred.c.transports as never },
        requireUserVerification: true,
      });
    } catch (err) {
      throw ApiError.forbidden(`Device verification failed: ${(err as Error).message.slice(0, 120)}`);
    }
    if (!result.verified) throw ApiError.forbidden('Device verification failed');
    await this.database.tx(principal.rls(), async (tx) => {
      await tx.update(webauthnCredential).set({ counter: result.authenticationInfo.newCounter, lastUsedAt: new Date() }).where(eq(webauthnCredential.id, cred.c.id));
      await tx.update(attendanceDevice).set({ lastUsedAt: new Date() }).where(eq(attendanceDevice.id, cred.d.id));
    });
    return { method: 'webauthn' as const, deviceId: cred.d.id };
  }

  private async verifyPin(principal: Principal, token: string, pin: string) {
    const [d] = await this.database.tx(principal.rls(), (tx) =>
      tx
        .select()
        .from(attendanceDevice)
        .where(and(eq(attendanceDevice.userId, principal.userId), eq(attendanceDevice.kind, 'pin'), eq(attendanceDevice.tokenHash, sha256(token)))),
    );
    if (!d || d.status !== 'approved') throw ApiError.forbidden('This device is not approved for attendance');
    const ok = await this.passwords.verify(d.pinHash!, `${pin}:${token}`);
    if (!ok) {
      const failures = d.pinFailures + 1;
      const disable = failures >= MAX_PIN_FAILURES;
      await this.database.tx(principal.rls(), async (tx) => {
        await tx
          .update(attendanceDevice)
          .set(disable ? { pinFailures: failures, status: 'revoked', revokedAt: new Date() } : { pinFailures: failures })
          .where(eq(attendanceDevice.id, d.id));
        await this.audit.record(tx, { action: 'attendance.pin_failed', outcome: 'failure', entityType: 'attendance_device', entityId: d.id, details: { failures, disabled: disable } });
      });
      throw new ApiError(403, 'FORBIDDEN', disable ? 'Too many wrong PINs: the PIN was disabled on this device' : 'Wrong PIN', {
        meta: { reason: disable ? 'pin_disabled' : 'pin_wrong' },
      });
    }
    await this.database.tx(principal.rls(), (tx) =>
      tx.update(attendanceDevice).set({ pinFailures: 0, lastUsedAt: new Date() }).where(eq(attendanceDevice.id, d.id)),
    );
    return { method: 'pin' as const, deviceId: d.id };
  }

  // --- administration (ATT-05) ---------------------------------------------------------------

  async companyDevices(principal: Principal, companyId: string): Promise<AttendanceDeviceDto[]> {
    if (!principal.canCompany('attendance.device.manage', companyId)) throw ApiError.notFound('Company');
    const rows = await this.database.tx(principal.rls(), (tx) =>
      tx
        .select({ d: attendanceDevice, name: userAccount.displayName })
        .from(attendanceDevice)
        .innerJoin(userAccount, eq(userAccount.id, attendanceDevice.userId))
        .where(and(eq(attendanceDevice.companyId, companyId), inArray(attendanceDevice.status, ['pending', 'approved'])))
        .orderBy(desc(attendanceDevice.createdAt)),
    );
    return rows.map(({ d, name }) => this.toDto(d, name));
  }

  async setStatus(principal: Principal, id: string, action: 'approve' | 'revoke'): Promise<void> {
    await this.database.tx(principal.rls(), async (tx) => {
      const [d] = await tx.select().from(attendanceDevice).where(eq(attendanceDevice.id, id));
      if (!d) throw ApiError.notFound('Device');
      const own = d.userId === principal.userId;
      const admin = !!d.companyId && principal.canCompany('attendance.device.manage', d.companyId);
      // Users can revoke their own devices; only staff approve.
      if (!(admin || (own && action === 'revoke'))) throw ApiError.notFound('Device');
      if (action === 'approve' && own) throw ApiError.forbidden('Devices cannot be approved by their owner');
      await tx
        .update(attendanceDevice)
        .set(
          action === 'approve'
            ? { status: 'approved', approvedBy: principal.userId, approvedAt: new Date() }
            : { status: 'revoked', revokedBy: principal.userId, revokedAt: new Date() },
        )
        .where(eq(attendanceDevice.id, id));
      await this.audit.record(tx, { action: `attendance.device_${action === 'approve' ? 'approved' : 'revoked'}`, entityType: 'attendance_device', entityId: id, companyId: d.companyId });
    });
  }
}
