import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import type {
  AssignmentRecordDto,
  BankAccountDto,
  CompensationDto,
  EmployeeDto,
  EmployeeHistoryDto,
  EmployeeSummaryDto,
  LifecycleEventDto,
  QualificationDto,
  assignmentChangeInput,
  bankAccountInput,
  compensationChangeInput,
  compensationFields,
  employeeCreateInput,
  employeeListQuery,
  personalUpdateInput,
  qualificationInput,
  rehireInput,
  statusChangeInput,
} from '@hrms/shared';
import { DATABASE, ENCRYPTOR } from '../common/tokens.js';
import type { Database, Tx } from '../db/database.js';
import {
  bankAccount,
  compensation,
  compensationItem,
  employee,
  employeeCurrentAssignment,
  employmentAssignment,
  lifecycleEvent,
  qualification,
  separation,
  userAccount,
} from '../db/schema.js';
import { ApiError } from '../common/errors.js';
import type { Encryptor } from '../common/crypto.js';
import { uuidv7 } from '../common/ids.js';
import type { Principal } from '../access/principal.js';
import { AuditService } from '../audit/audit.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { assertLookups } from './lookups.service.js';

type EmployeeRow = typeof employee.$inferSelect;
type AssignmentRow = typeof employmentAssignment.$inferSelect;
type CompensationRow = typeof compensation.$inferSelect;

export interface Access {
  view: boolean;
  self: boolean;
  editPersonal: boolean;
  manageLifecycle: boolean;
  financial: boolean;
  editFinancial: boolean;
  identity: boolean;
}

/** Selectable columns of the current-assignment view (views cannot be selected as a whole). */
const currentFields = {
  id: employeeCurrentAssignment.id,
  employeeId: employeeCurrentAssignment.employeeId,
  companyId: employeeCurrentAssignment.companyId,
  departmentId: employeeCurrentAssignment.departmentId,
  jobTitleId: employeeCurrentAssignment.jobTitleId,
  managerEmployeeId: employeeCurrentAssignment.managerEmployeeId,
  workLocationId: employeeCurrentAssignment.workLocationId,
  employmentCategoryId: employeeCurrentAssignment.employmentCategoryId,
  contractTypeId: employeeCurrentAssignment.contractTypeId,
  contractStart: employeeCurrentAssignment.contractStart,
  contractEnd: employeeCurrentAssignment.contractEnd,
  validFrom: employeeCurrentAssignment.validFrom,
  validTo: employeeCurrentAssignment.validTo,
  changeReason: employeeCurrentAssignment.changeReason,
  createdAt: employeeCurrentAssignment.createdAt,
  createdBy: employeeCurrentAssignment.createdBy,
};

export function dayBefore(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

const toAssignmentDto = (a: AssignmentRow): AssignmentRecordDto => ({
  id: a.id,
  companyId: a.companyId,
  departmentId: a.departmentId,
  jobTitleId: a.jobTitleId,
  managerEmployeeId: a.managerEmployeeId,
  workLocationId: a.workLocationId,
  employmentCategoryId: a.employmentCategoryId,
  contractTypeId: a.contractTypeId,
  contractStart: a.contractStart,
  contractEnd: a.contractEnd,
  validFrom: a.validFrom,
  validTo: a.validTo,
  changeReason: a.changeReason,
});

/** Strip trailing zeros of numeric(18,4) values: "1500.0000" → "1500". */
const money = (v: string) => (v.includes('.') ? v.replace(/\.?0+$/, '') : v);

/**
 * Employee records (EMP-01..11): profile, effective-dated employment and compensation
 * history, lifecycle events. Access is resolved per record from the employee's current
 * assignment; RLS enforces the same boundary in the database.
 */
@Injectable()
export class EmployeesService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(ENCRYPTOR) private readonly encryptor: Encryptor,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SettingsService) private readonly settings: SettingsService,
  ) {}

  // --- access ------------------------------------------------------------------------

  access(principal: Principal, employeeId: string, current: AssignmentRow | null): Access {
    const self = !!principal.employeeId && principal.employeeId === employeeId;
    const cid = current?.companyId;
    const did = current?.departmentId ?? null;
    const scope = principal.scope('employee.profile.view');
    const inCompany = (perm: Parameters<Principal['canCompany']>[0]) => !!cid && principal.canCompany(perm, cid);
    const view =
      scope.all ||
      (!!cid && scope.companyIds.includes(cid)) ||
      (!!did && scope.departmentIds.includes(did)) ||
      principal.canSelf('employee.profile.view', employeeId);
    return {
      view,
      self,
      editPersonal: inCompany('employee.profile.edit'),
      manageLifecycle: inCompany('employee.lifecycle.manage'),
      financial: inCompany('employee.financial.view'),
      editFinancial: inCompany('employee.financial.edit'),
      identity: inCompany('employee.identity.view'),
    };
  }

  /** Load an employee the principal may see; 404 otherwise (existence is not revealed). */
  async loadVisible(principal: Principal, id: string, tx?: Tx) {
    const run = async (t: Tx) => {
      const [row] = await t.select().from(employee).where(eq(employee.id, id));
      if (!row) throw ApiError.notFound('Employee');
      const [current] = await t
        .select()
        .from(employeeCurrentAssignment)
        .where(eq(employeeCurrentAssignment.employeeId, id));
      const access = this.access(principal, id, (current as AssignmentRow | undefined) ?? null);
      if (!access.view) throw ApiError.notFound('Employee');
      return { row, current: (current as AssignmentRow | undefined) ?? null, access };
    };
    return tx ? run(tx) : this.database.tx(principal.rls(), run);
  }

  // --- list & read ---------------------------------------------------------------------

  async list(principal: Principal, q: z.infer<typeof employeeListQuery>): Promise<EmployeeSummaryDto[]> {
    const scope = principal.scope('employee.profile.view');
    return this.database.tx(principal.rls(), async (tx) => {
      const where: SQL[] = [];
      if (!scope.all) {
        const parts: SQL[] = [];
        if (scope.companyIds.length) parts.push(inArray(employeeCurrentAssignment.companyId, scope.companyIds));
        if (scope.departmentIds.length) parts.push(inArray(employeeCurrentAssignment.departmentId, scope.departmentIds));
        if (scope.self && principal.employeeId) parts.push(eq(employee.id, principal.employeeId));
        if (!parts.length) return [];
        where.push(or(...parts)!);
      }
      if (q.q) {
        const like = `%${q.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
        where.push(
          or(
            ilike(employee.fullNameAr, like),
            ilike(employee.fullNameEn, like),
            ilike(employee.employeeNo, like),
          )!,
        );
      }
      if (q.companyId) where.push(eq(employeeCurrentAssignment.companyId, q.companyId));
      if (q.departmentId) where.push(eq(employeeCurrentAssignment.departmentId, q.departmentId));
      if (q.status) where.push(eq(employee.status, q.status));
      const rows = await tx
        .select({ e: employee, a: currentFields })
        .from(employee)
        .leftJoin(employeeCurrentAssignment, eq(employeeCurrentAssignment.employeeId, employee.id))
        .where(and(...where))
        .orderBy(asc(employee.employeeNo))
        .limit(q.limit);
      return rows.map(({ e, a }) => summary(e, (a as AssignmentRow | null) ?? null));
    });
  }

  async get(principal: Principal, id: string): Promise<EmployeeDto> {
    return this.database.tx(principal.rls(), async (tx) => {
      const { row, current, access } = await this.loadVisible(principal, id, tx);
      let comp: CompensationDto | null = null;
      if (access.financial || access.self) {
        const [c] = await tx
          .select()
          .from(compensation)
          .where(
            and(
              eq(compensation.employeeId, id),
              sql`${compensation.validFrom} <= current_date`,
              or(isNull(compensation.validTo), sql`${compensation.validTo} >= current_date`),
            ),
          );
        if (c) comp = await this.compensationDto(tx, c);
      }
      const [linked] = await tx
        .select({ id: userAccount.id })
        .from(userAccount)
        .where(eq(userAccount.employeeId, id));
      if (access.identity && row.idNumberEnc) {
        await this.audit.record(tx, {
          action: 'employee.identity_viewed',
          entityType: 'employee',
          entityId: id,
          companyId: current?.companyId ?? null,
        });
      }
      return this.toDto(row, current, comp, access, linked?.id ?? null);
    });
  }

  private toDto(
    e: EmployeeRow,
    current: AssignmentRow | null,
    comp: CompensationDto | null,
    access: Access,
    linkedUserId: string | null,
  ): EmployeeDto {
    let idNumber: string | null = null;
    if (e.idNumberEnc) {
      const plain = this.encryptor.decryptString(e.idNumberEnc, `employee-id:${e.id}`);
      idNumber = access.identity || access.self ? plain : `••••${plain.slice(-3)}`;
    }
    return {
      ...summary(e, current),
      idType: e.idType,
      idNumber,
      idNumberMasked: !!e.idNumberEnc && !(access.identity || access.self),
      birthDate: e.birthDate,
      gender: e.gender,
      nationality: e.nationality,
      maritalStatus: e.maritalStatus,
      phone: e.phone,
      email: e.email,
      actualStartDate: e.actualStartDate,
      probationEndDate: e.probationEndDate,
      photoDocumentId: e.photoDocumentId,
      linkedUserId: access.editPersonal ? linkedUserId : null,
      current: current ? toAssignmentDto(current) : null,
      compensation: comp,
      access: {
        financial: access.financial,
        editPersonal: access.editPersonal,
        manageLifecycle: access.manageLifecycle,
        editFinancial: access.editFinancial,
        self: access.self,
      },
      version: e.version,
    };
  }

  private async compensationDto(tx: Tx, c: CompensationRow): Promise<CompensationDto> {
    const items = await tx.select().from(compensationItem).where(eq(compensationItem.compensationId, c.id));
    return {
      id: c.id,
      companyId: c.companyId,
      baseSalary: money(c.baseSalary),
      currency: c.currency,
      paymentMethod: c.paymentMethod,
      items: items.map((i) => ({ kind: i.kind, typeId: i.typeId, calc: i.calc, amount: money(i.amount) })),
      validFrom: c.validFrom,
      validTo: c.validTo,
      changeReason: c.changeReason,
    };
  }

  // --- create (hire) -----------------------------------------------------------------------

  async create(principal: Principal, input: z.infer<typeof employeeCreateInput>): Promise<EmployeeDto> {
    const a = input.assignment;
    if (!principal.canCompany('employee.profile.create', a.companyId)) throw ApiError.notFound('Company');
    if ((input.compensation || input.bankAccount) && !principal.canCompany('employee.financial.edit', a.companyId)) {
      throw ApiError.forbidden('Salary and bank data need the financial edit permission');
    }
    await this.assertManager(a.managerEmployeeId);
    const fmt = await this.settings.get('employee.numberFormat');
    const id = uuidv7();
    const today = new Date().toISOString().slice(0, 10);
    const status = input.probationEndDate && input.probationEndDate >= today ? 'probation' : 'active';

    await this.database.tx(principal.rls(), async (tx) => {
      await assertLookups(tx, a.companyId, [
        { id: a.jobTitleId, kind: 'job_title', field: 'assignment.jobTitleId' },
        { id: a.employmentCategoryId, kind: 'employment_category', field: 'assignment.employmentCategoryId' },
        { id: a.contractTypeId, kind: 'contract_type', field: 'assignment.contractTypeId' },
      ]);
      const employeeNo = await this.nextEmployeeNo(tx, fmt);
      const p = input.personal;
      const idNumber = p.idNumber?.trim().toUpperCase() || null;
      if (idNumber && !p.idType) throw ApiError.validation([{ path: 'personal.idType', message: 'Required with an ID number' }]);
      try {
        await tx.insert(employee).values({
          id,
          employeeNo,
          fullNameAr: p.fullNameAr,
          fullNameEn: p.fullNameEn,
          idType: idNumber ? p.idType! : null,
          idNumberEnc: idNumber ? this.encryptor.encrypt(idNumber, `employee-id:${id}`) : null,
          idNumberBidx: idNumber ? this.encryptor.blindIndex('employee-id', `${p.idType}:${idNumber}`) : null,
          birthDate: p.birthDate ?? null,
          gender: p.gender ?? null,
          nationality: p.nationality ?? null,
          maritalStatus: p.maritalStatus ?? null,
          phone: p.phone ?? null,
          email: p.email ?? null,
          hireDate: input.hireDate,
          actualStartDate: input.actualStartDate ?? null,
          probationEndDate: input.probationEndDate ?? null,
          status,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        });
      } catch (err) {
        if (isUniqueViolation(err, 'employee_id_number_unique')) {
          throw ApiError.conflict('An employee with this identity number already exists');
        }
        throw err;
      }
      await tx.insert(employmentAssignment).values({
        id: uuidv7(),
        employeeId: id,
        companyId: a.companyId,
        departmentId: a.departmentId ?? null,
        jobTitleId: a.jobTitleId ?? null,
        managerEmployeeId: a.managerEmployeeId ?? null,
        workLocationId: a.workLocationId ?? null,
        employmentCategoryId: a.employmentCategoryId ?? null,
        contractTypeId: a.contractTypeId ?? null,
        contractStart: a.contractStart ?? null,
        contractEnd: a.contractEnd ?? null,
        validFrom: input.hireDate,
        changeReason: 'hire',
        createdBy: principal.userId,
      });
      if (input.compensation) {
        await this.insertCompensation(tx, principal, id, a.companyId, input.hireDate, input.compensation, 'hire');
      }
      if (input.bankAccount) await this.insertBank(tx, principal, id, input.bankAccount);
      await this.event(tx, principal, id, a.companyId, 'hire', input.hireDate, { employeeNo, status });
      await this.audit.record(tx, {
        action: 'employee.created',
        entityType: 'employee',
        entityId: id,
        companyId: a.companyId,
        after: {
          employeeNo,
          fullNameEn: p.fullNameEn,
          hireDate: input.hireDate,
          companyId: a.companyId,
          withCompensation: !!input.compensation,
          withBankAccount: !!input.bankAccount,
        },
      });
    });
    return this.get(principal, id);
  }

  /** Sequential, group-wide numbers (EMP-06). A format change affects only new numbers. */
  private async nextEmployeeNo(tx: Tx, fmt: { prefix: string; padding: number }): Promise<string> {
    const result = await tx.execute<{ n: string }>(
      sql`select next_employee_no(${fmt.prefix}, ${fmt.padding}) as n`,
    );
    return (result as unknown as { rows: { n: string }[] }).rows[0]!.n;
  }

  private async assertManager(managerId: string | null | undefined): Promise<void> {
    if (!managerId) return;
    // A manager may work in another group company (Q-16 default), so check group-wide.
    const [m] = await this.database.system((t) =>
      t.select({ id: employee.id, status: employee.status }).from(employee).where(eq(employee.id, managerId)),
    );
    if (!m || m.status === 'terminated') {
      throw ApiError.validation([{ path: 'managerEmployeeId', message: 'Unknown or inactive manager' }]);
    }
  }

  // --- personal data -----------------------------------------------------------------------

  async updatePersonal(principal: Principal, id: string, input: z.infer<typeof personalUpdateInput>): Promise<EmployeeDto> {
    await this.database.tx(principal.rls(), async (tx) => {
      const { row, current, access } = await this.loadVisible(principal, id, tx);
      if (!access.editPersonal) throw ApiError.forbidden();
      const changes: Partial<typeof employee.$inferInsert> = {
        fullNameAr: input.fullNameAr,
        fullNameEn: input.fullNameEn,
        birthDate: input.birthDate,
        gender: input.gender,
        nationality: input.nationality,
        maritalStatus: input.maritalStatus,
        phone: input.phone,
        email: input.email,
        actualStartDate: input.actualStartDate,
        probationEndDate: input.probationEndDate,
        updatedBy: principal.userId,
      };
      if (input.idNumber !== undefined || input.idType !== undefined) {
        if (!access.identity) throw ApiError.forbidden('Changing identity numbers needs the identity permission');
        const idNumber = input.idNumber?.trim().toUpperCase() || null;
        const idType = input.idType ?? row.idType;
        if (idNumber && !idType) throw ApiError.validation([{ path: 'idType', message: 'Required with an ID number' }]);
        changes.idType = idNumber ? idType : null;
        changes.idNumberEnc = idNumber ? this.encryptor.encrypt(idNumber, `employee-id:${id}`) : null;
        changes.idNumberBidx = idNumber ? this.encryptor.blindIndex('employee-id', `${idType}:${idNumber}`) : null;
      }
      let after: EmployeeRow | undefined;
      try {
        [after] = await tx
          .update(employee)
          .set(changes)
          .where(and(eq(employee.id, id), eq(employee.version, input.version)))
          .returning();
      } catch (err) {
        if (isUniqueViolation(err, 'employee_id_number_unique')) {
          throw ApiError.conflict('An employee with this identity number already exists');
        }
        throw err;
      }
      if (!after) throw ApiError.versionConflict();
      await this.audit.record(tx, {
        action: 'employee.personal_updated',
        entityType: 'employee',
        entityId: id,
        companyId: current?.companyId ?? null,
        before: personalAudit(row),
        after: { ...personalAudit(after), identityChanged: changes.idNumberEnc !== undefined },
      });
    });
    return this.get(principal, id);
  }

  // --- lifecycle: assignment changes & transfers ------------------------------------------------

  async changeAssignment(principal: Principal, id: string, input: z.infer<typeof assignmentChangeInput>): Promise<EmployeeDto> {
    await this.assertManager(input.managerEmployeeId);
    if (input.managerEmployeeId === id) {
      throw ApiError.validation([{ path: 'managerEmployeeId', message: 'An employee cannot manage themselves' }]);
    }
    await this.database.tx(principal.rls(), async (tx) => {
      const { row, current, access } = await this.loadVisible(principal, id, tx);
      if (!access.manageLifecycle || !current) throw ApiError.forbidden();
      if (row.status === 'terminated') throw ApiError.conflict('The employee is terminated');
      const isTransfer = input.companyId !== current.companyId;
      if (isTransfer !== (input.event === 'transfer')) {
        throw ApiError.validation([{ path: 'event', message: 'Use "transfer" exactly when the company changes' }]);
      }
      if (isTransfer && !principal.canCompany('employee.lifecycle.manage', input.companyId)) {
        throw ApiError.forbidden('You cannot transfer employees into that company');
      }
      if (current.validTo) throw ApiError.conflict('Another change is already scheduled for this employee');
      if (input.effectiveDate <= current.validFrom) {
        throw ApiError.validation([{ path: 'effectiveDate', message: 'Must be after the start of the current assignment' }]);
      }
      await assertLookups(tx, input.companyId, [
        { id: input.jobTitleId, kind: 'job_title', field: 'jobTitleId' },
        { id: input.employmentCategoryId, kind: 'employment_category', field: 'employmentCategoryId' },
        { id: input.contractTypeId, kind: 'contract_type', field: 'contractTypeId' },
      ]);

      await tx
        .update(employmentAssignment)
        .set({ validTo: dayBefore(input.effectiveDate) })
        .where(eq(employmentAssignment.id, current.id));
      const next = {
        companyId: input.companyId,
        departmentId: input.departmentId ?? null,
        jobTitleId: input.jobTitleId ?? null,
        managerEmployeeId: input.managerEmployeeId ?? null,
        workLocationId: input.workLocationId ?? null,
        employmentCategoryId: input.employmentCategoryId ?? null,
        contractTypeId: input.contractTypeId ?? null,
        contractStart: input.contractStart ?? null,
        contractEnd: input.contractEnd ?? null,
      };
      await tx.insert(employmentAssignment).values({
        id: uuidv7(),
        employeeId: id,
        ...next,
        validFrom: input.effectiveDate,
        changeReason: input.reason,
        createdBy: principal.userId,
      });

      // On transfer, the running compensation continues in the new company (same terms)
      // so the receiving company's payroll sees it; the old row stays with the old company.
      if (isTransfer) {
        const [comp] = await tx
          .select()
          .from(compensation)
          .where(and(eq(compensation.employeeId, id), isNull(compensation.validTo)));
        if (comp) {
          if (comp.validFrom >= input.effectiveDate) {
            throw ApiError.conflict('A salary change is scheduled on or after the transfer date');
          }
          const items = await tx.select().from(compensationItem).where(eq(compensationItem.compensationId, comp.id));
          await tx.update(compensation).set({ validTo: dayBefore(input.effectiveDate) }).where(eq(compensation.id, comp.id));
          await this.insertCompensation(
            tx,
            principal,
            id,
            input.companyId,
            input.effectiveDate,
            {
              baseSalary: comp.baseSalary,
              currency: comp.currency,
              paymentMethod: comp.paymentMethod,
              items: items.map((i) => ({ kind: i.kind, typeId: i.typeId, calc: i.calc, amount: i.amount })),
            },
            'transfer',
          );
        }
      }

      const changed = Object.fromEntries(
        Object.entries(next).filter(([k, v]) => (current as Record<string, unknown>)[k] !== v),
      );
      await this.event(tx, principal, id, input.companyId, input.event, input.effectiveDate, {
        reason: input.reason,
        fromCompanyId: current.companyId,
        changed,
      });
      await this.audit.record(tx, {
        action: `employee.${input.event}`,
        entityType: 'employee',
        entityId: id,
        companyId: input.companyId,
        before: toAssignmentDto(current),
        after: { ...next, validFrom: input.effectiveDate, reason: input.reason },
      });
    });
    return this.get(principal, id);
  }

  // --- lifecycle: compensation -------------------------------------------------------------

  async changeCompensation(principal: Principal, id: string, input: z.infer<typeof compensationChangeInput>): Promise<EmployeeDto> {
    await this.database.tx(principal.rls(), async (tx) => {
      const { current, access } = await this.loadVisible(principal, id, tx);
      if (!access.editFinancial || !current) throw ApiError.forbidden();
      const [open] = await tx
        .select()
        .from(compensation)
        .where(and(eq(compensation.employeeId, id), isNull(compensation.validTo)));
      if (open) {
        if (input.effectiveDate <= open.validFrom) {
          throw ApiError.validation([{ path: 'effectiveDate', message: 'Must be after the start of the current salary' }]);
        }
        await tx.update(compensation).set({ validTo: dayBefore(input.effectiveDate) }).where(eq(compensation.id, open.id));
      }
      await this.insertCompensation(tx, principal, id, current.companyId, input.effectiveDate, input, input.reason);
      await this.event(tx, principal, id, current.companyId, input.event, input.effectiveDate, { reason: input.reason });
      await this.audit.record(tx, {
        action: `employee.${input.event}`,
        entityType: 'employee',
        entityId: id,
        companyId: current.companyId,
        before: open ? { baseSalary: money(open.baseSalary), currency: open.currency } : null,
        after: { baseSalary: input.baseSalary, currency: input.currency, effectiveDate: input.effectiveDate, items: input.items.length },
      });
    });
    return this.get(principal, id);
  }

  private async insertCompensation(
    tx: Tx,
    principal: Principal,
    employeeId: string,
    companyId: string,
    validFrom: string,
    c: z.infer<typeof compensationFields>,
    reason: string,
  ): Promise<void> {
    await assertLookups(
      tx,
      companyId,
      c.items.map((i, n) => ({
        id: i.typeId,
        kind: i.kind === 'allowance' ? ('allowance_type' as const) : ('deduction_type' as const),
        field: `items.${n}.typeId`,
      })),
    );
    const compId = uuidv7();
    await tx.insert(compensation).values({
      id: compId,
      employeeId,
      companyId,
      baseSalary: c.baseSalary,
      currency: c.currency,
      paymentMethod: c.paymentMethod,
      validFrom,
      changeReason: reason,
      createdBy: principal.userId,
    });
    if (c.items.length) {
      await tx.insert(compensationItem).values(
        c.items.map((i) => ({ id: uuidv7(), compensationId: compId, kind: i.kind, typeId: i.typeId, calc: i.calc, amount: i.amount })),
      );
    }
  }

  // --- lifecycle: status ---------------------------------------------------------------------

  async changeStatus(principal: Principal, id: string, input: z.infer<typeof statusChangeInput>): Promise<EmployeeDto> {
    await this.database.tx(principal.rls(), async (tx) => {
      const { row, current, access } = await this.loadVisible(principal, id, tx);
      if (!access.manageLifecycle) throw ApiError.forbidden();
      if (row.status === 'terminated') throw ApiError.conflict('Use rehire for terminated employees');
      if (row.status === input.status) throw ApiError.conflict('The employee already has this status');
      const type =
        row.status === 'probation' && input.status === 'active'
          ? 'probation_confirmed'
          : input.status === 'suspended'
            ? 'suspension'
            : input.status === 'long_leave'
              ? 'long_leave'
              : row.status === 'suspended' || row.status === 'long_leave'
                ? 'return_to_work'
                : 'status_change';
      await tx.update(employee).set({ status: input.status, updatedBy: principal.userId }).where(eq(employee.id, id));
      await this.event(tx, principal, id, current?.companyId ?? null, type, input.effectiveDate, {
        from: row.status,
        to: input.status,
        reason: input.reason,
      });
      await this.audit.record(tx, {
        action: `employee.${type}`,
        entityType: 'employee',
        entityId: id,
        companyId: current?.companyId ?? null,
        before: { status: row.status },
        after: { status: input.status, effectiveDate: input.effectiveDate, reason: input.reason },
      });
    });
    return this.get(principal, id);
  }

  // --- rehire (TRM-07) -------------------------------------------------------------------------

  /**
   * Rehire a former employee: same employee number and full history; a new assignment (and
   * salary) from the rehire date. Service-based rules (leave, end of service) count from the
   * rehire date; the original hire date stays in the history.
   */
  async rehire(principal: Principal, id: string, input: z.infer<typeof rehireInput>): Promise<EmployeeDto> {
    const a = input.assignment;
    if (!principal.canCompany('employee.lifecycle.manage', a.companyId)) throw ApiError.forbidden();
    if (input.compensation && !principal.canCompany('employee.financial.edit', a.companyId)) {
      throw ApiError.forbidden('Salary data needs the financial edit permission');
    }
    await this.assertManager(a.managerEmployeeId);
    const today = new Date().toISOString().slice(0, 10);
    await this.database.tx(principal.rls(), async (tx) => {
      const { row } = await this.loadVisible(principal, id, tx);
      if (row.status !== 'terminated') throw ApiError.conflict('Only former employees can be rehired');
      const [last] = await tx.select().from(employmentAssignment).where(eq(employmentAssignment.employeeId, id)).orderBy(desc(employmentAssignment.validFrom));
      if (last?.validTo && input.effectiveDate <= last.validTo) {
        throw ApiError.validation([{ path: 'effectiveDate', message: 'Must be after the last working day' }]);
      }
      const [sep] = await tx.select().from(separation).where(and(eq(separation.employeeId, id), eq(separation.status, 'completed'))).orderBy(desc(separation.lastWorkingDay));
      if (sep && !sep.rehireEligible) {
        if (!input.overrideIneligible) throw ApiError.conflict('The previous separation marked this person as not eligible for rehire');
        if (!principal.canCompany('separation.manage', a.companyId)) throw ApiError.forbidden('Overriding rehire eligibility needs the separation permission');
      }
      await assertLookups(tx, a.companyId, [
        { id: a.jobTitleId, kind: 'job_title', field: 'assignment.jobTitleId' },
        { id: a.employmentCategoryId, kind: 'employment_category', field: 'assignment.employmentCategoryId' },
        { id: a.contractTypeId, kind: 'contract_type', field: 'assignment.contractTypeId' },
      ]);
      const status = input.probationEndDate && input.probationEndDate >= today ? 'probation' : 'active';
      await tx
        .update(employee)
        .set({ status, hireDate: input.effectiveDate, probationEndDate: input.probationEndDate ?? null, updatedBy: principal.userId })
        .where(eq(employee.id, id));
      await tx.insert(employmentAssignment).values({
        id: uuidv7(),
        employeeId: id,
        companyId: a.companyId,
        departmentId: a.departmentId ?? null,
        jobTitleId: a.jobTitleId ?? null,
        managerEmployeeId: a.managerEmployeeId ?? null,
        workLocationId: a.workLocationId ?? null,
        employmentCategoryId: a.employmentCategoryId ?? null,
        contractTypeId: a.contractTypeId ?? null,
        contractStart: a.contractStart ?? null,
        contractEnd: a.contractEnd ?? null,
        validFrom: input.effectiveDate,
        changeReason: 'rehire',
        createdBy: principal.userId,
      });
      if (input.compensation) await this.insertCompensation(tx, principal, id, a.companyId, input.effectiveDate, input.compensation, 'rehire');
      await this.event(tx, principal, id, a.companyId, 'rehire', input.effectiveDate, {
        previousHireDate: row.hireDate,
        reason: input.reason,
        overrideIneligible: !!(sep && !sep.rehireEligible),
      });
      await this.audit.record(tx, {
        action: 'employee.rehired',
        entityType: 'employee',
        entityId: id,
        companyId: a.companyId,
        before: { status: row.status, hireDate: row.hireDate },
        after: { status, hireDate: input.effectiveDate, companyId: a.companyId, reason: input.reason },
      });
    });
    return this.get(principal, id);
  }

  // --- history -------------------------------------------------------------------------------

  async history(principal: Principal, id: string): Promise<EmployeeHistoryDto> {
    // Visibility is checked first; the reads below run in their own transactions so that no
    // transaction is opened while another is still open (single-connection safety).
    const { access } = await this.loadVisible(principal, id);
    const cross = principal.has('employee.history.crosscompany.view');
    const scoped = <T>(fn: (t: Tx) => Promise<T>) =>
      cross ? this.database.system(fn) : this.database.tx(principal.rls(), fn);

    const assignments = await scoped((t) =>
      t
        .select()
        .from(employmentAssignment)
        .where(eq(employmentAssignment.employeeId, id))
        .orderBy(desc(employmentAssignment.validFrom)),
    );
    const events = await scoped((t) =>
      t
        .select()
        .from(lifecycleEvent)
        .where(eq(lifecycleEvent.employeeId, id))
        .orderBy(desc(lifecycleEvent.effectiveDate), desc(lifecycleEvent.createdAt)),
    );
    let comps: CompensationDto[] | null = null;
    if (access.financial) {
      comps = await this.database.tx(principal.rls(), async (tx) => {
        const rows = await tx
          .select()
          .from(compensation)
          .where(eq(compensation.employeeId, id))
          .orderBy(desc(compensation.validFrom));
        return Promise.all(rows.map((c) => this.compensationDto(tx, c)));
      });
    }
    const total = cross ? assignments.length : await this.countAssignments(id);
    const visibleEvents = access.financial ? events : events.filter((e) => e.type !== 'salary_change');
    return {
      assignments: assignments.map(toAssignmentDto),
      compensation: comps,
      events: visibleEvents.map(
        (e): LifecycleEventDto => ({
          id: e.id,
          type: e.type,
          companyId: e.companyId,
          effectiveDate: e.effectiveDate,
          details: e.details,
          createdAt: e.createdAt.toISOString(),
          createdBy: e.createdBy,
        }),
      ),
      partial: assignments.length < total,
    };
  }

  private async countAssignments(id: string): Promise<number> {
    const [r] = await this.database.system((t) =>
      t.select({ n: sql<number>`count(*)::int` }).from(employmentAssignment).where(eq(employmentAssignment.employeeId, id)),
    );
    return r?.n ?? 0;
  }

  private async event(
    tx: Tx,
    principal: Principal,
    employeeId: string,
    companyId: string | null,
    type: string,
    effectiveDate: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    await tx.insert(lifecycleEvent).values({
      id: uuidv7(),
      employeeId,
      companyId,
      type,
      effectiveDate,
      details,
      createdBy: principal.userId,
    });
  }

  // --- qualifications ------------------------------------------------------------------------

  async listQualifications(principal: Principal, id: string): Promise<QualificationDto[]> {
    return this.database.tx(principal.rls(), async (tx) => {
      await this.loadVisible(principal, id, tx);
      const rows = await tx
        .select()
        .from(qualification)
        .where(and(eq(qualification.employeeId, id), eq(qualification.status, 'active')))
        .orderBy(desc(qualification.graduationYear));
      return rows.map(toQualificationDto);
    });
  }

  async addQualification(principal: Principal, id: string, input: z.infer<typeof qualificationInput>): Promise<QualificationDto> {
    return this.database.tx(principal.rls(), async (tx) => {
      const { current, access } = await this.loadVisible(principal, id, tx);
      if (!access.editPersonal) throw ApiError.forbidden();
      const [row] = await tx
        .insert(qualification)
        .values({
          id: uuidv7(),
          employeeId: id,
          level: input.level,
          specialization: input.specialization ?? null,
          institution: input.institution ?? null,
          country: input.country ?? null,
          graduationYear: input.graduationYear ?? null,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();
      const dto = toQualificationDto(row!);
      await this.audit.record(tx, { action: 'employee.qualification_added', entityType: 'employee', entityId: id, companyId: current?.companyId ?? null, after: dto });
      return dto;
    });
  }

  async removeQualification(principal: Principal, id: string, qid: string): Promise<void> {
    await this.database.tx(principal.rls(), async (tx) => {
      const { current, access } = await this.loadVisible(principal, id, tx);
      if (!access.editPersonal) throw ApiError.forbidden();
      const rows = await tx
        .update(qualification)
        .set({ status: 'deleted', updatedBy: principal.userId })
        .where(and(eq(qualification.id, qid), eq(qualification.employeeId, id), eq(qualification.status, 'active')))
        .returning();
      if (!rows.length) throw ApiError.notFound('Qualification');
      await this.audit.record(tx, {
        action: 'employee.qualification_removed',
        entityType: 'employee',
        entityId: id,
        companyId: current?.companyId ?? null,
        before: toQualificationDto(rows[0]!),
      });
    });
  }

  // --- bank accounts ----------------------------------------------------------------------------

  async listBankAccounts(principal: Principal, id: string): Promise<BankAccountDto[]> {
    return this.database.tx(principal.rls(), async (tx) => {
      const { access } = await this.loadVisible(principal, id, tx);
      if (!access.financial && !access.self) throw ApiError.forbidden();
      const rows = await tx
        .select()
        .from(bankAccount)
        .where(eq(bankAccount.employeeId, id))
        .orderBy(desc(bankAccount.isPrimary), desc(bankAccount.createdAt));
      // The employee sees their own accounts masked; financial users see them in full (audited).
      const full = access.financial;
      if (full && rows.length) {
        await this.audit.record(tx, { action: 'employee.bank_viewed', entityType: 'employee', entityId: id });
      }
      return rows.map((b) => {
        const acc = b.accountNoEnc ? this.encryptor.decryptString(b.accountNoEnc, `bank:${b.id}`) : null;
        const iban = b.ibanEnc ? this.encryptor.decryptString(b.ibanEnc, `bank:${b.id}`) : null;
        const mask = (v: string | null) => (v && !full ? `••••${v.slice(-4)}` : v);
        return {
          id: b.id,
          bankName: b.bankName,
          accountNumber: mask(acc),
          iban: mask(iban),
          isPrimary: b.isPrimary,
          status: b.status,
          version: b.version,
        };
      });
    });
  }

  async addBankAccount(principal: Principal, id: string, input: z.infer<typeof bankAccountInput>): Promise<void> {
    await this.database.tx(principal.rls(), async (tx) => {
      const { current, access } = await this.loadVisible(principal, id, tx);
      if (!access.editFinancial) throw ApiError.forbidden();
      if (input.isPrimary) {
        await tx
          .update(bankAccount)
          .set({ isPrimary: false, updatedBy: principal.userId })
          .where(and(eq(bankAccount.employeeId, id), eq(bankAccount.isPrimary, true)));
      }
      const bankId = await this.insertBank(tx, principal, id, input);
      await this.audit.record(tx, {
        action: 'employee.bank_added',
        entityType: 'employee',
        entityId: id,
        companyId: current?.companyId ?? null,
        after: { bankAccountId: bankId, bankName: input.bankName, isPrimary: input.isPrimary },
      });
    });
  }

  async deactivateBankAccount(principal: Principal, id: string, bankId: string): Promise<void> {
    await this.database.tx(principal.rls(), async (tx) => {
      const { current, access } = await this.loadVisible(principal, id, tx);
      if (!access.editFinancial) throw ApiError.forbidden();
      const rows = await tx
        .update(bankAccount)
        .set({ status: 'inactive', isPrimary: false, updatedBy: principal.userId })
        .where(and(eq(bankAccount.id, bankId), eq(bankAccount.employeeId, id), eq(bankAccount.status, 'active')))
        .returning({ id: bankAccount.id });
      if (!rows.length) throw ApiError.notFound('Bank account');
      await this.audit.record(tx, { action: 'employee.bank_deactivated', entityType: 'employee', entityId: id, companyId: current?.companyId ?? null, details: { bankAccountId: bankId } });
    });
  }

  private async insertBank(tx: Tx, principal: Principal, employeeId: string, b: z.infer<typeof bankAccountInput>): Promise<string> {
    const bankId = uuidv7();
    await tx.insert(bankAccount).values({
      id: bankId,
      employeeId,
      bankName: b.bankName,
      accountNoEnc: b.accountNumber ? this.encryptor.encrypt(b.accountNumber, `bank:${bankId}`) : null,
      ibanEnc: b.iban ? this.encryptor.encrypt(b.iban, `bank:${bankId}`) : null,
      isPrimary: b.isPrimary,
      createdBy: principal.userId,
      updatedBy: principal.userId,
    });
    return bankId;
  }

  // --- user account link (AUTH-08) -----------------------------------------------------------------

  async linkUser(principal: Principal, id: string, userId: string | null): Promise<void> {
    await this.database.tx(principal.rls(), async (tx) => {
      const { current } = await this.loadVisible(principal, id, tx);
      const [before] = await tx.select({ id: userAccount.id }).from(userAccount).where(eq(userAccount.employeeId, id));
      if (before) await tx.update(userAccount).set({ employeeId: null, updatedBy: principal.userId }).where(eq(userAccount.id, before.id));
      if (userId) {
        const [u] = await tx.select().from(userAccount).where(eq(userAccount.id, userId));
        if (!u) throw ApiError.validation([{ path: 'userId', message: 'Unknown user' }]);
        if (u.employeeId && u.employeeId !== id) throw ApiError.conflict('This account is already linked to another employee');
        await tx.update(userAccount).set({ employeeId: id, updatedBy: principal.userId }).where(eq(userAccount.id, userId));
      }
      await this.audit.record(tx, {
        action: 'employee.account_linked',
        entityType: 'employee',
        entityId: id,
        companyId: current?.companyId ?? null,
        before: { userId: before?.id ?? null },
        after: { userId },
      });
    });
  }
}

function summary(e: EmployeeRow, a: AssignmentRow | null): EmployeeSummaryDto {
  return {
    id: e.id,
    employeeNo: e.employeeNo,
    fullNameAr: e.fullNameAr,
    fullNameEn: e.fullNameEn,
    status: e.status,
    companyId: a?.companyId ?? null,
    departmentId: a?.departmentId ?? null,
    jobTitleId: a?.jobTitleId ?? null,
    hireDate: e.hireDate,
    hasPhoto: !!e.photoDocumentId,
  };
}

function personalAudit(e: EmployeeRow) {
  // Identity numbers are never written to the audit log, only the fact they changed.
  return {
    fullNameAr: e.fullNameAr,
    fullNameEn: e.fullNameEn,
    birthDate: e.birthDate,
    gender: e.gender,
    nationality: e.nationality,
    maritalStatus: e.maritalStatus,
    phone: e.phone,
    email: e.email,
    actualStartDate: e.actualStartDate,
    probationEndDate: e.probationEndDate,
  };
}

const toQualificationDto = (q: typeof qualification.$inferSelect): QualificationDto => ({
  id: q.id,
  level: q.level,
  specialization: q.specialization,
  institution: q.institution,
  country: q.country,
  graduationYear: q.graduationYear,
  version: q.version,
});

function isUniqueViolation(err: unknown, constraint: string): boolean {
  let cur: unknown = err;
  for (let i = 0; i < 4 && cur && typeof cur === 'object'; i++) {
    const c = cur as { code?: string; constraint?: string; message?: string; cause?: unknown };
    if (c.code === '23505' && (c.constraint === constraint || c.message?.includes(constraint))) return true;
    cur = c.cause;
  }
  return false;
}
