import { Body, Controller, Get, Inject, Injectable, Param, Patch, Post, Query } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, or, type SQL } from 'drizzle-orm';
import {
  LOOKUP_KINDS,
  lookupCreateInput,
  lookupUpdateInput,
  type LookupDto,
  type LookupKind,
} from '@hrms/shared';
import type { z } from 'zod';
import { DATABASE } from '../common/tokens.js';
import type { Database, Tx } from '../db/database.js';
import { lookupValue } from '../db/schema.js';
import { ApiError, assertUuid, parse } from '../common/errors.js';
import { uuidv7 } from '../common/ids.js';
import type { Principal } from '../access/principal.js';
import { AuditService } from '../audit/audit.service.js';
import { CurrentPrincipal, RequirePermission } from '../auth/decorators.js';

const toDto = (r: typeof lookupValue.$inferSelect): LookupDto => ({
  id: r.id,
  kind: r.kind,
  companyId: r.companyId,
  code: r.code,
  nameAr: r.nameAr,
  nameEn: r.nameEn,
  status: r.status,
  version: r.version,
});

/** Configurable lists: job titles, employment categories, contract types, pay item types. */
@Injectable()
export class LookupsService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** Group-wide values plus values of the companies the user can see (RLS). */
  async list(principal: Principal, kind?: LookupKind, companyId?: string): Promise<LookupDto[]> {
    return this.database.tx(principal.rls(), async (tx) => {
      const where: SQL[] = [];
      if (kind) where.push(eq(lookupValue.kind, kind));
      if (companyId) where.push(or(isNull(lookupValue.companyId), eq(lookupValue.companyId, companyId))!);
      const rows = await tx
        .select()
        .from(lookupValue)
        .where(and(...where))
        .orderBy(asc(lookupValue.kind), asc(lookupValue.nameEn));
      return rows.map(toDto);
    });
  }

  async create(principal: Principal, input: z.infer<typeof lookupCreateInput>): Promise<LookupDto> {
    const companyId = input.companyId ?? null;
    if (companyId ? !principal.canCompany('lookups.manage', companyId) : !principal.hasGroup('lookups.manage')) {
      throw ApiError.forbidden();
    }
    return this.database.tx(principal.rls(), async (tx) => {
      const [row] = await tx
        .insert(lookupValue)
        .values({
          id: uuidv7(),
          kind: input.kind,
          companyId,
          code: input.code,
          nameAr: input.nameAr,
          nameEn: input.nameEn,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();
      const dto = toDto(row!);
      await this.audit.record(tx, {
        action: 'lookups.created',
        entityType: 'lookup',
        entityId: dto.id,
        companyId,
        after: dto,
      });
      return dto;
    });
  }

  async update(principal: Principal, id: string, input: z.infer<typeof lookupUpdateInput>): Promise<LookupDto> {
    return this.database.tx(principal.rls(), async (tx) => {
      const [before] = await tx.select().from(lookupValue).where(eq(lookupValue.id, id));
      if (!before) throw ApiError.notFound('Value');
      const allowed = before.companyId
        ? principal.canCompany('lookups.manage', before.companyId)
        : principal.hasGroup('lookups.manage');
      if (!allowed) throw ApiError.forbidden();
      const [after] = await tx
        .update(lookupValue)
        .set({ nameAr: input.nameAr, nameEn: input.nameEn, status: input.status, updatedBy: principal.userId })
        .where(and(eq(lookupValue.id, id), eq(lookupValue.version, input.version)))
        .returning();
      if (!after) throw ApiError.versionConflict();
      await this.audit.record(tx, {
        action: 'lookups.updated',
        entityType: 'lookup',
        entityId: id,
        companyId: after.companyId,
        before: toDto(before),
        after: toDto(after),
      });
      return toDto(after);
    });
  }
}

/** Validate that referenced list values exist, are active, of the right kind and usable in the company. */
export async function assertLookups(
  tx: Tx,
  companyId: string,
  refs: { id: string | null | undefined; kind: LookupKind; field: string }[],
): Promise<void> {
  const ids = refs.map((r) => r.id).filter((x): x is string => !!x);
  if (!ids.length) return;
  const rows = await tx.select().from(lookupValue).where(inArray(lookupValue.id, ids));
  for (const ref of refs) {
    if (!ref.id) continue;
    const row = rows.find((r) => r.id === ref.id);
    if (!row || row.kind !== ref.kind || row.status !== 'active' || (row.companyId && row.companyId !== companyId)) {
      throw ApiError.validation([{ path: ref.field, message: 'Invalid or inactive value for this company' }]);
    }
  }
}

@Controller('lookups')
export class LookupsController {
  constructor(@Inject(LookupsService) private readonly lookups: LookupsService) {}

  @Get()
  list(@CurrentPrincipal() p: Principal, @Query('kind') kind?: string, @Query('companyId') companyId?: string) {
    const k = kind && (LOOKUP_KINDS as readonly string[]).includes(kind) ? (kind as LookupKind) : undefined;
    return this.lookups.list(p, k, companyId ? assertUuid(companyId, 'Company') : undefined);
  }

  @Post()
  @RequirePermission('lookups.manage')
  create(@CurrentPrincipal() p: Principal, @Body() body: unknown) {
    return this.lookups.create(p, parse(lookupCreateInput, body));
  }

  @Patch(':id')
  @RequirePermission('lookups.manage')
  update(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    return this.lookups.update(p, assertUuid(id, 'Value'), parse(lookupUpdateInput, body));
  }
}
