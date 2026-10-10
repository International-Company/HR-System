import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import {
  SETTINGS,
  SETTING_KEYS,
  isSettingKey,
  type PublicSettings,
  type SettingDto,
  type SettingKey,
  type SettingValue,
} from '@hrms/shared';
import { DATABASE } from '../common/tokens.js';
import type { Database } from '../db/database.js';
import { companyGroup, settingValue } from '../db/schema.js';
import { ApiError, parse } from '../common/errors.js';
import { uuidv7 } from '../common/ids.js';
import type { Principal } from '../access/principal.js';
import { AuditService } from '../audit/audit.service.js';

const CACHE_MS = 15_000;

@Injectable()
export class SettingsService {
  private cache = new Map<string, { value: unknown; at: number }>();

  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  invalidate(): void {
    this.cache.clear();
  }

  /** Effective value: company override → group value → default. */
  async get<K extends SettingKey>(key: K, companyId?: string | null): Promise<SettingValue<K>> {
    const def = SETTINGS[key];
    const cacheKey = `${key}|${def.companyOverride ? (companyId ?? '') : ''}`;
    const hit = this.cache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as SettingValue<K>;

    const rows = await this.database.system((tx) =>
      tx
        .select({ companyId: settingValue.companyId, value: settingValue.value })
        .from(settingValue)
        .where(eq(settingValue.key, key)),
    );
    const groupRow = rows.find((r) => r.companyId === null);
    const companyRow =
      def.companyOverride && companyId ? rows.find((r) => r.companyId === companyId) : undefined;
    const raw = companyRow?.value ?? groupRow?.value ?? def.default;
    // Stored values are re-validated; an invalid stored value falls back to the default.
    const checked = def.schema.safeParse(raw);
    const value = (checked.success ? checked.data : def.default) as SettingValue<K>;
    this.cache.set(cacheKey, { value, at: Date.now() });
    return value;
  }

  async publicSettings(): Promise<PublicSettings> {
    const [language, timezone, dateFormat, timeFormat, numerals, group] = await Promise.all([
      this.get('general.language'),
      this.get('general.timezone'),
      this.get('general.dateFormat'),
      this.get('general.timeFormat'),
      this.get('general.numerals'),
      this.database.system((tx) =>
        tx.select({ ar: companyGroup.nameAr, en: companyGroup.nameEn }).from(companyGroup),
      ),
    ]);
    return {
      language,
      timezone,
      dateFormat,
      timeFormat,
      numerals,
      groupName: group[0] ?? null,
    };
  }

  async list(principal: Principal, companyId: string | null): Promise<SettingDto[]> {
    if (companyId && !principal.touchesCompany('settings.view', companyId)) {
      throw ApiError.notFound('Company');
    }
    const rows = await this.database.tx(principal.rls(), (tx) =>
      tx.select().from(settingValue),
    );
    return SETTING_KEYS.map((key) => {
      const def = SETTINGS[key];
      const groupRow = rows.find((r) => r.key === key && r.companyId === null);
      const companyRow =
        def.companyOverride && companyId
          ? rows.find((r) => r.key === key && r.companyId === companyId)
          : undefined;
      const groupValue = groupRow?.value ?? def.default;
      return {
        key,
        value: companyRow?.value ?? groupValue,
        groupValue,
        companyValue: companyRow?.value ?? null,
        isDefault: !groupRow && !companyRow,
        companyOverride: def.companyOverride,
        permission: def.permission,
        updatedAt: (companyRow ?? groupRow)?.updatedAt.toISOString() ?? null,
      };
    });
  }

  async update(
    principal: Principal,
    key: string,
    rawValue: unknown,
    companyId: string | null,
  ): Promise<void> {
    if (!isSettingKey(key)) throw ApiError.notFound('Setting');
    const def = SETTINGS[key];
    if (!principal.has(def.permission)) throw ApiError.forbidden();
    if (companyId && !def.companyOverride) {
      throw ApiError.validation([{ path: 'companyId', message: 'This setting cannot be overridden per company' }]);
    }
    const value = parse(def.schema, rawValue);
    await this.database.tx(principal.rls(), async (tx) => {
      const where = and(
        eq(settingValue.key, key),
        companyId ? eq(settingValue.companyId, companyId) : isNull(settingValue.companyId),
      );
      const [existing] = await tx.select().from(settingValue).where(where);
      if (existing) {
        await tx
          .update(settingValue)
          .set({ value: value as object, updatedBy: principal.userId })
          .where(eq(settingValue.id, existing.id));
      } else {
        await tx.insert(settingValue).values({
          id: uuidv7(),
          key,
          companyId,
          value: value as object,
          updatedBy: principal.userId,
        });
      }
      await this.audit.record(tx, {
        action: 'settings.updated',
        entityType: 'setting',
        entityId: key,
        companyId,
        before: { value: existing?.value ?? null },
        after: { value },
      });
    });
    this.invalidate();
  }

  async resetOverride(principal: Principal, key: string, companyId: string): Promise<void> {
    if (!isSettingKey(key)) throw ApiError.notFound('Setting');
    const def = SETTINGS[key];
    if (!principal.has(def.permission)) throw ApiError.forbidden();
    await this.database.tx(principal.rls(), async (tx) => {
      const deleted = await tx
        .delete(settingValue)
        .where(and(eq(settingValue.key, key), eq(settingValue.companyId, companyId)))
        .returning();
      if (!deleted.length) throw ApiError.notFound('Override');
      await this.audit.record(tx, {
        action: 'settings.override_removed',
        entityType: 'setting',
        entityId: key,
        companyId,
        before: { value: deleted[0]!.value },
      });
    });
    this.invalidate();
  }
}
