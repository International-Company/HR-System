import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';
import { ApiError } from '../common/errors.js';
import { COMMON_PASSWORDS } from './common-passwords.js';

/**
 * Argon2id with the library defaults (m=19456 KiB, t=2, p=1), which match the OWASP
 * Password Storage Cheat Sheet minimum. Policy follows NIST SP 800-63B: length and a
 * blocklist; no composition rules, no forced rotation.
 */
@Injectable()
export class PasswordService {
  private dummyHash: Promise<string> | null = null;

  hash(password: string): Promise<string> {
    return hash(password);
  }

  async verify(passwordHash: string, password: string): Promise<boolean> {
    try {
      return await verify(passwordHash, password);
    } catch {
      return false;
    }
  }

  /** Spend comparable time when the user does not exist (limits username enumeration). */
  async verifyDummy(password: string): Promise<void> {
    this.dummyHash ??= hash('dummy-password-for-timing-equalisation');
    await this.verify(await this.dummyHash, password);
  }

  violations(password: string, opts: { minLength: number; username?: string }): string[] {
    const v: string[] = [];
    const length = [...password].length;
    if (length < opts.minLength) v.push('too_short');
    if (length > 128) v.push('too_long');
    const lower = password.toLowerCase();
    if (COMMON_PASSWORDS.has(lower)) v.push('too_common');
    if (opts.username && opts.username.length >= 3 && lower.includes(opts.username.toLowerCase())) {
      v.push('contains_username');
    }
    if (/^(.)\1+$/.test(password)) v.push('repeated_character');
    return v;
  }

  assertPolicy(password: string, opts: { minLength: number; username?: string }): void {
    const reasons = this.violations(password, opts);
    if (reasons.length) {
      throw new ApiError(400, 'PASSWORD_POLICY', 'Password does not meet the policy', {
        meta: { reasons, minLength: opts.minLength },
      });
    }
  }
}
