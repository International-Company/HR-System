import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { PERMISSIONS, PERMISSION_BY_KEY, SYSTEM_ROLE_ONLY_PERMISSIONS, type RoleDto } from '@hrms/shared';
import type { z } from 'zod';
import type { roleCreateInput, roleUpdateInput } from '@hrms/shared';
import { DATABASE } from '../common/tokens.js';
import type { Database, Tx } from '../db/database.js';
import { role, rolePermission } from '../db/schema.js';
import { ApiError } from '../common/errors.js';
import { uuidv7 } from '../common/ids.js';
import type { Principal } from './principal.js';
import { AuditService } from '../audit/audit.service.js';

/** Roles and their permissions (RBAC-02). System roles are locked; copy them to customise. */
@Injectable()
export class RolesService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  catalogue() {
    return PERMISSIONS.map((p) => ({
      key: p.key,
      module: p.module,
      sensitivity: p.sensitivity,
      groupOnly: p.groupOnly,
      label: p.label,
    }));
  }

  async list(principal: Principal): Promise<RoleDto[]> {
    return this.database.tx(principal.rls(), async (tx) => {
      const roles = await tx.select().from(role).orderBy(asc(role.isSystem), asc(role.key));
      const perms = await tx.select().from(rolePermission);
      return roles.map((r) => ({
        id: r.id,
        key: r.key,
        nameAr: r.nameAr,
        nameEn: r.nameEn,
        description: r.description,
        isSystem: r.isSystem,
        permissions: perms.filter((p) => p.roleId === r.id).map((p) => p.permissionKey).sort(),
        version: r.version,
      }));
    });
  }

  async create(principal: Principal, input: z.infer<typeof roleCreateInput>): Promise<RoleDto> {
    const permissions = this.validatePermissions(input.permissions);
    return this.database.tx(principal.rls(), async (tx) => {
      const [dup] = await tx.select({ id: role.id }).from(role).where(eq(role.key, input.key));
      if (dup) throw ApiError.conflict('A role with this key already exists');
      const id = uuidv7();
      const [r] = await tx
        .insert(role)
        .values({
          id,
          key: input.key,
          nameAr: input.nameAr,
          nameEn: input.nameEn,
          description: input.description ?? null,
          isSystem: false,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();
      if (permissions.length) {
        await tx.insert(rolePermission).values(permissions.map((k) => ({ roleId: id, permissionKey: k })));
      }
      const dto = toDto(r!, permissions);
      await this.audit.record(tx, {
        action: 'access.role.created',
        entityType: 'role',
        entityId: id,
        after: dto,
      });
      return dto;
    });
  }

  async update(principal: Principal, id: string, input: z.infer<typeof roleUpdateInput>): Promise<RoleDto> {
    const nextPerms = input.permissions ? this.validatePermissions(input.permissions) : null;
    return this.database.tx(principal.rls(), async (tx) => {
      const [before] = await tx.select().from(role).where(eq(role.id, id));
      if (!before) throw ApiError.notFound('Role');
      if (before.isSystem) {
        throw ApiError.conflict('System roles cannot be changed. Copy the role to customise it.');
      }
      const beforePerms = await this.permissionsOf(tx, id);
      const [after] = await tx
        .update(role)
        .set({
          nameAr: input.nameAr,
          nameEn: input.nameEn,
          description: input.description,
          updatedBy: principal.userId,
        })
        .where(and(eq(role.id, id), eq(role.version, input.version)))
        .returning();
      if (!after) throw ApiError.versionConflict();
      if (nextPerms) {
        const remove = beforePerms.filter((k) => !nextPerms.includes(k));
        const add = nextPerms.filter((k) => !beforePerms.includes(k));
        if (remove.length) {
          await tx
            .delete(rolePermission)
            .where(and(eq(rolePermission.roleId, id), inArray(rolePermission.permissionKey, remove)));
        }
        if (add.length) {
          await tx.insert(rolePermission).values(add.map((k) => ({ roleId: id, permissionKey: k })));
        }
      }
      const dto = toDto(after, nextPerms ?? beforePerms);
      await this.audit.record(tx, {
        action: 'access.role.updated',
        entityType: 'role',
        entityId: id,
        before: toDto(before, beforePerms),
        after: dto,
      });
      return dto;
    });
  }

  async copy(
    principal: Principal,
    sourceId: string,
    input: { key: string; nameAr: string; nameEn: string },
  ): Promise<RoleDto> {
    const perms = await this.database.tx(principal.rls(), async (tx) => {
      const [src] = await tx.select({ id: role.id }).from(role).where(eq(role.id, sourceId));
      if (!src) throw ApiError.notFound('Role');
      return this.permissionsOf(tx, sourceId);
    });
    return this.create(principal, { ...input, permissions: perms });
  }

  private validatePermissions(keys: string[]): string[] {
    const unique = [...new Set(keys)];
    const unknown = unique.filter((k) => !PERMISSION_BY_KEY.has(k));
    if (unknown.length) {
      throw ApiError.validation([{ path: 'permissions', message: `Unknown permissions: ${unknown.join(', ')}` }]);
    }
    const reserved = unique.filter((k) => SYSTEM_ROLE_ONLY_PERMISSIONS.includes(k));
    if (reserved.length) {
      throw ApiError.validation([{ path: 'permissions', message: `Reserved for the System Administrator role: ${reserved.join(', ')}` }]);
    }
    return unique.sort();
  }

  private async permissionsOf(tx: Tx, roleId: string): Promise<string[]> {
    const rows = await tx
      .select({ k: rolePermission.permissionKey })
      .from(rolePermission)
      .where(eq(rolePermission.roleId, roleId));
    return rows.map((r) => r.k).sort();
  }
}

function toDto(r: typeof role.$inferSelect, permissions: string[]): RoleDto {
  return {
    id: r.id,
    key: r.key,
    nameAr: r.nameAr,
    nameEn: r.nameEn,
    description: r.description,
    isSystem: r.isSystem,
    permissions,
    version: r.version,
  };
}
