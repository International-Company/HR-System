import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gte, ilike, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';
import type { AssignmentDto, SessionDto, UserDto } from '@hrms/shared';
import type { z } from 'zod';
import type { assignmentCreateInput, userCreateInput, userUpdateInput } from '@hrms/shared';
import { DATABASE } from '../common/tokens.js';
import type { Database, Tx } from '../db/database.js';
import { company, department, role, roleAssignment, session, userAccount } from '../db/schema.js';
import { ApiError } from '../common/errors.js';
import { uuidv7 } from '../common/ids.js';
import type { Principal } from '../access/principal.js';
import { AuditService } from '../audit/audit.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { PasswordService } from '../auth/password.service.js';
import { SessionService } from '../auth/session.service.js';
import { clearTotp, toSessionDto } from '../auth/auth.service.js';

type UserRow = typeof userAccount.$inferSelect;

const toUserDto = (u: UserRow): UserDto => ({
  id: u.id,
  username: u.username,
  displayName: u.displayName,
  email: u.email,
  status: u.status,
  mfaEnabled: !!u.totpEnabledAt,
  locked: !!u.lockedUntil && u.lockedUntil.getTime() > Date.now(),
  mustChangePassword: u.mustChangePassword,
  lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
  version: u.version,
});

/** Account administration (AUTH-07, AUTH-08) and role assignment (RBAC-02, RBAC-04). */
@Injectable()
export class UsersService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}

  /**
   * Group-scoped viewers see every account; company-scoped viewers see accounts that hold
   * an active assignment in one of their companies.
   */
  async list(principal: Principal, q?: string): Promise<UserDto[]> {
    const scope = principal.scope('identity.user.view');
    return this.database.tx(principal.rls(), async (tx) => {
      const filters = [];
      if (q) {
        const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
        filters.push(or(ilike(userAccount.username, like), ilike(userAccount.displayName, like)));
      }
      if (!scope.all) {
        const ids = await this.userIdsInCompanies(tx, scope.companyIds);
        if (!ids.length) return [];
        filters.push(inArray(userAccount.id, ids));
      }
      const rows = await tx
        .select()
        .from(userAccount)
        .where(and(...filters))
        .orderBy(asc(userAccount.username))
        .limit(500);
      return rows.map(toUserDto);
    });
  }

  async get(principal: Principal, id: string): Promise<UserDto> {
    return toUserDto(await this.loadVisible(principal, id));
  }

  async create(principal: Principal, input: z.infer<typeof userCreateInput>): Promise<UserDto> {
    const policy = await this.settings.get('security.passwordPolicy');
    this.passwords.assertPolicy(input.temporaryPassword, { ...policy, username: input.username });
    const passwordHash = await this.passwords.hash(input.temporaryPassword);
    return this.database.tx(principal.rls(), async (tx) => {
      const [exists] = await tx
        .select({ id: userAccount.id })
        .from(userAccount)
        .where(eq(userAccount.username, input.username));
      if (exists) throw ApiError.conflict('The username is already taken');
      const [row] = await tx
        .insert(userAccount)
        .values({
          id: uuidv7(),
          username: input.username.toLowerCase(),
          displayName: input.displayName,
          email: input.email ?? null,
          passwordHash,
          mustChangePassword: true,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();
      const dto = toUserDto(row!);
      await this.audit.record(tx, {
        action: 'identity.user.created',
        entityType: 'user',
        entityId: dto.id,
        after: dto,
      });
      return dto;
    });
  }

  async update(principal: Principal, id: string, input: z.infer<typeof userUpdateInput>) {
    return this.database.tx(principal.rls(), async (tx) => {
      const before = await this.loadVisible(principal, id, tx);
      const [after] = await tx
        .update(userAccount)
        .set({ displayName: input.displayName, email: input.email, updatedBy: principal.userId })
        .where(and(eq(userAccount.id, id), eq(userAccount.version, input.version)))
        .returning();
      if (!after) throw ApiError.versionConflict();
      await this.audit.record(tx, {
        action: 'identity.user.updated',
        entityType: 'user',
        entityId: id,
        before: toUserDto(before),
        after: toUserDto(after),
      });
      return toUserDto(after);
    });
  }

  async setStatus(principal: Principal, id: string, status: 'active' | 'disabled', reason: string) {
    if (id === principal.userId) throw ApiError.forbidden('You cannot change the status of your own account');
    return this.database.tx(principal.rls(), async (tx) => {
      const before = await this.loadVisible(principal, id, tx);
      if (status === 'disabled') await this.assertNotLastAdmin(tx, id);
      const [after] = await tx
        .update(userAccount)
        .set({ status, updatedBy: principal.userId })
        .where(eq(userAccount.id, id))
        .returning();
      let revoked = 0;
      if (status === 'disabled') revoked = await this.sessions.revokeAllForUser(tx, id, 'user_disabled');
      await this.audit.record(tx, {
        action: status === 'disabled' ? 'identity.user.disabled' : 'identity.user.enabled',
        entityType: 'user',
        entityId: id,
        before: { status: before.status },
        after: { status },
        details: { reason, sessionsRevoked: revoked },
      });
      return toUserDto(after!);
    });
  }

  async resetPassword(principal: Principal, id: string, temporaryPassword: string) {
    const target = await this.loadVisible(principal, id);
    const policy = await this.settings.get('security.passwordPolicy');
    this.passwords.assertPolicy(temporaryPassword, { ...policy, username: target.username });
    const passwordHash = await this.passwords.hash(temporaryPassword);
    await this.database.tx(principal.rls(), async (tx) => {
      await tx
        .update(userAccount)
        .set({
          passwordHash,
          passwordChangedAt: new Date(),
          mustChangePassword: true,
          failedLoginCount: 0,
          lockedUntil: null,
          updatedBy: principal.userId,
        })
        .where(eq(userAccount.id, id));
      const revoked = await this.sessions.revokeAllForUser(tx, id, 'password_reset');
      await this.audit.record(tx, {
        action: 'identity.user.password_reset',
        entityType: 'user',
        entityId: id,
        details: { sessionsRevoked: revoked },
      });
    });
  }

  async resetMfa(principal: Principal, id: string) {
    await this.loadVisible(principal, id);
    await this.database.tx(principal.rls(), async (tx) => {
      await clearTotp(tx, id);
      const revoked = await this.sessions.revokeAllForUser(tx, id, 'mfa_reset');
      await this.audit.record(tx, {
        action: 'identity.user.mfa_reset',
        entityType: 'user',
        entityId: id,
        details: { sessionsRevoked: revoked },
      });
    });
  }

  async unlock(principal: Principal, id: string) {
    await this.loadVisible(principal, id);
    await this.database.tx(principal.rls(), async (tx) => {
      await tx
        .update(userAccount)
        .set({ failedLoginCount: 0, lockedUntil: null, updatedBy: principal.userId })
        .where(eq(userAccount.id, id));
      await this.audit.record(tx, { action: 'identity.user.unlocked', entityType: 'user', entityId: id });
    });
  }

  async listSessions(principal: Principal, id: string): Promise<SessionDto[]> {
    await this.loadVisible(principal, id);
    return (await this.sessions.listActive(id)).map((s) => toSessionDto(s, principal.sessionId));
  }

  async revokeSession(principal: Principal, userId: string, sessionId: string | null) {
    await this.loadVisible(principal, userId);
    await this.database.tx(principal.rls(), async (tx) => {
      let count: number;
      if (sessionId) {
        const rows = await tx
          .update(session)
          .set({ revokedAt: new Date(), revokedReason: 'revoked_by_admin' })
          .where(and(eq(session.id, sessionId), eq(session.userId, userId), isNull(session.revokedAt)))
          .returning({ id: session.id });
        if (!rows.length) throw ApiError.notFound('Session');
        count = 1;
      } else {
        count = await this.sessions.revokeAllForUser(tx, userId, 'revoked_by_admin');
      }
      await this.audit.record(tx, {
        action: 'identity.session.revoked',
        entityType: 'user',
        entityId: userId,
        details: { sessionId, count },
      });
    });
  }

  // --- Role assignments ------------------------------------------------------------

  async listAssignments(principal: Principal, userId: string): Promise<AssignmentDto[]> {
    await this.loadVisible(principal, userId);
    const rows = await this.database.tx(principal.rls(), (tx) =>
      tx
        .select({ a: roleAssignment, roleKey: role.key })
        .from(roleAssignment)
        .innerJoin(role, eq(role.id, roleAssignment.roleId))
        .where(eq(roleAssignment.userId, userId))
        .orderBy(asc(roleAssignment.createdAt)),
    );
    return rows.map(({ a, roleKey }) => ({
      id: a.id,
      userId: a.userId,
      roleId: a.roleId,
      roleKey,
      scopeType: a.scopeType,
      companyId: a.companyId,
      departmentId: a.departmentId,
      validFrom: a.validFrom,
      validTo: a.validTo,
      endedAt: a.endedAt?.toISOString() ?? null,
    }));
  }

  async addAssignment(
    principal: Principal,
    userId: string,
    input: z.infer<typeof assignmentCreateInput>,
  ): Promise<void> {
    // Prevent self-escalation: nobody changes their own access.
    if (userId === principal.userId) throw ApiError.forbidden('You cannot change your own role assignments');
    const companyId = input.companyId ?? null;
    const departmentId = input.departmentId ?? null;
    const shapeOk =
      ((input.scopeType === 'GROUP' || input.scopeType === 'SELF') && !companyId && !departmentId) ||
      (input.scopeType === 'COMPANY' && companyId && !departmentId) ||
      (input.scopeType === 'DEPARTMENT' && companyId && departmentId);
    if (!shapeOk) {
      throw ApiError.validation([
        { path: 'scopeType', message: 'companyId/departmentId do not match the scope type' },
      ]);
    }
    await this.database.tx(principal.rls(), async (tx) => {
      await this.loadVisible(principal, userId, tx);
      const [r] = await tx.select().from(role).where(eq(role.id, input.roleId));
      if (!r) throw ApiError.validation([{ path: 'roleId', message: 'Unknown role' }]);
      if (companyId) {
        const [c] = await tx.select({ id: company.id }).from(company).where(eq(company.id, companyId));
        if (!c) throw ApiError.validation([{ path: 'companyId', message: 'Unknown company' }]);
      }
      if (departmentId) {
        const [d] = await tx
          .select({ id: department.id })
          .from(department)
          .where(and(eq(department.id, departmentId), eq(department.companyId, companyId!)));
        if (!d) throw ApiError.validation([{ path: 'departmentId', message: 'Unknown department' }]);
      }
      const id = uuidv7();
      await tx.insert(roleAssignment).values({
        id,
        userId,
        roleId: r.id,
        scopeType: input.scopeType,
        companyId,
        departmentId,
        validFrom: input.validFrom ?? sql`current_date`,
        validTo: input.validTo ?? null,
        createdBy: principal.userId,
      } as typeof roleAssignment.$inferInsert);
      await this.audit.record(tx, {
        action: 'access.assignment.created',
        entityType: 'role_assignment',
        entityId: id,
        companyId,
        after: { userId, role: r.key, scopeType: input.scopeType, companyId, departmentId },
      });
    });
  }

  async endAssignment(principal: Principal, userId: string, assignmentId: string): Promise<void> {
    if (userId === principal.userId) throw ApiError.forbidden('You cannot change your own role assignments');
    await this.database.tx(principal.rls(), async (tx) => {
      const [a] = await tx
        .select({ a: roleAssignment, roleKey: role.key })
        .from(roleAssignment)
        .innerJoin(role, eq(role.id, roleAssignment.roleId))
        .where(
          and(
            eq(roleAssignment.id, assignmentId),
            eq(roleAssignment.userId, userId),
            isNull(roleAssignment.endedAt),
          ),
        );
      if (!a) throw ApiError.notFound('Assignment');
      if (a.roleKey === 'system_admin' && a.a.scopeType === 'GROUP') {
        await this.assertNotLastAdmin(tx, userId);
      }
      await tx
        .update(roleAssignment)
        .set({ endedAt: new Date(), endedBy: principal.userId })
        .where(eq(roleAssignment.id, assignmentId));
      await this.audit.record(tx, {
        action: 'access.assignment.ended',
        entityType: 'role_assignment',
        entityId: assignmentId,
        companyId: a.a.companyId,
        before: { userId, role: a.roleKey, scopeType: a.a.scopeType, companyId: a.a.companyId },
      });
    });
  }

  // --- helpers -----------------------------------------------------------------------

  private async loadVisible(principal: Principal, id: string, tx?: Tx): Promise<UserRow> {
    const run = async (t: Tx) => {
      const [u] = await t.select().from(userAccount).where(eq(userAccount.id, id));
      if (!u) throw ApiError.notFound('User');
      const scope = principal.scope('identity.user.view');
      if (!scope.all) {
        const ids = await this.userIdsInCompanies(t, scope.companyIds);
        if (!ids.includes(id)) throw ApiError.notFound('User');
      }
      return u;
    };
    return tx ? run(tx) : this.database.tx(principal.rls(), run);
  }

  private async userIdsInCompanies(tx: Tx, companyIds: string[]): Promise<string[]> {
    if (!companyIds.length) return [];
    const rows = await tx
      .selectDistinct({ userId: roleAssignment.userId })
      .from(roleAssignment)
      .where(
        and(
          inArray(roleAssignment.companyId, companyIds),
          isNull(roleAssignment.endedAt),
          lte(roleAssignment.validFrom, sql`current_date`),
          or(isNull(roleAssignment.validTo), gte(roleAssignment.validTo, sql`current_date`)),
        ),
      );
    return rows.map((r) => r.userId);
  }

  /** Never allow the group to be left without an active System Administrator. */
  private async assertNotLastAdmin(tx: Tx, userId: string): Promise<void> {
    const others = await tx
      .select({ id: roleAssignment.id })
      .from(roleAssignment)
      .innerJoin(role, eq(role.id, roleAssignment.roleId))
      .innerJoin(userAccount, eq(userAccount.id, roleAssignment.userId))
      .where(
        and(
          eq(role.key, 'system_admin'),
          eq(roleAssignment.scopeType, 'GROUP'),
          isNull(roleAssignment.endedAt),
          ne(roleAssignment.userId, userId),
          eq(userAccount.status, 'active'),
        ),
      )
      .limit(1);
    if (!others.length) {
      throw ApiError.conflict('At least one other active System Administrator is required');
    }
  }
}
