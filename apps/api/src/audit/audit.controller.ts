import { Controller, Get, HttpCode, Inject, Post, Query } from '@nestjs/common';
import { and, desc, eq, gte, inArray, isNotNull, like, lt, lte, not, or, sql, type SQL } from 'drizzle-orm';
import { auditQueryInput, type AuditEventDto, type Page } from '@hrms/shared';
import { DATABASE } from '../common/tokens.js';
import type { Database } from '../db/database.js';
import { auditEvent } from '../db/schema.js';
import { ApiError, parse } from '../common/errors.js';
import type { Principal } from '../access/principal.js';
import { CurrentPrincipal, RequirePermission } from '../auth/decorators.js';
import { AuditService } from './audit.service.js';

/** Authentication/security events are only visible with audit.view.security. */
const SECURITY_PREFIXES = ['auth.', 'identity.', 'access.', 'system.'];

@Controller('audit-events')
export class AuditController {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermission('audit.view')
  async list(@CurrentPrincipal() p: Principal, @Query() query: unknown): Promise<Page<AuditEventDto>> {
    const q = parse(auditQueryInput, query);
    const scope = p.scope('audit.view');
    const conditions: SQL[] = [];
    if (!scope.all) {
      if (!scope.companyIds.length) return { items: [], nextCursor: null };
      conditions.push(and(isNotNull(auditEvent.companyId), inArray(auditEvent.companyId, scope.companyIds))!);
    }
    if (!p.has('audit.view.security')) {
      conditions.push(not(or(...SECURITY_PREFIXES.map((x) => like(auditEvent.action, `${x}%`)))!));
    }
    if (q.from) conditions.push(gte(auditEvent.at, new Date(q.from)));
    if (q.to) conditions.push(lte(auditEvent.at, new Date(q.to)));
    if (q.actorUserId) conditions.push(eq(auditEvent.actorUserId, q.actorUserId));
    if (q.action) conditions.push(like(auditEvent.action, `${q.action.replace(/[%_\\]/g, '')}%`));
    if (q.entityType) conditions.push(eq(auditEvent.entityType, q.entityType));
    if (q.entityId) conditions.push(eq(auditEvent.entityId, q.entityId));
    if (q.companyId) {
      if (!scope.all && !scope.companyIds.includes(q.companyId)) throw ApiError.notFound('Company');
      conditions.push(eq(auditEvent.companyId, q.companyId));
    }
    if (q.outcome) conditions.push(eq(auditEvent.outcome, q.outcome));
    if (q.before) conditions.push(lt(auditEvent.id, q.before));

    return this.database.tx(p.rls(), async (tx) => {
      const rows = await tx
        .select()
        .from(auditEvent)
        .where(and(...conditions))
        .orderBy(desc(auditEvent.id))
        .limit(q.limit + 1);
      const page = rows.slice(0, q.limit);
      // AUD-03: reading the audit log is itself audited.
      await this.audit.record(tx, {
        action: 'audit.viewed',
        details: { filters: { ...q, limit: undefined }, returned: page.length },
      });
      return {
        items: page.map((r) => ({
          id: r.id,
          at: r.at.toISOString(),
          actorUserId: r.actorUserId,
          actorUsername: r.actorUsername,
          action: r.action,
          entityType: r.entityType,
          entityId: r.entityId,
          companyId: r.companyId,
          before: r.before,
          after: r.after,
          ip: r.ip,
          outcome: r.outcome,
          details: r.details,
        })),
        nextCursor: rows.length > q.limit ? String(page.at(-1)!.id) : null,
      };
    });
  }

  @Post('verify')
  @HttpCode(200)
  @RequirePermission('audit.verify')
  async verify(@CurrentPrincipal() p: Principal) {
    return this.database.tx(p.rls(), async (tx) => {
      const result = await tx.execute<{ checked: string; first_bad_id: string | null }>(
        sql`select checked, first_bad_id from audit_verify_chain()`,
      );
      const row = (result as unknown as { rows: { checked: string; first_bad_id: string | null }[] })
        .rows[0]!;
      const ok = row.first_bad_id === null;
      await this.audit.record(tx, {
        action: 'audit.chain_verified',
        outcome: ok ? 'success' : 'failure',
        details: { checked: Number(row.checked), firstBadId: row.first_bad_id },
      });
      return { ok, checked: Number(row.checked), firstBadId: row.first_bad_id ? Number(row.first_bad_id) : null };
    });
  }
}
