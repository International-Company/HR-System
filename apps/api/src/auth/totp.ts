import { createHmac, randomBytes } from 'node:crypto';

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s) — compatible with standard authenticator apps. */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_PERIOD = 30;

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('Invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function hotp(secret: Buffer, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', secret).update(msg).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const code =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return (code % 1_000_000).toString().padStart(6, '0');
}

export function currentStep(now = Date.now()): number {
  return Math.floor(now / 1000 / TOTP_PERIOD);
}

export function totpAt(secretBase32: string, step: number): string {
  return hotp(base32Decode(secretBase32), step);
}

/**
 * Verify a code within ±1 step of clock drift. Returns the matched step so the caller can
 * reject replays (a step may only be used once).
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  opts: { now?: number; lastUsedStep?: number | null } = {},
): number | null {
  const secret = base32Decode(secretBase32);
  const step = currentStep(opts.now);
  for (const s of [step - 1, step, step + 1]) {
    if (opts.lastUsedStep != null && s <= opts.lastUsedStep) continue;
    if (hotp(secret, s) === code) return s;
  }
  return null;
}

export function otpauthUrl(secretBase32: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: String(TOTP_PERIOD),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
