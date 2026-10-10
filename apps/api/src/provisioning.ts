import { eq, sql } from 'drizzle-orm';
import type { AppConfig } from './config.js';
import type { Database } from './db/database.js';
import { migrate } from './db/migrator.js';
import { syncCatalog } from './access/catalog-sync.js';
import { companyGroup, role, roleAssignment, userAccount } from './db/schema.js';
import { uuidv7 } from './common/ids.js';
import { PasswordService } from './auth/password.service.js';
import { AuditService } from './audit/audit.service.js';

/**
 * Everything the pre-deploy step does: migrations, least-privilege role login,
 * catalogue sync and (first deploy only) bootstrap of the group and first administrator.
 */
export async function provision(
  database: Database,
  cfg: AppConfig,
  log: (msg: string) => void = console.log,
): Promise<void> {
  const result = await migrate(database.owner, { appRole: cfg.DB_APP_ROLE, log });
  log(`Migrations: ${result.applied.length} applied, schema at ${result.current}`);

  if (cfg.DB_APP_PASSWORD) {
    // Enable login for the runtime role with the configured password (value never logged).
    const [row] = await database.owner.query<{ stmt: string }>(
      `select format('alter role %I with login password %L', $1::text, $2::text) as stmt`,
      [cfg.DB_APP_ROLE, cfg.DB_APP_PASSWORD],
    );
    await database.owner.exec(row!.stmt);
    log(`Runtime role ${cfg.DB_APP_ROLE} can log in`);
  }

  const sync = await syncCatalog(database.owner);
  log(`Permission catalogue synced (${sync.changes} changes)`);

  await bootstrap(database, cfg, log);
}

export async function bootstrap(
  database: Database,
  cfg: AppConfig,
  log: (msg: string) => void,
): Promise<void> {
  const audit = new AuditService(database);
  await database.system(async (tx) => {
    const [group] = await tx.select({ id: companyGroup.id }).from(companyGroup);
    if (!group) {
      const id = uuidv7();
      await tx.insert(companyGroup).values({
        id,
        nameAr: cfg.BOOTSTRAP_GROUP_NAME_AR ?? 'مجموعة الشركات',
        nameEn: cfg.BOOTSTRAP_GROUP_NAME_EN ?? 'Company Group',
      });
      await audit.record(tx, {
        action: 'system.bootstrap.group_created',
        entityType: 'company_group',
        entityId: id,
        actor: { userId: null, username: 'system' },
      });
      log('Company group created');
    }
  });

  const [{ count }] = await database.system((tx) =>
    tx.select({ count: sql<number>`count(*)::int` }).from(userAccount),
  ) as [{ count: number }];
  if (count > 0) return;
  if (!cfg.BOOTSTRAP_ADMIN_USERNAME || !cfg.BOOTSTRAP_ADMIN_PASSWORD) {
    log('No users exist yet. Set BOOTSTRAP_ADMIN_USERNAME and BOOTSTRAP_ADMIN_PASSWORD to create the first administrator.');
    return;
  }
  const passwords = new PasswordService();
  passwords.assertPolicy(cfg.BOOTSTRAP_ADMIN_PASSWORD, {
    minLength: 12,
    username: cfg.BOOTSTRAP_ADMIN_USERNAME,
  });
  const passwordHash = await passwords.hash(cfg.BOOTSTRAP_ADMIN_PASSWORD);
  await database.system(async (tx) => {
    const [adminRole] = await tx.select().from(role).where(eq(role.key, 'system_admin'));
    if (!adminRole) throw new Error('system_admin role missing; run the catalogue sync first');
    const userId = uuidv7();
    await tx.insert(userAccount).values({
      id: userId,
      username: cfg.BOOTSTRAP_ADMIN_USERNAME!.toLowerCase(),
      displayName: cfg.BOOTSTRAP_ADMIN_DISPLAY_NAME ?? 'System Administrator',
      passwordHash,
      // The bootstrap password is only a first-login credential.
      mustChangePassword: true,
    });
    await tx.insert(roleAssignment).values({
      id: uuidv7(),
      userId,
      roleId: adminRole.id,
      scopeType: 'GROUP',
    });
    await audit.record(tx, {
      action: 'system.bootstrap.admin_created',
      entityType: 'user',
      entityId: userId,
      actor: { userId: null, username: 'system' },
    });
  });
  log(`First administrator "${cfg.BOOTSTRAP_ADMIN_USERNAME}" created (must change password at first login). Remove BOOTSTRAP_ADMIN_PASSWORD now.`);
}

/** QA-05: a production deployment must never contain seed/test accounts. */
export async function assertNoSeedAccounts(database: Database, cfg: AppConfig): Promise<void> {
  if (!cfg.isProduction) return;
  const rows = await database.system((tx) =>
    tx.select({ id: userAccount.id }).from(userAccount).where(eq(userAccount.isSeed, true)).limit(1),
  );
  if (rows.length) {
    throw new Error('Refusing to start: seed/test accounts exist in a production database');
  }
}
