import type { PermissionKey, ScopeType, SessionState } from '@hrms/shared';
import type { RlsScope } from '../db/database.js';

export interface Grant {
  scopeType: ScopeType;
  companyId: string | null;
  departmentId: string | null;
}

export type CompanyScope =
  | { all: true }
  | { all: false; companyIds: string[]; departmentIds: string[] };

/**
 * The authenticated user's effective access, computed per request from active role
 * assignments (authorization-model.md §1). Default deny.
 */
export class Principal {
  constructor(
    readonly userId: string,
    readonly username: string,
    readonly sessionId: string,
    readonly state: SessionState,
    readonly roleKeys: ReadonlySet<string>,
    private readonly grants: ReadonlyMap<string, readonly Grant[]>,
    private readonly assignmentCompanyIds: readonly string[],
    private readonly hasGroupAssignment: boolean,
  ) {}

  has(perm: PermissionKey): boolean {
    return (this.grants.get(perm)?.length ?? 0) > 0;
  }

  hasGroup(perm: PermissionKey): boolean {
    return this.grants.get(perm)?.some((g) => g.scopeType === 'GROUP') ?? false;
  }

  permissions(): string[] {
    return [...this.grants.keys()].filter((k) => (this.grants.get(k)?.length ?? 0) > 0).sort();
  }

  /** Which companies (and departments) the permission reaches. */
  scope(perm: PermissionKey): CompanyScope {
    const grants = this.grants.get(perm) ?? [];
    if (grants.some((g) => g.scopeType === 'GROUP')) return { all: true };
    const companyIds = new Set<string>();
    const departmentIds = new Set<string>();
    for (const g of grants) {
      if (g.scopeType === 'COMPANY' && g.companyId) companyIds.add(g.companyId);
      if (g.scopeType === 'DEPARTMENT' && g.departmentId) departmentIds.add(g.departmentId);
    }
    return { all: false, companyIds: [...companyIds], departmentIds: [...departmentIds] };
  }

  /** Company-level reach (GROUP or COMPANY scope). Department grants do not count. */
  canCompany(perm: PermissionKey, companyId: string): boolean {
    const s = this.scope(perm);
    return s.all || s.companyIds.includes(companyId);
  }

  /** Companies where the permission applies at any level (company or department). */
  touchesCompany(perm: PermissionKey, companyId: string): boolean {
    const grants = this.grants.get(perm) ?? [];
    return grants.some(
      (g) =>
        g.scopeType === 'GROUP' ||
        ((g.scopeType === 'COMPANY' || g.scopeType === 'DEPARTMENT') && g.companyId === companyId),
    );
  }

  canDepartment(perm: PermissionKey, companyId: string, departmentId: string): boolean {
    const s = this.scope(perm);
    return s.all || s.companyIds.includes(companyId) || s.departmentIds.includes(departmentId);
  }

  /** Coarse RLS scope: union of every company the user has any assignment in. */
  rls(): RlsScope {
    return {
      group: this.hasGroupAssignment,
      companyIds: this.assignmentCompanyIds,
      userId: this.userId,
    };
  }
}
