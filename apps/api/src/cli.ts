import 'reflect-metadata';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { loadConfig } from './config.js';
import { openDatabase } from './db/database.js';
import { provision } from './provisioning.js';
import { seed } from './seed.js';
import { DecryptStream } from './backup/stream-crypto.js';

/**
 * Maintenance commands. Railway pre-deploy runs `node dist/cli.js migrate`.
 *   migrate                      migrations + role + catalogue + first-admin bootstrap
 *   seed [--relax-mfa]           synthetic demo data (refused in production)
 *   backup:decrypt <in> <out>    decrypt a downloaded backup file for manual restore
 */
async function main() {
  const [command, ...args] = process.argv.slice(2);
  const config = loadConfig();

  switch (command) {
    case 'migrate': {
      const database = await openDatabase(config);
      try {
        await provision(database, config);
      } finally {
        await database.close();
      }
      return;
    }
    case 'seed': {
      const database = await openDatabase(config);
      try {
        await provision(database, config);
        const result = await seed(database, config, {
          ...(process.env.SEED_PASSWORD ? { password: process.env.SEED_PASSWORD } : {}),
          relaxMfa: args.includes('--relax-mfa'),
        });
        console.log(`Seeded ${Object.keys(result.users).length} demo accounts: ${Object.keys(result.users).join(', ')}`);
        console.log(`Demo password (development only): ${result.password}`);
      } finally {
        await database.close();
      }
      return;
    }
    case 'backup:decrypt': {
      const [input, output] = args;
      if (!input || !output) throw new Error('Usage: backup:decrypt <in> <out>');
      if (!config.BACKUP_ENCRYPTION_KEY) throw new Error('BACKUP_ENCRYPTION_KEY is not set');
      const keys = new Map([[config.BACKUP_ENCRYPTION_KEY_ID, Buffer.from(config.BACKUP_ENCRYPTION_KEY, 'base64')]]);
      await pipeline(createReadStream(input), new DecryptStream(keys), createWriteStream(output));
      console.log(`Decrypted to ${output}. Restore with: pg_restore --no-owner --dbname <db> ${output}`);
      return;
    }
    default:
      throw new Error(`Unknown command "${command ?? ''}". Commands: migrate, seed, backup:decrypt`);
  }
}

main().catch((err: unknown) => {
  console.error((err as Error).message ?? err);
  process.exit(1);
});
