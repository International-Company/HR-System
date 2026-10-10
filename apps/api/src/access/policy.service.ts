import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gte, isNull, lte, or, sql } from 'drizzle-orm';
import type { SessionState } from '@hrms/shared';
import { DATABASE } from '../common/tokens.js';
import type { Database } from '../db/database.js';
import { permission, role, roleAssignment, rolePermission } from '../db/schema.js';
import { Principal, type Grant } from './principal.js';

interface ActiveAssignmentRow {
  roleKey: string;
  scopeType: Grant['scopeType'];
  companyId: string | null;
  departmentId: string | null;
}

@Injectable()
export class PolicyService {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  /** Active role assignments of a user (today within validity, not ended). */
  async activeAssignments(userId: string): Promise<ActiveAssignmentRow[]> {
    return this.database.system((tx) =>
      tx
        .select({
          roleKey: role.key,
          scopeType: roleAssignment.scopeType,
          companyId: roleAssignment.companyId,
          departmentId: roleAssignment.departmentId,
        })
        .from(roleAssignment)
        .innerJoin(role, eq(role.id, roleAssignment.roleId))
        .where(
          and(
            eq(roleAssignment.userId, userId),
            isNull(roleAssignment.endedAt),
            lte(roleAssignment.validFrom, sql`current_date`),
            or(isNull(roleAssignment.validTo), gte(roleAssignment.validTo, sql`current_date`)),
          ),
        ),
    );
  }

  /**
   * Build the principal. `resolveState` receives the user's active role keys, because the
   * session state can depend on them (MFA required for certain roles).
   */
  async loadPrincipal(
    user: { id: string; username: string },
    sessionId: string,
    resolveState: (roleKeys: ReadonlySet<string>) => SessionState,
  ): Promise<Principal> {
    const rows = await this.database.system((tx) =>
      tx
        .select({
          roleKey: role.key,
          scopeType: roleAssignment.scopeType,
          companyId: roleAssignment.companyId,
          departmentId: roleAssignment.departmentId,
          permissionKey: rolePermission.permissionKey,
          groupOnly: permission.groupOnly,
        })
        .from(roleAssignment)
        .innerJoin(role, eq(role.id, roleAssignment.roleId))
        .leftJoin(rolePermission, eq(rolePermission.roleId, role.id))
        .leftJoin(permission, eq(permission.key, rolePermission.permissionKey))
        .where(
          and(
            eq(roleAssignment.userId, user.id),
            isNull(roleAssignment.endedAt),
            lte(roleAssignment.validFrom, sql`current_date`),
            or(isNull(roleAssignment.validTo), gte(roleAssignment.validTo, sql`current_date`)),
          ),
        ),
    );

    const roleKeys = new Set(rows.map((r) => r.roleKey));
    const state = resolveState(roleKeys);
    const grants = new Map<string, Grant[]>();
    const companyIds = new Set<string>();
    let group = false;
    for (const r of rows) {
      if (r.scopeType === 'GROUP') group = true;
      if (r.companyId) companyIds.add(r.companyId);
      // Restricted sessions (password change / MFA pending) carry no permissions.
      if (state !== 'active' || !r.permissionKey) continue;
      // Group-only permissions are ineffective through narrower scopes.
      if (r.groupOnly && r.scopeType !== 'GROUP') continue;
      const list = grants.get(r.permissionKey) ?? [];
      list.push({ scopeType: r.scopeType, companyId: r.companyId, departmentId: r.departmentId });
      grants.set(r.permissionKey, list);
    }
    return new Principal(
      user.id,
      user.username,
      sessionId,
      state,
      roleKeys,
      grants,
      [...companyIds],
      group && state === 'active',
    );
  }
}
