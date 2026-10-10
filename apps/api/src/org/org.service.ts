import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, or, type SQL } from 'drizzle-orm';
import type { CompanyDto, DepartmentDto, LocationDto } from '@hrms/shared';
import type { z } from 'zod';
import type {
  companyCreateInput,
  companyUpdateInput,
  departmentCreateInput,
  departmentUpdateInput,
  groupUpdateInput,
  locationCreateInput,
  locationUpdateInput,
} from '@hrms/shared';
import { DATABASE } from '../common/tokens.js';
import type { Database, Tx } from '../db/database.js';
import { company, companyGroup, department, workLocation } from '../db/schema.js';
import { ApiError } from '../common/errors.js';
import { uuidv7 } from '../common/ids.js';
import type { Principal } from '../access/principal.js';
import { AuditService } from '../audit/audit.service.js';

type CompanyRow = typeof company.$inferSelect;
type DepartmentRow = typeof department.$inferSelect;
type LocationRow = typeof workLocation.$inferSelect;

export const toCompanyDto = (r: CompanyRow): CompanyDto => ({
  id: r.id,
  code: r.code,
  nameAr: r.nameAr,
  nameEn: r.nameEn,
  status: r.status,
  version: r.version,
});
const toDepartmentDto = (r: DepartmentRow): DepartmentDto => ({
  id: r.id,
  companyId: r.companyId,
  parentId: r.parentId,
  code: r.code,
  nameAr: r.nameAr,
  nameEn: r.nameEn,
  status: r.status,
  version: r.version,
});
const toLocationDto = (r: LocationRow): LocationDto => ({
  id: r.id,
  companyId: r.companyId,
  code: r.code,
  nameAr: r.nameAr,
  nameEn: r.nameEn,
  address: r.address,
  status: r.status,
  version: r.version,
});

/** Organisation structure: group → companies → optional departments; work locations. */
@Injectable()
export class OrgService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  // --- Group ----------------------------------------------------------------

  async getGroup(principal: Principal) {
    const [g] = await this.database.tx(principal.rls(), (tx) => tx.select().from(companyGroup));
    if (!g) throw ApiError.notFound('Company group');
    return { id: g.id, nameAr: g.nameAr, nameEn: g.nameEn, version: g.version };
  }

  async updateGroup(principal: Principal, input: z.infer<typeof groupUpdateInput>) {
    return this.database.tx(principal.rls(), async (tx) => {
      const [before] = await tx.select().from(companyGroup);
      if (!before) throw ApiError.notFound('Company group');
      const [after] = await tx
        .update(companyGroup)
        .set({ nameAr: input.nameAr, nameEn: input.nameEn, updatedBy: principal.userId })
        .where(and(eq(companyGroup.id, before.id), eq(companyGroup.version, input.version)))
        .returning();
      if (!after) throw ApiError.versionConflict();
      await this.audit.record(tx, {
        action: 'org.group.updated',
        entityType: 'company_group',
        entityId: after.id,
        before: { nameAr: before.nameAr, nameEn: before.nameEn },
        after: { nameAr: after.nameAr, nameEn: after.nameEn },
      });
      return { id: after.id, nameAr: after.nameAr, nameEn: after.nameEn, version: after.version };
    });
  }

  // --- Companies --------------------------------------------------------------

  async listCompanies(principal: Principal): Promise<CompanyDto[]> {
    const grants = principal.scope('org.company.view');
    return this.database.tx(principal.rls(), async (tx) => {
      let where: SQL | undefined;
      if (!grants.all) {
        // Department-scoped viewers see the companies their departments belong to.
        const deptCompanyIds = grants.departmentIds.length
          ? (
              await tx
                .select({ companyId: department.companyId })
                .from(department)
                .where(inArray(department.id, grants.departmentIds))
            ).map((r) => r.companyId)
          : [];
        const ids = [...new Set([...grants.companyIds, ...deptCompanyIds])];
        if (!ids.length) return [];
        where = inArray(company.id, ids);
      }
      const rows = await tx.select().from(company).where(where).orderBy(asc(company.code));
      return rows.map(toCompanyDto);
    });
  }

  async getCompany(principal: Principal, id: string): Promise<CompanyDto> {
    const list = await this.listCompanies(principal);
    const found = list.find((c) => c.id === id);
    if (!found) throw ApiError.notFound('Company');
    return found;
  }

  async createCompany(principal: Principal, input: z.infer<typeof companyCreateInput>) {
    return this.database.tx(principal.rls(), async (tx) => {
      const [group] = await tx.select({ id: companyGroup.id }).from(companyGroup);
      if (!group) throw new ApiError(409, 'NOT_CONFIGURED', 'The company group is not set up');
      const [row] = await tx
        .insert(company)
        .values({
          id: uuidv7(),
          groupId: group.id,
          code: input.code,
          nameAr: input.nameAr,
          nameEn: input.nameEn,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();
      const dto = toCompanyDto(row!);
      await this.audit.record(tx, {
        action: 'org.company.created',
        entityType: 'company',
        entityId: dto.id,
        companyId: dto.id,
        after: dto,
      });
      return dto;
    });
  }

  async updateCompany(principal: Principal, id: string, input: z.infer<typeof companyUpdateInput>) {
    return this.database.tx(principal.rls(), async (tx) => {
      const [before] = await tx.select().from(company).where(eq(company.id, id));
      if (!before || !principal.canCompany('org.company.edit', id)) throw ApiError.notFound('Company');
      const [after] = await tx
        .update(company)
        .set({
          nameAr: input.nameAr,
          nameEn: input.nameEn,
          status: input.status,
          updatedBy: principal.userId,
        })
        .where(and(eq(company.id, id), eq(company.version, input.version)))
        .returning();
      if (!after) throw ApiError.versionConflict();
      await this.audit.record(tx, {
        action: 'org.company.updated',
        entityType: 'company',
        entityId: id,
        companyId: id,
        before: toCompanyDto(before),
        after: toCompanyDto(after),
      });
      return toCompanyDto(after);
    });
  }

  // --- Departments ------------------------------------------------------------

  async listDepartments(principal: Principal, companyId: string): Promise<DepartmentDto[]> {
    if (!principal.touchesCompany('org.department.view', companyId)) {
      throw ApiError.notFound('Company');
    }
    const grants = principal.scope('org.department.view');
    return this.database.tx(principal.rls(), async (tx) => {
      const conditions: SQL[] = [eq(department.companyId, companyId)];
      if (!grants.all && !grants.companyIds.includes(companyId)) {
        conditions.push(inArray(department.id, grants.departmentIds));
      }
      const rows = await tx
        .select()
        .from(department)
        .where(and(...conditions))
        .orderBy(asc(department.code));
      return rows.map(toDepartmentDto);
    });
  }

  async createDepartment(
    principal: Principal,
    companyId: string,
    input: z.infer<typeof departmentCreateInput>,
  ) {
    if (!principal.canCompany('org.department.manage', companyId)) throw ApiError.notFound('Company');
    return this.database.tx(principal.rls(), async (tx) => {
      await this.assertCompanyExists(tx, companyId);
      if (input.parentId) await this.assertDepartmentInCompany(tx, input.parentId, companyId);
      const [row] = await tx
        .insert(department)
        .values({
          id: uuidv7(),
          companyId,
          parentId: input.parentId ?? null,
          code: input.code,
          nameAr: input.nameAr,
          nameEn: input.nameEn,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();
      const dto = toDepartmentDto(row!);
      await this.audit.record(tx, {
        action: 'org.department.created',
        entityType: 'department',
        entityId: dto.id,
        companyId,
        after: dto,
      });
      return dto;
    });
  }

  async updateDepartment(
    principal: Principal,
    id: string,
    input: z.infer<typeof departmentUpdateInput>,
  ) {
    return this.database.tx(principal.rls(), async (tx) => {
      const [before] = await tx.select().from(department).where(eq(department.id, id));
      if (!before || !principal.canCompany('org.department.manage', before.companyId)) {
        throw ApiError.notFound('Department');
      }
      if (input.parentId) {
        await this.assertDepartmentInCompany(tx, input.parentId, before.companyId);
        await this.assertNoCycle(tx, id, input.parentId);
      }
      const [after] = await tx
        .update(department)
        .set({
          nameAr: input.nameAr,
          nameEn: input.nameEn,
          parentId: input.parentId,
          status: input.status,
          updatedBy: principal.userId,
        })
        .where(and(eq(department.id, id), eq(department.version, input.version)))
        .returning();
      if (!after) throw ApiError.versionConflict();
      await this.audit.record(tx, {
        action: 'org.department.updated',
        entityType: 'department',
        entityId: id,
        companyId: after.companyId,
        before: toDepartmentDto(before),
        after: toDepartmentDto(after),
      });
      return toDepartmentDto(after);
    });
  }

  // --- Work locations -----------------------------------------------------------

  async listLocations(principal: Principal, companyId: string): Promise<LocationDto[]> {
    if (!principal.canCompany('org.location.view', companyId)) throw ApiError.notFound('Company');
    return this.database.tx(principal.rls(), async (tx) => {
      const rows = await tx
        .select()
        .from(workLocation)
        .where(eq(workLocation.companyId, companyId))
        .orderBy(asc(workLocation.code));
      return rows.map(toLocationDto);
    });
  }

  async createLocation(
    principal: Principal,
    companyId: string,
    input: z.infer<typeof locationCreateInput>,
  ) {
    if (!principal.canCompany('org.location.manage', companyId)) throw ApiError.notFound('Company');
    return this.database.tx(principal.rls(), async (tx) => {
      await this.assertCompanyExists(tx, companyId);
      const [row] = await tx
        .insert(workLocation)
        .values({
          id: uuidv7(),
          companyId,
          code: input.code,
          nameAr: input.nameAr,
          nameEn: input.nameEn,
          address: input.address ?? null,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();
      const dto = toLocationDto(row!);
      await this.audit.record(tx, {
        action: 'org.location.created',
        entityType: 'work_location',
        entityId: dto.id,
        companyId,
        after: dto,
      });
      return dto;
    });
  }

  async updateLocation(principal: Principal, id: string, input: z.infer<typeof locationUpdateInput>) {
    return this.database.tx(principal.rls(), async (tx) => {
      const [before] = await tx.select().from(workLocation).where(eq(workLocation.id, id));
      if (!before || !principal.canCompany('org.location.manage', before.companyId)) {
        throw ApiError.notFound('Work location');
      }
      const [after] = await tx
        .update(workLocation)
        .set({
          nameAr: input.nameAr,
          nameEn: input.nameEn,
          address: input.address,
          status: input.status,
          updatedBy: principal.userId,
        })
        .where(and(eq(workLocation.id, id), eq(workLocation.version, input.version)))
        .returning();
      if (!after) throw ApiError.versionConflict();
      await this.audit.record(tx, {
        action: 'org.location.updated',
        entityType: 'work_location',
        entityId: id,
        companyId: after.companyId,
        before: toLocationDto(before),
        after: toLocationDto(after),
      });
      return toLocationDto(after);
    });
  }

  // --- helpers ------------------------------------------------------------------

  private async assertCompanyExists(tx: Tx, companyId: string) {
    const [c] = await tx.select({ id: company.id }).from(company).where(eq(company.id, companyId));
    if (!c) throw ApiError.notFound('Company');
  }

  private async assertDepartmentInCompany(tx: Tx, departmentId: string, companyId: string) {
    const [d] = await tx
      .select({ id: department.id })
      .from(department)
      .where(and(eq(department.id, departmentId), eq(department.companyId, companyId)));
    if (!d) {
      throw ApiError.validation([
        { path: 'parentId', message: 'Parent department must belong to the same company' },
      ]);
    }
  }

  private async assertNoCycle(tx: Tx, id: string, parentId: string) {
    let current: string | null = parentId;
    for (let depth = 0; current && depth < 100; depth++) {
      if (current === id) {
        throw ApiError.validation([{ path: 'parentId', message: 'A department cannot be its own ancestor' }]);
      }
      const [row]: { parentId: string | null }[] = await tx
        .select({ parentId: department.parentId })
        .from(department)
        .where(eq(department.id, current));
      current = row?.parentId ?? null;
    }
  }

  /** Used by user-scoping: companies a principal may see for a permission. */
  async visibleCompanyIds(principal: Principal, perm: Parameters<Principal['scope']>[0]) {
    const s = principal.scope(perm);
    if (s.all) return null;
    if (!s.departmentIds.length) return s.companyIds;
    const rows = await this.database.tx(principal.rls(), (tx) =>
      tx
        .select({ companyId: department.companyId })
        .from(department)
        .where(or(inArray(department.id, s.departmentIds))),
    );
    return [...new Set([...s.companyIds, ...rows.map((r) => r.companyId)])];
  }
}
