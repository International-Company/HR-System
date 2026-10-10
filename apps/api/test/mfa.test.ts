import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API, TEST_PASSWORD, setup, type TestEnv } from './helpers.js';
import { currentStep, totpAt, verifyTotp, base32Decode, base32Encode, hotp } from '../src/auth/totp.js';

describe('TOTP primitives (RFC 6238)', () => {
  it('matches the RFC 6238 SHA-1 test vector', () => {
    // Secret "12345678901234567890", T = 59 s → 94287082 (8 digits); 6-digit form is 287082.
    const secret = Buffer.from('12345678901234567890');
    expect(hotp(secret, 1)).toBe('287082');
  });
  it('round-trips base32', () => {
    const b = Buffer.from('hello world!');
    expect(base32Decode(base32Encode(b)).equals(b)).toBe(true);
  });
  it('rejects reuse of an already-used step', () => {
    const s = base32Encode(Buffer.from('12345678901234567890'));
    const step = currentStep();
    const code = totpAt(s, step);
    expect(verifyTotp(s, code)).not.toBeNull();
    expect(verifyTotp(s, code, { lastUsedStep: step })).toBeNull();
  });
});

describe('multi-factor authentication (AUTH-04, AUTH-05)', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup({ relaxMfa: false });
  });
  afterAll(async () => env.close());

  it('forces MFA enrolment for roles that require it, then requires a code at every login', async () => {
    const s = await env.login('hr.a');
    expect((await s.get('/auth/session')).body.state).toBe('mfa_setup_required');
    expect((await s.get('/companies')).status).toBe(403);

    const setup1 = await s.post('/auth/mfa/totp/setup');
    expect(setup1.status).toBe(201);
    const secret: string = setup1.body.secret;
    expect(setup1.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);

    const bad = await s.post('/auth/mfa/totp/confirm', { code: '000000' });
    expect(bad.status).toBe(400);
    const confirm = await s.post('/auth/mfa/totp/confirm', { code: totpAt(secret, currentStep()) });
    expect(confirm.status).toBe(201);
    const recovery: string[] = confirm.body.recoveryCodes;
    expect(recovery).toHaveLength(10);
    expect((await s.get('/auth/session')).body.state).toBe('active');

    // New login → MFA required before anything else.
    const s2 = await env.login('hr.a');
    expect((await s2.get('/auth/session')).body.state).toBe('mfa_required');
    expect((await s2.get('/companies')).status).toBe(403);

    // Next step's code is accepted once; replaying it on another session is rejected.
    const nextCode = totpAt(secret, currentStep() + 1);
    expect((await s2.post('/auth/mfa/verify', { code: nextCode })).status).toBe(204);
    expect((await s2.get('/auth/session')).body.state).toBe('active');
    const s3 = await env.login('hr.a');
    const replay = await s3.post('/auth/mfa/verify', { code: nextCode });
    expect(replay.status).toBe(400);
    expect(replay.body.code).toBe('MFA_INVALID');

    // A recovery code works exactly once.
    expect((await s3.post('/auth/mfa/verify', { recoveryCode: recovery[0] })).status).toBe(204);
    const s4 = await env.login('hr.a');
    expect((await s4.post('/auth/mfa/verify', { recoveryCode: recovery[0] })).status).toBe(400);
    expect((await s4.post('/auth/mfa/verify', { recoveryCode: recovery[1] })).status).toBe(204);
  });

  it('revokes the session after too many wrong codes', async () => {
    const s = await env.login('hr.a');
    let last;
    for (let i = 0; i < 5; i++) last = await s.post('/auth/mfa/verify', { code: '111111' });
    expect(last!.status).toBe(401);
    expect((await s.get('/auth/session')).status).toBe(401);
  });

  it('does not allow disabling MFA when the role requires it', async () => {
    // finance.a enrols, then tries to disable.
    const s = await env.login('finance.a');
    const st = await s.post('/auth/mfa/totp/setup');
    await s.post('/auth/mfa/totp/confirm', { code: totpAt(st.body.secret, currentStep()) });
    const r = await s.post('/auth/mfa/totp/disable', { password: TEST_PASSWORD, code: totpAt(st.body.secret, currentStep() + 1) });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('MFA_REQUIRED_BY_POLICY');
  });

  it('an administrator can reset a user\'s MFA, which ends their sessions', async () => {
    // Admin must enrol first (system_admin requires MFA).
    const admin = await env.login('admin');
    const st = await admin.post('/auth/mfa/totp/setup');
    await admin.post('/auth/mfa/totp/confirm', { code: totpAt(st.body.secret, currentStep()) });
    const target = env.seeded.users['finance.a']!;
    const r = await admin.post(`/users/${target}/reset-mfa`);
    expect(r.status).toBe(204);
    const s = await env.login('finance.a');
    expect((await s.get('/auth/session')).body.state).toBe('mfa_setup_required');
    void API;
  });
});
