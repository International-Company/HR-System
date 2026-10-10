import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { MODULE_KEYS, type ModuleDto, type ModuleKey } from '@hrms/shared';
import { DATABASE } from '../common/tokens.js';
import type { Database } from '../db/database.js';
import { company, moduleCompanyState, moduleTable } from '../db/schema.js';
import { ApiError } from '../common/errors.js';
import type { Principal } from '../access/principal.js';
import { AuditService } from '../audit/audit.service.js';

export type ModuleAccess = 'enabled' | 'read_only' | 'hidden';

/**
 * Module registry (ORG-07, ORG-08). Disabling a module never deletes data; the disable
 * policy decides whether existing data stays readable ('read_only') or is hidden.
 */
@Injectable()
export class ModulesService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async list(principal: Principal): Promise<ModuleDto[]> {
    return this.database.tx(principal.rls(), async (tx) => {
      const mods = await tx.select().from(moduleTable);
      const states = await tx.select().from(moduleCompanyState);
      return MODULE_KEYS.map((key) => {
        const m = mods.find((x) => x.key === key);
        return {
          key,
          groupEnabled: m?.groupEnabled ?? true,
          disablePolicy: m?.disablePolicy ?? 'read_only',
          companies: states
            .filter((s) => s.moduleKey === key)
            .map((s) => ({ companyId: s.companyId, enabled: s.enabled })),
        };
      });
    });
  }

  /** Effective access to a module for a company (new companies inherit "enabled"). */
  async access(key: ModuleKey, companyId: string | null): Promise<ModuleAccess> {
    return this.database.system(async (tx) => {
      const [m] = await tx.select().from(moduleTable).where(eq(moduleTable.key, key));
      if (!m) return 'enabled';
      let enabled = m.groupEnabled;
      if (enabled && companyId) {
        const [s] = await tx
          .select()
          .from(moduleCompanyState)
          .where(and(eq(moduleCompanyState.moduleKey, key), eq(moduleCompanyState.companyId, companyId)));
        if (s) enabled = s.enabled;
      }
      return enabled ? 'enabled' : m.disablePolicy;
    });
  }

  async updateGroup(
    principal: Principal,
    key: string,
    input: { groupEnabled?: boolean | undefined; disablePolicy?: 'read_only' | 'hidden' | undefined },
  ): Promise<void> {
    if (!(MODULE_KEYS as readonly string[]).includes(key)) throw ApiError.notFound('Module');
    await this.database.tx(principal.rls(), async (tx) => {
      const [before] = await tx.select().from(moduleTable).where(eq(moduleTable.key, key));
      if (!before) throw ApiError.notFound('Module');
      const [after] = await tx
        .update(moduleTable)
        .set({
          groupEnabled: input.groupEnabled,
          disablePolicy: input.disablePolicy,
          updatedAt: new Date(),
          updatedBy: principal.userId,
        })
        .where(eq(moduleTable.key, key))
        .returning();
      await this.audit.record(tx, {
        action: 'settings.module.updated',
        entityType: 'module',
        entityId: key,
        before: { groupEnabled: before.groupEnabled, disablePolicy: before.disablePolicy },
        after: { groupEnabled: after!.groupEnabled, disablePolicy: after!.disablePolicy },
      });
    });
  }

  async setCompany(principal: Principal, key: string, companyId: string, enabled: boolean) {
    if (!(MODULE_KEYS as readonly string[]).includes(key)) throw ApiError.notFound('Module');
    await this.database.tx(principal.rls(), async (tx) => {
      const [c] = await tx.select({ id: company.id }).from(company).where(eq(company.id, companyId));
      if (!c) throw ApiError.notFound('Company');
      const [before] = await tx
        .select()
        .from(moduleCompanyState)
        .where(and(eq(moduleCompanyState.moduleKey, key), eq(moduleCompanyState.companyId, companyId)));
      await tx
        .insert(moduleCompanyState)
        .values({ moduleKey: key, companyId, enabled, updatedBy: principal.userId })
        .onConflictDoUpdate({
          target: [moduleCompanyState.moduleKey, moduleCompanyState.companyId],
          set: { enabled, updatedAt: new Date(), updatedBy: principal.userId },
        });
      await this.audit.record(tx, {
        action: 'settings.module.company_updated',
        entityType: 'module',
        entityId: key,
        companyId,
        before: { enabled: before?.enabled ?? null },
        after: { enabled },
      });
    });
  }
}
