import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  type DecipherGCM,
  type Hash,
} from 'node:crypto';
import { Transform, type TransformCallback } from 'node:stream';

/**
 * Streaming AES-256-GCM for backup files.
 * Layout: "HRMSBK1\n" | keyIdLen(1) | keyId | iv(12) | ciphertext | tag(16)
 */
const MAGIC = Buffer.from('HRMSBK1\n');
const TAG_LEN = 16;

export class EncryptStream extends Transform {
  private readonly cipher;
  private headerSent = false;
  readonly digest: Hash = createHash('sha256');
  bytesOut = 0;

  constructor(key: Buffer, private readonly keyId: string) {
    super();
    const iv = randomBytes(12);
    this.cipher = createCipheriv('aes-256-gcm', key, iv);
    this.header = Buffer.concat([MAGIC, Buffer.from([Buffer.byteLength(keyId)]), Buffer.from(keyId), iv]);
  }

  private readonly header: Buffer;

  private emit_(chunk: Buffer) {
    if (!chunk.length) return;
    this.digest.update(chunk);
    this.bytesOut += chunk.length;
    this.push(chunk);
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    if (!this.headerSent) {
      this.emit_(this.header);
      this.headerSent = true;
    }
    this.emit_(this.cipher.update(chunk));
    cb();
  }

  override _flush(cb: TransformCallback): void {
    if (!this.headerSent) {
      this.emit_(this.header);
      this.headerSent = true;
    }
    this.emit_(this.cipher.final());
    this.emit_(this.cipher.getAuthTag());
    cb();
  }
}

/** Decrypts while streaming; authentication is verified at the end (errors on tamper). */
export class DecryptStream extends Transform {
  private buf = Buffer.alloc(0);
  private decipher: DecipherGCM | null = null;

  constructor(private readonly keys: Map<string, Buffer>) {
    super();
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    try {
      this.buf = Buffer.concat([this.buf, chunk]);
      if (!this.decipher) {
        if (this.buf.length < MAGIC.length + 1) return cb();
        if (!this.buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Not an HRMS backup file');
        const idLen = this.buf[MAGIC.length]!;
        const headerLen = MAGIC.length + 1 + idLen + 12;
        if (this.buf.length < headerLen) return cb();
        const keyId = this.buf.subarray(MAGIC.length + 1, MAGIC.length + 1 + idLen).toString();
        const key = this.keys.get(keyId);
        if (!key) throw new Error(`Unknown backup key id "${keyId}"`);
        const iv = this.buf.subarray(MAGIC.length + 1 + idLen, headerLen);
        this.decipher = createDecipheriv('aes-256-gcm', key, iv);
        this.buf = this.buf.subarray(headerLen);
      }
      // Keep the last 16 bytes back: they may be the auth tag.
      if (this.buf.length > TAG_LEN) {
        const body = this.buf.subarray(0, this.buf.length - TAG_LEN);
        this.buf = this.buf.subarray(this.buf.length - TAG_LEN);
        this.push(this.decipher.update(body));
      }
      cb();
    } catch (err) {
      cb(err as Error);
    }
  }

  override _flush(cb: TransformCallback): void {
    try {
      if (!this.decipher || this.buf.length !== TAG_LEN) throw new Error('Truncated backup file');
      this.decipher.setAuthTag(this.buf);
      this.push(this.decipher.final());
      cb();
    } catch (err) {
      cb(err as Error);
    }
  }
}
