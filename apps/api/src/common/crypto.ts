import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Turn a configured secret into a 256-bit key. Accepts either exactly 32 bytes in base64,
 * or any long random string (>= 40 chars, e.g. from a password manager), from which the
 * key is derived with HKDF-SHA256. The derivation is fixed: changing it would make
 * existing encrypted data unreadable.
 */
export function keyMaterial(secret: string, purpose: 'data-encryption' | 'backup-encryption'): Buffer {
  if (/^[A-Za-z0-9+/]{43}=$/.test(secret)) {
    const raw = Buffer.from(secret, 'base64');
    if (raw.length === 32) return raw;
  }
  if (secret.length < 40) throw new Error('Encryption secret must be at least 40 characters');
  return Buffer.from(hkdfSync('sha256', secret, 'hrms-key-v1', purpose, 32));
}

export function isUsableKeySecret(secret: string): boolean {
  try {
    keyMaterial(secret, 'data-encryption');
    return true;
  } catch {
    return false;
  }
}

const MAGIC = Buffer.from('E1');

/**
 * Envelope encryption (D-06): every value gets its own random data key (DEK),
 * encrypted with AES-256-GCM; the DEK is wrapped by the master key (KEK).
 * Blob layout: "E1" | keyIdLen | keyId | wrapIv(12) | wrapTag(16) | wrappedDek(32) | iv(12) | tag(16) | ciphertext
 */
export class Encryptor {
  private readonly keys: Map<string, Buffer>;
  private readonly bidxKey: Buffer;

  constructor(
    private readonly currentKeyId: string,
    currentKey: Buffer,
    oldKeys: Record<string, Buffer> = {},
  ) {
    if (currentKey.length !== 32) throw new Error('Encryption key must be 32 bytes');
    this.keys = new Map(Object.entries(oldKeys));
    this.keys.set(currentKeyId, currentKey);
    // Separate key for blind indexes, derived from the master key.
    this.bidxKey = Buffer.from(hkdfSync('sha256', currentKey, 'hrms-bidx-v1', 'blind-index', 32));
  }

  get keyId(): string {
    return this.currentKeyId;
  }

  /**
   * Deterministic keyed hash for exact-match lookups of encrypted values (e.g. duplicate
   * national IDs) without decrypting. Rotating the master key requires re-indexing.
   */
  blindIndex(domain: string, value: string): Buffer {
    return createHmac('sha256', this.bidxKey).update(`${domain}:${value}`).digest();
  }

  static fromConfig(cfg: {
    DATA_ENCRYPTION_KEY: string;
    DATA_ENCRYPTION_KEY_ID: string;
    DATA_ENCRYPTION_OLD_KEYS?: string | undefined;
  }): Encryptor {
    const old: Record<string, Buffer> = {};
    if (cfg.DATA_ENCRYPTION_OLD_KEYS) {
      const parsed = JSON.parse(cfg.DATA_ENCRYPTION_OLD_KEYS) as Record<string, string>;
      for (const [id, secret] of Object.entries(parsed)) old[id] = keyMaterial(secret, 'data-encryption');
    }
    return new Encryptor(
      cfg.DATA_ENCRYPTION_KEY_ID,
      keyMaterial(cfg.DATA_ENCRYPTION_KEY, 'data-encryption'),
      old,
    );
  }

  encrypt(plaintext: Buffer | string, aad = ''): Buffer {
    const kek = this.keys.get(this.currentKeyId)!;
    const dek = randomBytes(32);
    const wrapIv = randomBytes(12);
    const wrap = createCipheriv('aes-256-gcm', kek, wrapIv);
    const wrapped = Buffer.concat([wrap.update(dek), wrap.final()]);
    const wrapTag = wrap.getAuthTag();

    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', dek, iv);
    cipher.setAAD(Buffer.from(aad));
    const data = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
    const ct = Buffer.concat([cipher.update(data), cipher.final()]);
    const tag = cipher.getAuthTag();
    const keyId = Buffer.from(this.currentKeyId);
    return Buffer.concat([
      MAGIC,
      Buffer.from([keyId.length]),
      keyId,
      wrapIv,
      wrapTag,
      wrapped,
      iv,
      tag,
      ct,
    ]);
  }

  decrypt(blob: Buffer, aad = ''): Buffer {
    if (blob.length < 3 || !blob.subarray(0, 2).equals(MAGIC)) throw new Error('Not an E1 blob');
    let o = 2;
    const keyIdLen = blob[o]!;
    o += 1;
    const keyId = blob.subarray(o, o + keyIdLen).toString();
    o += keyIdLen;
    const kek = this.keys.get(keyId);
    if (!kek) throw new Error(`Unknown encryption key id "${keyId}"`);
    const wrapIv = blob.subarray(o, (o += 12));
    const wrapTag = blob.subarray(o, (o += 16));
    const wrapped = blob.subarray(o, (o += 32));
    const iv = blob.subarray(o, (o += 12));
    const tag = blob.subarray(o, (o += 16));
    const ct = blob.subarray(o);

    const unwrap = createDecipheriv('aes-256-gcm', kek, wrapIv);
    unwrap.setAuthTag(wrapTag);
    const dek = Buffer.concat([unwrap.update(wrapped), unwrap.final()]);
    const decipher = createDecipheriv('aes-256-gcm', dek, iv);
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  }

  decryptString(blob: Buffer, aad = ''): string {
    return this.decrypt(blob, aad).toString('utf8');
  }
}

export function sha256(data: Buffer | string): Buffer {
  return createHash('sha256').update(data).digest();
}

export function hmacSha256(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

export function safeEqual(a: Buffer | string, b: Buffer | string): boolean {
  const ba = Buffer.isBuffer(a) ? a : Buffer.from(a);
  const bb = Buffer.isBuffer(b) ? b : Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
