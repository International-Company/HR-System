import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { seed } from '../src/seed.js';
import { assertNoSeedAccounts } from '../src/provisioning.js';
import { setup, testEnv } from './helpers.js';
import { Encryptor } from '../src/common/crypto.js';
import { randomBytes } from 'node:crypto';
import { uuidv7 } from '../src/common/ids.js';

describe('test-data guards (QA-04, QA-05)', () => {
  it('seeding is refused in production and production refuses to start with seed accounts', async () => {
    const env = await setup();
    try {
      const prodCfg = { ...env.config, isProduction: true };
      await expect(seed(env.database, prodCfg)).rejects.toThrow(/production/);
      await expect(assertNoSeedAccounts(env.database, prodCfg)).rejects.toThrow(/seed/);
      await expect(assertNoSeedAccounts(env.database, env.config)).resolves.toBeUndefined();
    } finally {
      await env.close();
    }
    void loadConfig;
    void testEnv;
  });
});

describe('field encryption (D-06)', () => {
  it('round-trips, binds associated data and supports key rotation', () => {
    const k1 = randomBytes(32);
    const enc = new Encryptor('k1', k1);
    const blob = enc.encrypt('IBAN DE89 3704 0044 0532 0130 00', 'bank:1');
    expect(enc.decryptString(blob, 'bank:1')).toBe('IBAN DE89 3704 0044 0532 0130 00');
    expect(() => enc.decrypt(blob, 'bank:2')).toThrow();
    const rotated = new Encryptor('k2', randomBytes(32), { k1 });
    expect(rotated.decryptString(blob, 'bank:1')).toContain('DE89');
    expect(() => new Encryptor('k3', randomBytes(32)).decrypt(blob, 'bank:1')).toThrow(/Unknown encryption key/);
  });

  it('derives keys from long random secrets, separately per purpose', async () => {
    const { keyMaterial } = await import('../src/common/crypto.js');
    const b64 = randomBytes(32).toString('base64');
    expect(keyMaterial(b64, 'data-encryption').equals(Buffer.from(b64, 'base64'))).toBe(true);
    const phrase = 'x7Gq9!vLm2#pR8sT4wZ1aB6cD3eF5hJ0kN-uYq2Wz';
    const a = keyMaterial(phrase, 'data-encryption');
    expect(a).toHaveLength(32);
    expect(keyMaterial(phrase, 'data-encryption').equals(a)).toBe(true);
    expect(keyMaterial(phrase, 'backup-encryption').equals(a)).toBe(false);
    expect(() => keyMaterial('too-short-secret', 'data-encryption')).toThrow();
  });

  it('generates time-ordered UUIDv7 identifiers', () => {
    const a = uuidv7();
    const b = uuidv7();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a.slice(0, 13) <= b.slice(0, 13)).toBe(true);
  });
});
