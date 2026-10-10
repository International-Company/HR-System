import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { loadConfig } from './config.js';
import { openDatabase } from './db/database.js';
import { createApp } from './create-app.js';
import { assertNoSeedAccounts, provision } from './provisioning.js';

/** Web service entry point (API + static PWA). */
async function main() {
  const config = loadConfig();
  const database = await openDatabase(config);
  // Embedded development database: migrate on start (deployed environments use the pre-deploy step).
  if (config.PGLITE_DIR) await provision(database, config);
  await assertNoSeedAccounts(database, config);
  const app = await createApp({ config, database });
  app.enableShutdownHooks();
  await app.listen(config.PORT, '0.0.0.0');
  new Logger('Main').log(`HRMS web listening on :${config.PORT} (${config.APP_ENV})`);
  const shutdown = async () => {
    await app.close();
    await database.close();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}

main().catch((err: unknown) => {
  console.error((err as Error).message ?? err);
  process.exit(1);
});
