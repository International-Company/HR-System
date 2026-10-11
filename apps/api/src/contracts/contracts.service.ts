import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { and, asc, desc, eq, gte, ilike, inArray, isNull, lte, max, or, sql, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import {
  DEFAULT_CONTRACT_TYPE_POLICY,
  MERGE_FIELDS,
  contractTypePolicySchema,
  type ContractClauseDto,
  type ContractDto,
  type ContractSummaryDto,
  type ContractTemplateDto,
  type ContractTypePolicy,
  type ContractVersionDto,
  type SignatureDto,
  type addendumInput,
  type contractClauseInput,
  type contractClauseUpdateInput,
  type contractCreateInput,
  type contractDraftUpdateInput,
  type contractSearchQuery,
  type contractTemplateInput,
  type contractTemplateUpdateInput,
  type endContractInput,
  type probationOutcomeInput,
  type renewInput,
  type signInput,
} from '@hrms/shared';
import { DATABASE } from '../common/tokens.js';
import type { Database, Tx } from '../db/database.js';
import {
  company,
  compensation,
  contract,
  contractAlert,
  contractClause,
  contractSignature,
  contractTemplate,
  contractTypePolicy,
  contractVersion,
  department,
  employee,
  employeeCurrentAssignment,
  leaveRequest,
  lookupValue,
  role,
  roleAssignment,
  userAccount,
} from '../db/schema.js';
import { ApiError } from '../common/errors.js';
import { uuidv7 } from '../common/ids.js';
import type { Principal } from '../access/principal.js';
import { AuditService } from '../audit/audit.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { ModulesService } from '../settings/modules.service.js';
import { EmployeesService } from '../employees/employees.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { DocumentsService, type UploadedFile } from '../documents/documents.service.js';
import { localDate } from '../attendance/time.js';
import { addDays, addMonths } from '../leave/rules.js';
import { extensionText, placeholders, renderContract, textHash } from './render.js';

type ContractRow = typeof contract.$inferSelect;
type VersionRow = typeof contractVersion.$inferSelect;
type TemplateRow = typeof contractTemplate.$inferSelect;

export interface SignMeta {
  ip: string | null;
  userAgent: string | null;
}

const OPEN: ContractRow['status'][] = ['draft', 'awaiting_signature'];

/**
 * Contracts (CON-01..11). Versions are rendered from templates, signed in the app (with
 * evidence) or by uploading a signed copy, and locked by the database once signed (CON-06).
 */
@Injectable()
export class ContractsService {
  private readonly logger = new Logger('Contracts');

  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(ModulesService) private readonly modules: ModulesService,
    @Inject(EmployeesService) private readonly employees: EmployeesService,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
    @Inject(DocumentsService) private readonly documents: DocumentsService,
  ) {}

  private async today(): Promise<string> {
    return localDate(new Date(), await this.settings.get('general.timezone'));
  }

  // --- configuration (CON-01, CON-04) ----------------------------------------------------------

  async typePolicies(principal: Principal): Promise<{ contractTypeId: string; policy: ContractTypePolicy }[]> {
    this.requireSetupReader(principal);
    return this.database.tx(principal.rls(), async (tx) => {
      const types = await tx.select({ id: lookupValue.id }).from(lookupValue).where(eq(lookupValue.kind, 'contract_type'));
      const rows = await tx.select().from(contractTypePolicy);
      return types.map((t) => ({
        contractTypeId: t.id,
        policy: contractTypePolicySchema.parse(rows.find((r) => r.contractTypeId === t.id)?.policy ?? DEFAULT_CONTRACT_TYPE_POLICY),
      }));
    });
  }

  async setTypePolicy(principal: Principal, contractTypeId: string, policy: ContractTypePolicy): Promise<void> {
    await this.database.tx(principal.rls(), async (tx) => {
      const [t] = await tx.select().from(lookupValue).where(and(eq(lookupValue.id, contractTypeId), eq(lookupValue.kind, 'contract_type')));
      if (!t) throw ApiError.notFound('Contract type');
      await tx
        .insert(contractTypePolicy)
        .values({ contractTypeId, policy, updatedBy: principal.userId })
        .onConflictDoUpdate({ target: contractTypePolicy.contractTypeId, set: { policy, updatedAt: new Date(), updatedBy: principal.userId } });
      await this.audit.record(tx, { action: 'contracts.type_policy_set', entityType: 'lookup_value', entityId: contractTypeId, after: policy });
    });
  }

  private async policyOf(tx: Tx, contractTypeId: string): Promise<ContractTypePolicy> {
    const [row] = await tx.select().from(contractTypePolicy).where(eq(contractTypePolicy.contractTypeId, contractTypeId));
    return contractTypePolicySchema.parse(row?.policy ?? DEFAULT_CONTRACT_TYPE_POLICY);
  }

  /** Templates, clauses and type rules are for staff who prepare contracts (not for employees). */
  private requireSetupReader(principal: Principal) {
    if (!principal.has('contracts.manage') && !principal.has('contracts.templates.manage')) throw ApiError.forbidden();
  }

  async listTemplates(principal: Principal): Promise<ContractTemplateDto[]> {
    this.requireSetupReader(principal);
    return this.database.tx(principal.rls(), async (tx) =>
      (await tx.select().from(contractTemplate).orderBy(asc(contractTemplate.code))).map((t) => ({
        id: t.id,
        companyId: t.companyId,
        contractTypeId: t.contractTypeId,
        code: t.code,
        name: t.name,
        language: t.language,
        body: t.body,
        fields: t.fields,
        status: t.status,
      })),
    );
  }

  private checkTemplateText(body: string, fieldKeys: string[], extra: string[] = []) {
    const allowed = new Set<string>([...MERGE_FIELDS, ...fieldKeys.map((k) => `field.${k}`), ...extra]);
    const unknown = placeholders(body).filter((p) => !p.startsWith('clause.') && !allowed.has(p));
    if (unknown.length) throw ApiError.validation([{ path: 'body', message: `Unknown placeholders: ${unknown.join(', ')}` }]);
  }

  async createTemplate(principal: Principal, input: z.infer<typeof contractTemplateInput>): Promise<ContractTemplateDto> {
    this.checkTemplateText(input.body, input.fields.map((f) => f.key));
    const id = uuidv7();
    await this.database.tx(principal.rls(), async (tx) => {
      const [t] = await tx.select().from(lookupValue).where(and(eq(lookupValue.id, input.contractTypeId), eq(lookupValue.kind, 'contract_type')));
      if (!t) throw ApiError.validation([{ path: 'contractTypeId', message: 'Unknown contract type' }]);
      await tx.insert(contractTemplate).values({ id, ...input, createdBy: principal.userId, updatedBy: principal.userId });
      await this.audit.record(tx, { action: 'contracts.template_created', entityType: 'contract_template', entityId: id, companyId: input.companyId, after: { code: input.code, name: input.name } });
    });
    return (await this.listTemplates(principal)).find((t) => t.id === id)!;
  }

  async updateTemplate(principal: Principal, id: string, input: z.infer<typeof contractTemplateUpdateInput>): Promise<ContractTemplateDto> {
    this.checkTemplateText(input.body, input.fields.map((f) => f.key));
    await this.database.tx(principal.rls(), async (tx) => {
      const [before] = await tx.select().from(contractTemplate).where(eq(contractTemplate.id, id));
      if (!before) throw ApiError.notFound('Template');
      // Contracts keep their own rendered text, so editing a template never changes them.
      await tx.update(contractTemplate).set({ ...input, updatedBy: principal.userId, version: before.version + 1 }).where(eq(contractTemplate.id, id));
      await this.audit.record(tx, { action: 'contracts.template_updated', entityType: 'contract_template', entityId: id, companyId: before.companyId, before: { body: before.body, status: before.status }, after: { body: input.body, status: input.status } });
    });
    return (await this.listTemplates(principal)).find((t) => t.id === id)!;
  }

  async listClauses(principal: Principal): Promise<ContractClauseDto[]> {
    this.requireSetupReader(principal);
    return this.database.tx(principal.rls(), async (tx) =>
      (await tx.select().from(contractClause).orderBy(asc(contractClause.code))).map((c) => ({
        id: c.id,
        companyId: c.companyId,
        code: c.code,
        title: c.title,
        language: c.language,
        body: c.body,
        status: c.status,
      })),
    );
  }

  async createClause(principal: Principal, input: z.infer<typeof contractClauseInput>): Promise<ContractClauseDto> {
    this.checkTemplateText(input.body, [], []);
    if (placeholders(input.body).some((p) => p.startsWith('clause.') || p.startsWith('field.'))) {
      throw ApiError.validation([{ path: 'body', message: 'Clauses may use employee, company and contract values only' }]);
    }
    const id = uuidv7();
    await this.database.tx(principal.rls(), async (tx) => {
      await tx.insert(contractClause).values({ id, ...input, createdBy: principal.userId, updatedBy: principal.userId });
      await this.audit.record(tx, { action: 'contracts.clause_created', entityType: 'contract_clause', entityId: id, companyId: input.companyId, after: { code: input.code } });
    });
    return (await this.listClauses(principal)).find((c) => c.id === id)!;
  }

  async updateClause(principal: Principal, id: string, input: z.infer<typeof contractClauseUpdateInput>): Promise<ContractClauseDto> {
    if (placeholders(input.body).some((p) => p.startsWith('clause.') || p.startsWith('field.'))) {
      throw ApiError.validation([{ path: 'body', message: 'Clauses may use employee, company and contract values only' }]);
    }
    this.checkTemplateText(input.body, []);
    await this.database.tx(principal.rls(), async (tx) => {
      const [before] = await tx.select().from(contractClause).where(eq(contractClause.id, id));
      if (!before) throw ApiError.notFound('Clause');
      await tx.update(contractClause).set({ ...input, updatedBy: principal.userId, version: before.version + 1 }).where(eq(contractClause.id, id));
      await this.audit.record(tx, { action: 'contracts.clause_updated', entityType: 'contract_clause', entityId: id, companyId: before.companyId, before: { body: before.body }, after: { body: input.body } });
    });
    return (await this.listClauses(principal)).find((c) => c.id === id)!;
  }

  // --- rendering (CON-02) -------------------------------------------------------------------------

  private async mergeValues(
    tx: Tx,
    principal: Principal | null,
    c: Pick<ContractRow, 'employeeId' | 'companyId' | 'contractNo' | 'startDate' | 'endDate' | 'probationEnd'>,
    needsSalary: boolean,
    today: string,
  ): Promise<Record<string, string>> {
    const [e] = await tx.select().from(employee).where(eq(employee.id, c.employeeId));
    const [co] = await tx.select().from(company).where(eq(company.id, c.companyId));
    const [a] = await tx
      .select({ jobTitleId: employeeCurrentAssignment.jobTitleId, departmentId: employeeCurrentAssignment.departmentId })
      .from(employeeCurrentAssignment)
      .where(eq(employeeCurrentAssignment.employeeId, c.employeeId));
    const [job] = a?.jobTitleId ? await tx.select().from(lookupValue).where(eq(lookupValue.id, a.jobTitleId)) : [];
    const [dept] = a?.departmentId ? await tx.select().from(department).where(eq(department.id, a.departmentId)) : [];
    const values: Record<string, string> = {
      'employee.number': e?.employeeNo ?? '',
      'employee.nameAr': e?.fullNameAr ?? '',
      'employee.nameEn': e?.fullNameEn ?? '',
      'employee.nationality': e?.nationality ?? '',
      'employee.hireDate': e?.hireDate ?? '',
      'company.nameAr': co?.nameAr ?? '',
      'company.nameEn': co?.nameEn ?? '',
      'job.nameAr': job?.nameAr ?? '',
      'job.nameEn': job?.nameEn ?? '',
      'department.nameAr': dept?.nameAr ?? '',
      'department.nameEn': dept?.nameEn ?? '',
      'contract.number': c.contractNo,
      'contract.startDate': c.startDate,
      'contract.endDate': c.endDate ?? '',
      'contract.probationEnd': c.probationEnd ?? '',
      today,
    };
    if (needsSalary) {
      // Salary in a contract needs the financial permission of whoever prepares it.
      if (principal && !principal.canCompany('employee.financial.view', c.companyId)) {
        throw ApiError.forbidden('This template shows the salary: the financial permission is needed');
      }
      const [pay] = await tx
        .select()
        .from(compensation)
        .where(
          and(
            eq(compensation.employeeId, c.employeeId),
            eq(compensation.companyId, c.companyId),
            lte(compensation.validFrom, c.startDate),
            or(isNull(compensation.validTo), gte(compensation.validTo, c.startDate)),
          ),
        )
        .orderBy(desc(compensation.validFrom));
      if (!pay) throw ApiError.validation([{ path: 'templateId', message: 'No salary is recorded for the contract start date' }]);
      values['salary.base'] = Number(pay.baseSalary).toFixed(2);
      values['salary.currency'] = pay.currency;
    }
    return values;
  }

  private async render(
    tx: Tx,
    principal: Principal | null,
    tpl: TemplateRow,
    c: Pick<ContractRow, 'employeeId' | 'companyId' | 'contractNo' | 'startDate' | 'endDate' | 'probationEnd'>,
    fieldValues: Record<string, string>,
    today: string,
  ): Promise<string> {
    const clauses = await tx
      .select()
      .from(contractClause)
      .where(and(eq(contractClause.language, tpl.language), eq(contractClause.status, 'active'), or(isNull(contractClause.companyId), eq(contractClause.companyId, c.companyId))));
    // A company clause replaces the group clause with the same code.
    const byCode: Record<string, string> = {};
    for (const cl of clauses.sort((x, y) => (x.companyId ? 1 : 0) - (y.companyId ? 1 : 0))) byCode[cl.code] = cl.body;
    const used = [tpl.body, ...Object.values(byCode)].flatMap(placeholders);
    const values = await this.mergeValues(tx, principal, c, used.some((p) => p.startsWith('salary.')), today);
    const out = renderContract({ template: tpl.body, values, fields: fieldValues, fieldDefs: tpl.fields, clauses: byCode });
    if (out.missing.length) {
      throw ApiError.validation(out.missing.map((m) => ({ path: m.startsWith('field.') ? `fieldValues.${m.slice(6)}` : 'templateId', message: `Missing: ${m}` })));
    }
    return out.text;
  }

  // --- access --------------------------------------------------------------------------------------

  private async load(tx: Tx, id: string): Promise<ContractRow> {
    const [c] = await tx.select().from(contract).where(eq(contract.id, id)).for('update');
    if (!c) throw ApiError.notFound('Contract');
    return c;
  }

  private requireManage(principal: Principal, c: Pick<ContractRow, 'companyId' | 'employeeId'>) {
    if (!principal.canCompany('contracts.manage', c.companyId)) throw ApiError.forbidden();
    if (principal.employeeId && principal.employeeId === c.employeeId) throw ApiError.forbidden('You cannot manage your own contract');
  }

  private async canView(tx: Tx, principal: Principal, c: ContractRow): Promise<'staff' | 'self' | null> {
    if (principal.canCompany('contracts.manage', c.companyId)) return 'staff';
    const [a] = await tx.select({ d: employeeCurrentAssignment.departmentId }).from(employeeCurrentAssignment).where(eq(employeeCurrentAssignment.employeeId, c.employeeId));
    if (principal.canDepartment('contracts.view', c.companyId, a?.d ?? '')) return 'staff';
    if (principal.canCompany('contracts.sign', c.companyId)) return 'staff';
    if (principal.canSelf('contracts.view', c.employeeId)) return 'self';
    return null;
  }

  // --- create & drafts --------------------------------------------------------------------------

  async create(principal: Principal, input: z.infer<typeof contractCreateInput>): Promise<ContractDto> {
    const { current } = await this.employees.loadVisible(principal, input.employeeId);
    if (!current) throw ApiError.conflict('The employee has no current employment');
    this.requireManage(principal, { companyId: current.companyId, employeeId: input.employeeId });
    if ((await this.modules.access('contracts', current.companyId)) !== 'enabled') {
      throw new ApiError(403, 'MODULE_DISABLED', 'Contracts are disabled for this company');
    }
    if (input.endDate && input.endDate < input.startDate) throw ApiError.validation([{ path: 'endDate', message: 'Before the start date' }]);
    const policy = await this.settings.get('contracts.policy', current.companyId);
    const today = await this.today();
    const id = uuidv7();
    await this.database.tx(principal.rls(), async (tx) => {
      const tpl = await this.usableTemplate(tx, input.templateId, current.companyId);
      const open = await tx
        .select({ id: contract.id })
        .from(contract)
        .where(and(eq(contract.employeeId, input.employeeId), inArray(contract.status, OPEN)));
      if (open.length) throw ApiError.conflict('This employee already has a contract in preparation');
      const contractNo = await this.nextNo(tx, policy.numberPrefix);
      const row = {
        id,
        contractNo,
        companyId: current.companyId,
        employeeId: input.employeeId,
        contractTypeId: tpl.contractTypeId,
        templateId: tpl.id,
        startDate: input.startDate,
        endDate: input.endDate,
        probationEnd: input.probationEnd,
        createdBy: principal.userId,
        updatedBy: principal.userId,
      };
      const text = await this.render(tx, principal, tpl, row, input.fieldValues, today);
      await tx.insert(contract).values(row);
      await this.insertVersion(tx, principal.userId, id, 1, 'original', tpl.language, text, input.fieldValues, input.startDate, input.endDate);
      await this.audit.record(tx, {
        action: 'contracts.created',
        entityType: 'contract',
        entityId: id,
        companyId: current.companyId,
        after: { contractNo, employeeId: input.employeeId, template: tpl.code, startDate: input.startDate, endDate: input.endDate },
      });
    });
    return this.get(principal, id);
  }

  private async usableTemplate(tx: Tx, templateId: string, companyId: string): Promise<TemplateRow> {
    const [tpl] = await tx.select().from(contractTemplate).where(eq(contractTemplate.id, templateId));
    if (!tpl || tpl.status !== 'active' || (tpl.companyId && tpl.companyId !== companyId)) {
      throw ApiError.validation([{ path: 'templateId', message: 'Unknown or inactive template' }]);
    }
    return tpl;
  }

  private async nextNo(tx: Tx, prefix: string): Promise<string> {
    const r = await tx.execute<{ n: string }>(sql`select next_contract_no(${prefix}) as n`);
    return (r as unknown as { rows: { n: string }[] }).rows[0]!.n;
  }

  private async insertVersion(
    tx: Tx,
    userId: string | null,
    contractId: string,
    versionNo: number,
    kind: VersionRow['kind'],
    language: 'ar' | 'en',
    body: string,
    fieldValues: Record<string, string>,
    effectiveDate: string,
    endDate: string | null,
    locked = false,
  ): Promise<VersionRow> {
    const [v] = await tx
      .insert(contractVersion)
      .values({
        id: uuidv7(),
        contractId,
        versionNo,
        kind,
        status: locked ? 'signed' : 'draft',
        language,
        body,
        bodySha256: textHash(body),
        fieldValues,
        effectiveDate,
        endDate,
        lockedAt: locked ? new Date() : null,
        createdBy: userId,
      })
      .returning();
    return v!;
  }

  async updateDraft(principal: Principal, id: string, input: z.infer<typeof contractDraftUpdateInput>): Promise<ContractDto> {
    const today = await this.today();
    await this.database.tx(principal.rls(), async (tx) => {
      const c = await this.load(tx, id);
      this.requireManage(principal, c);
      if (c.status !== 'draft') throw ApiError.conflict('Only drafts can be changed; signed contracts change through an addendum or renewal');
      if (input.endDate && input.endDate < input.startDate) throw ApiError.validation([{ path: 'endDate', message: 'Before the start date' }]);
      const [v] = await tx.select().from(contractVersion).where(and(eq(contractVersion.contractId, id), eq(contractVersion.versionNo, 1)));
      const next = { ...c, startDate: input.startDate, endDate: input.endDate, probationEnd: input.probationEnd };
      let text: string;
      if (input.bodyOverride !== null) {
        if (!principal.canCompany('contracts.manual_edit', c.companyId)) throw ApiError.forbidden('Editing contract text needs the manual-edit permission');
        text = input.bodyOverride.trim();
      } else {
        const tpl = await this.usableTemplate(tx, c.templateId!, c.companyId);
        text = await this.render(tx, principal, tpl, next, input.fieldValues, today);
      }
      await tx.update(contract).set({ startDate: input.startDate, endDate: input.endDate, probationEnd: input.probationEnd, updatedBy: principal.userId, updatedAt: new Date() }).where(eq(contract.id, id));
      await tx
        .update(contractVersion)
        .set({ body: text, bodySha256: textHash(text), fieldValues: input.fieldValues, effectiveDate: input.startDate, endDate: input.endDate })
        .where(eq(contractVersion.id, v!.id));
      await this.audit.record(tx, { action: 'contracts.draft_updated', entityType: 'contract', entityId: id, companyId: c.companyId, after: { manual: input.bodyOverride !== null, startDate: input.startDate, endDate: input.endDate } });
    });
    return this.get(principal, id);
  }

  // --- signing (CON-03) ----------------------------------------------------------------------------

  /** Send a draft version for signature. */
  async send(principal: Principal, id: string, versionId: string): Promise<ContractDto> {
    await this.database.tx(principal.rls(), async (tx) => {
      const c = await this.load(tx, id);
      this.requireManage(principal, c);
      const [v] = await tx.select().from(contractVersion).where(and(eq(contractVersion.id, versionId), eq(contractVersion.contractId, id)));
      if (!v || v.status !== 'draft') throw ApiError.conflict('Only draft versions can be sent for signature');
      const policy = await this.policyOf(tx, c.contractTypeId);
      await tx.update(contractVersion).set({ status: 'awaiting_signature' }).where(eq(contractVersion.id, v.id));
      await tx.insert(contractSignature).values(policy.signers.map((r) => ({ id: uuidv7(), versionId: v.id, role: r })));
      if (v.kind === 'original') await tx.update(contract).set({ status: 'awaiting_signature', updatedAt: new Date() }).where(eq(contract.id, id));
      if (policy.signers.includes('employee')) {
        await this.notifications.notify(tx, {
          userIds: await this.userIdsOfEmployee(tx, c.employeeId),
          companyId: c.companyId,
          eventType: 'contracts.to_sign',
          title: { ar: `عقد بانتظار توقيعك: ${c.contractNo}`, en: `Contract awaiting your signature: ${c.contractNo}` },
          link: `/contracts/${c.id}`,
          entityType: 'contract',
          entityId: c.id,
        });
      }
      await this.audit.record(tx, { action: 'contracts.sent_for_signature', entityType: 'contract', entityId: id, companyId: c.companyId, details: { version: v.versionNo, signers: policy.signers } });
    });
    return this.get(principal, id);
  }

  async sign(principal: Principal, signatureId: string, input: z.infer<typeof signInput>, meta: SignMeta): Promise<ContractDto> {
    const today = await this.today();
    const contractId = await this.database.tx(principal.rls(), async (tx) => {
      const [s] = await tx.select().from(contractSignature).where(eq(contractSignature.id, signatureId)).for('update');
      if (!s) throw ApiError.notFound('Signature');
      const [v] = await tx.select().from(contractVersion).where(eq(contractVersion.id, s.versionId)).for('update');
      const c = await this.load(tx, v!.contractId);
      if (!this.maySign(principal, s.role, c)) throw ApiError.forbidden('You cannot sign this contract');
      if (s.status !== 'pending' || v!.status !== 'awaiting_signature') throw ApiError.conflict('This signature is no longer pending');
      if (input.documentHash !== v!.bodySha256) {
        throw ApiError.conflict('The contract text changed after you opened it. Reload and read it again.');
      }
      await tx
        .update(contractSignature)
        .set({ status: 'signed', method: 'in_app', signerUserId: principal.userId, typedName: input.typedName, signedAt: new Date(), ip: meta.ip, userAgent: meta.userAgent?.slice(0, 400) ?? null, documentHash: input.documentHash })
        .where(eq(contractSignature.id, s.id));
      await this.audit.record(tx, {
        action: 'contracts.signed',
        entityType: 'contract',
        entityId: c.id,
        companyId: c.companyId,
        details: { version: v!.versionNo, role: s.role, method: 'in_app', documentHash: input.documentHash, typedName: input.typedName, ip: meta.ip },
      });
      await this.finalizeIfComplete(tx, c, v!, today);
      return c.id;
    });
    return this.get(principal, contractId);
  }

  private maySign(principal: Principal, roleKey: 'employee' | 'company', c: ContractRow): boolean {
    if (roleKey === 'employee') return !!principal.employeeId && principal.employeeId === c.employeeId;
    // Nobody signs for the company on their own contract.
    return principal.canCompany('contracts.sign', c.companyId) && principal.employeeId !== c.employeeId;
  }

  /** Signed copy signed on paper (CON-03): uploading it completes all pending signatures. */
  async uploadSignedCopy(principal: Principal, id: string, versionId: string, file: UploadedFile | undefined): Promise<ContractDto> {
    if (!file) throw ApiError.validation([{ path: 'file', message: 'A file is required' }]);
    const today = await this.today();
    const pre = await this.database.tx(principal.rls(), async (tx) => {
      const c = await this.load(tx, id);
      this.requireManage(principal, c);
      // The uploader completes the company signature: they must be a company signer, and not
      // the employee of this contract (CON-03).
      if (!this.maySign(principal, 'company', c)) throw ApiError.forbidden('Uploading a signed copy needs the company signing permission');
      const [v] = await tx.select().from(contractVersion).where(and(eq(contractVersion.id, versionId), eq(contractVersion.contractId, id)));
      if (!v || v.status !== 'awaiting_signature') throw ApiError.conflict('Send the version for signature first');
      return { c, v };
    });
    const doc = await this.documents.upload(principal, pre.c.employeeId, { categoryId: '', title: `${pre.c.contractNo} v${pre.v.versionNo} (signed)` }, file, { categoryCode: 'employment' });
    const fileHash = createHash('sha256').update(file.buffer).digest('hex');
    await this.database.tx(principal.rls(), async (tx) => {
      const c = await this.load(tx, id);
      const [v] = await tx.select().from(contractVersion).where(eq(contractVersion.id, versionId)).for('update');
      if (!v || v.status !== 'awaiting_signature') throw ApiError.conflict('This version is already signed or cancelled');
      const policy = await this.policyOf(tx, c.contractTypeId);
      const existing = await tx.select().from(contractSignature).where(eq(contractSignature.versionId, v.id));
      for (const r of policy.signers) {
        if (!existing.some((s) => s.role === r)) await tx.insert(contractSignature).values({ id: uuidv7(), versionId: v.id, role: r });
      }
      await tx
        .update(contractSignature)
        // The fingerprint of the version text is recorded; the file's own hash is in the audit log.
        .set({ status: 'signed', method: 'upload', signerUserId: principal.userId, signedAt: new Date(), documentHash: v.bodySha256 })
        .where(and(eq(contractSignature.versionId, v.id), eq(contractSignature.status, 'pending')));
      await tx.update(contractVersion).set({ status: 'awaiting_signature', signedCopyId: doc.id }).where(eq(contractVersion.id, v.id));
      await this.audit.record(tx, { action: 'contracts.signed_copy_uploaded', entityType: 'contract', entityId: c.id, companyId: c.companyId, details: { version: v.versionNo, documentId: doc.id, fileSha256: fileHash } });
      await this.finalizeIfComplete(tx, c, { ...v, status: 'awaiting_signature', signedCopyId: doc.id }, today);
    });
    return this.get(principal, id);
  }

  private async finalizeIfComplete(tx: Tx, c: ContractRow, v: VersionRow, today: string): Promise<void> {
    const sigs = await tx.select().from(contractSignature).where(eq(contractSignature.versionId, v.id));
    if (!sigs.length || sigs.some((s) => s.status !== 'signed')) return;
    await tx.update(contractVersion).set({ status: 'signed', lockedAt: new Date() }).where(eq(contractVersion.id, v.id));
    await this.applyVersion(tx, c, v, today);
  }

  /** Effects of a signed version on the contract. */
  private async applyVersion(tx: Tx, c: ContractRow, v: Pick<VersionRow, 'kind' | 'endDate' | 'versionNo'>, today: string): Promise<void> {
    if (v.kind === 'original') {
      const status = c.endDate && c.endDate < today ? 'expired' : 'active';
      await tx.update(contract).set({ status, updatedAt: new Date() }).where(eq(contract.id, c.id));
      if (c.renewalOfId) await tx.update(contract).set({ status: 'renewed', updatedAt: new Date() }).where(eq(contract.id, c.renewalOfId));
    } else if (v.kind === 'extension' || v.kind === 'auto_renewal') {
      await tx.update(contract).set({ endDate: v.endDate, status: 'active', updatedAt: new Date() }).where(eq(contract.id, c.id));
    }
    await this.audit.record(tx, { action: 'contracts.version_signed', entityType: 'contract', entityId: c.id, companyId: c.companyId, details: { version: v.versionNo, kind: v.kind } });
  }

  // --- changes after signing (CON-04, CON-05) --------------------------------------------------------

  private async nextVersionNo(tx: Tx, contractId: string): Promise<number> {
    const [r] = await tx.select({ n: max(contractVersion.versionNo) }).from(contractVersion).where(eq(contractVersion.contractId, contractId));
    return (r?.n ?? 0) + 1;
  }

  private async noOpenVersion(tx: Tx, contractId: string) {
    const open = await tx
      .select({ id: contractVersion.id })
      .from(contractVersion)
      .where(and(eq(contractVersion.contractId, contractId), inArray(contractVersion.status, ['draft', 'awaiting_signature'])));
    if (open.length) throw ApiError.conflict('Finish or cancel the open version first');
  }

  async addendum(principal: Principal, id: string, input: z.infer<typeof addendumInput>): Promise<ContractDto> {
    const today = await this.today();
    await this.database.tx(principal.rls(), async (tx) => {
      const c = await this.load(tx, id);
      this.requireManage(principal, c);
      if (c.status !== 'active') throw ApiError.conflict('Addenda are made to active contracts');
      await this.noOpenVersion(tx, id);
      const [orig] = await tx.select().from(contractVersion).where(and(eq(contractVersion.contractId, id), eq(contractVersion.versionNo, 1)));
      let text: string;
      if (input.templateId) {
        const tpl = await this.usableTemplate(tx, input.templateId, c.companyId);
        text = await this.render(tx, principal, tpl, c, input.fieldValues, today);
      } else {
        if (!input.body?.trim()) throw ApiError.validation([{ path: 'body', message: 'Text or template required' }]);
        if (!principal.canCompany('contracts.manual_edit', c.companyId)) throw ApiError.forbidden('Writing contract text needs the manual-edit permission');
        text = input.body.trim();
      }
      const n = await this.nextVersionNo(tx, id);
      await this.insertVersion(tx, principal.userId, id, n, 'addendum', orig!.language, text, input.fieldValues, input.effectiveDate, null);
      await this.audit.record(tx, { action: 'contracts.addendum_created', entityType: 'contract', entityId: id, companyId: c.companyId, details: { version: n, effectiveDate: input.effectiveDate } });
    });
    return this.get(principal, id);
  }

  /** Renewal by type rule: an extension version, or a new linked contract (CON-04). */
  async renew(principal: Principal, id: string, input: z.infer<typeof renewInput>): Promise<ContractDto> {
    const prefix = (await this.settings.get('contracts.policy', null)).numberPrefix;
    const today = await this.today();
    const resultId = await this.database.tx(principal.rls(), async (tx) => {
      const c = await this.load(tx, id);
      this.requireManage(principal, c);
      if (!['active', 'expired'].includes(c.status)) throw ApiError.conflict('Only active or expired contracts can be renewed');
      if (!c.endDate) throw ApiError.conflict('Open-ended contracts are not renewed');
      if (input.newEndDate <= c.endDate) throw ApiError.validation([{ path: 'newEndDate', message: 'Must be after the current end date' }]);
      const policy = await this.policyOf(tx, c.contractTypeId);
      const [orig] = await tx.select().from(contractVersion).where(and(eq(contractVersion.contractId, id), eq(contractVersion.versionNo, 1)));
      if (policy.renewal === 'extend') {
        await this.noOpenVersion(tx, id);
        const n = await this.nextVersionNo(tx, id);
        const text = extensionText(orig!.language, c.contractNo, c.endDate, input.newEndDate, false);
        await this.insertVersion(tx, principal.userId, id, n, 'extension', orig!.language, text, {}, addDays(c.endDate, 1), input.newEndDate);
        await this.audit.record(tx, { action: 'contracts.extension_created', entityType: 'contract', entityId: id, companyId: c.companyId, details: { version: n, newEndDate: input.newEndDate } });
        return id;
      }
      const open = await tx.select({ id: contract.id }).from(contract).where(and(eq(contract.employeeId, c.employeeId), inArray(contract.status, OPEN)));
      if (open.length) throw ApiError.conflict('This employee already has a contract in preparation');
      const tpl = await this.usableTemplate(tx, input.templateId ?? c.templateId!, c.companyId);
      const newId = uuidv7();
      const row = {
        id: newId,
        contractNo: await this.nextNo(tx, prefix),
        companyId: c.companyId,
        employeeId: c.employeeId,
        contractTypeId: tpl.contractTypeId,
        templateId: tpl.id,
        startDate: addDays(c.endDate, 1),
        endDate: input.newEndDate,
        probationEnd: null,
        renewalOfId: c.id,
        createdBy: principal.userId,
        updatedBy: principal.userId,
      };
      const fields = (await tx.select().from(contractVersion).where(eq(contractVersion.id, orig!.id)))[0]!.fieldValues;
      const text = await this.render(tx, principal, tpl, row, fields, today);
      await tx.insert(contract).values(row);
      await this.insertVersion(tx, principal.userId, newId, 1, 'original', tpl.language, text, fields, row.startDate, row.endDate);
      await this.audit.record(tx, { action: 'contracts.renewal_created', entityType: 'contract', entityId: newId, companyId: c.companyId, details: { renewalOf: c.contractNo, contractNo: row.contractNo } });
      return newId;
    });
    return this.get(principal, resultId);
  }

  async cancelVersion(principal: Principal, id: string, versionId: string): Promise<ContractDto> {
    await this.database.tx(principal.rls(), async (tx) => {
      const c = await this.load(tx, id);
      this.requireManage(principal, c);
      const [v] = await tx.select().from(contractVersion).where(and(eq(contractVersion.id, versionId), eq(contractVersion.contractId, id)));
      if (!v || !['draft', 'awaiting_signature'].includes(v.status)) throw ApiError.conflict('Signed versions cannot be cancelled');
      await tx.update(contractVersion).set({ status: 'cancelled' }).where(eq(contractVersion.id, v.id));
      if (v.kind === 'original') await tx.update(contract).set({ status: 'cancelled', updatedAt: new Date() }).where(eq(contract.id, id));
      await this.audit.record(tx, { action: 'contracts.version_cancelled', entityType: 'contract', entityId: id, companyId: c.companyId, details: { version: v.versionNo } });
    });
    return this.get(principal, id);
  }

  async end(principal: Principal, id: string, input: z.infer<typeof endContractInput>): Promise<ContractDto> {
    await this.database.tx(principal.rls(), async (tx) => {
      const c = await this.load(tx, id);
      this.requireManage(principal, c);
      if (c.status !== 'active') throw ApiError.conflict('Only active contracts can be ended');
      if (input.endDate < c.startDate) throw ApiError.validation([{ path: 'endDate', message: 'Before the start date' }]);
      await tx.update(contract).set({ status: 'ended', endReason: input.reason, endedAt: new Date(), endDate: input.endDate, updatedBy: principal.userId, updatedAt: new Date() }).where(eq(contract.id, id));
      await this.audit.record(tx, { action: 'contracts.ended', entityType: 'contract', entityId: id, companyId: c.companyId, before: { endDate: c.endDate }, after: input });
    });
    return this.get(principal, id);
  }

  async probation(principal: Principal, id: string, input: z.infer<typeof probationOutcomeInput>): Promise<ContractDto> {
    await this.database.tx(principal.rls(), async (tx) => {
      const c = await this.load(tx, id);
      this.requireManage(principal, c);
      if (c.status !== 'active' || !c.probationEnd) throw ApiError.conflict('No probation to decide');
      if (c.probationOutcome && c.probationOutcome !== 'extended') throw ApiError.conflict('The probation outcome is already recorded');
      if (input.outcome === 'extended' && (!input.newProbationEnd || input.newProbationEnd <= c.probationEnd)) {
        throw ApiError.validation([{ path: 'newProbationEnd', message: 'Must be after the current probation end' }]);
      }
      await tx
        .update(contract)
        .set({ probationOutcome: input.outcome, probationNote: input.note, probationEnd: input.outcome === 'extended' ? input.newProbationEnd : c.probationEnd, updatedBy: principal.userId, updatedAt: new Date() })
        .where(eq(contract.id, id));
      await this.audit.record(tx, { action: 'contracts.probation_decided', entityType: 'contract', entityId: id, companyId: c.companyId, before: { probationEnd: c.probationEnd }, after: input });
    });
    return this.get(principal, id);
  }

  // --- reading (CON-10, CON-11) -------------------------------------------------------------------

  async get(principal: Principal, id: string): Promise<ContractDto> {
    return this.database.tx(principal.rls(), async (tx) => {
      const [c] = await tx.select().from(contract).where(eq(contract.id, id));
      if (!c) throw ApiError.notFound('Contract');
      const access = await this.canView(tx, principal, c);
      // Employees see their contract once it is sent to them, never drafts.
      if (!access || (access === 'self' && (c.status === 'draft' || c.status === 'cancelled'))) throw ApiError.notFound('Contract');
      const [summary] = await this.summaries(tx, [c]);
      let versions = await tx.select().from(contractVersion).where(eq(contractVersion.contractId, id)).orderBy(asc(contractVersion.versionNo));
      if (access === 'self') versions = versions.filter((v) => v.status === 'signed' || v.status === 'awaiting_signature');
      const sigs = versions.length ? await tx.select().from(contractSignature).where(inArray(contractSignature.versionId, versions.map((v) => v.id))) : [];
      const signers = sigs.filter((s) => s.signerUserId).map((s) => s.signerUserId!);
      const names = signers.length ? await tx.select({ id: userAccount.id, n: userAccount.displayName }).from(userAccount).where(inArray(userAccount.id, signers)) : [];
      return {
        ...summary!,
        templateId: c.templateId,
        endReason: c.endReason,
        versions: versions.map(
          (v): ContractVersionDto => ({
            id: v.id,
            versionNo: v.versionNo,
            kind: v.kind,
            status: v.status,
            language: v.language,
            body: v.body,
            bodySha256: v.bodySha256,
            effectiveDate: v.effectiveDate,
            endDate: v.endDate,
            signedCopyId: access === 'staff' ? v.signedCopyId : null,
            lockedAt: v.lockedAt?.toISOString() ?? null,
            createdAt: v.createdAt.toISOString(),
            signatures: sigs
              .filter((s) => s.versionId === v.id)
              .sort((a, b) => a.role.localeCompare(b.role))
              .map(
                (s): SignatureDto => ({
                  id: s.id,
                  role: s.role,
                  status: s.status,
                  method: s.method,
                  signerName: names.find((x) => x.id === s.signerUserId)?.n ?? null,
                  typedName: s.typedName,
                  signedAt: s.signedAt?.toISOString() ?? null,
                  ip: access === 'staff' ? s.ip : null,
                  userAgent: access === 'staff' ? s.userAgent : null,
                  documentHash: s.documentHash,
                  canSign: s.status === 'pending' && v.status === 'awaiting_signature' && this.maySign(principal, s.role, c),
                }),
              ),
          }),
        ),
      };
    });
  }

  private async summaries(tx: Tx, rows: ContractRow[]): Promise<ContractSummaryDto[]> {
    if (!rows.length) return [];
    const emps = await tx
      .select({ id: employee.id, no: employee.employeeNo, ar: employee.fullNameAr, en: employee.fullNameEn })
      .from(employee)
      .where(inArray(employee.id, [...new Set(rows.map((r) => r.employeeId))]));
    const renewals = await tx
      .select({ id: contract.id, of: contract.renewalOfId })
      .from(contract)
      .where(and(inArray(contract.renewalOfId, rows.map((r) => r.id)), sql`${contract.status} <> 'cancelled'`));
    return rows.map((c) => {
      const e = emps.find((x) => x.id === c.employeeId);
      return {
        id: c.id,
        contractNo: c.contractNo,
        companyId: c.companyId,
        employeeId: c.employeeId,
        employeeNo: e?.no ?? '',
        employeeName: { ar: e?.ar ?? '', en: e?.en ?? '' },
        contractTypeId: c.contractTypeId,
        status: c.status,
        startDate: c.startDate,
        endDate: c.endDate,
        probationEnd: c.probationEnd,
        probationOutcome: c.probationOutcome,
        renewalOfId: c.renewalOfId,
        renewedById: renewals.find((r) => r.of === c.id)?.id ?? null,
      };
    });
  }

  async employeeContracts(principal: Principal, employeeId: string): Promise<ContractSummaryDto[]> {
    await this.employees.loadVisible(principal, employeeId);
    return this.database.tx(principal.rls(), async (tx) => {
      const rows = await tx.select().from(contract).where(eq(contract.employeeId, employeeId)).orderBy(desc(contract.startDate));
      const visible: ContractRow[] = [];
      for (const c of rows) {
        const a = await this.canView(tx, principal, c);
        if (a === 'staff' || (a === 'self' && !['draft', 'cancelled'].includes(c.status))) visible.push(c);
      }
      return this.summaries(tx, visible);
    });
  }

  async display(principal: Principal, employeeId: string): Promise<{ showInProfile: boolean }> {
    const { current } = await this.employees.loadVisible(principal, employeeId);
    return { showInProfile: (await this.settings.get('contracts.policy', current?.companyId ?? null)).showInProfile };
  }

  /** Advanced search (CON-11) within the viewer's companies. */
  async search(principal: Principal, q: z.infer<typeof contractSearchQuery>): Promise<ContractSummaryDto[]> {
    const scope = principal.scope('contracts.view');
    const manage = principal.scope('contracts.manage');
    const companies = scope.all || manage.all ? null : [...new Set([...scope.companyIds, ...(manage.all ? [] : manage.companyIds)])];
    const today = await this.today();
    return this.database.tx(principal.rls(), async (tx) => {
      const where: SQL[] = [];
      if (companies) {
        const parts: SQL[] = [];
        if (companies.length) parts.push(inArray(contract.companyId, companies));
        if (!scope.all && scope.departmentIds.length) parts.push(inArray(employeeCurrentAssignment.departmentId, scope.departmentIds));
        if (!parts.length) return [];
        where.push(or(...parts)!);
      }
      if (q.companyId) where.push(eq(contract.companyId, q.companyId));
      if (q.status) where.push(eq(contract.status, q.status));
      if (q.contractTypeId) where.push(eq(contract.contractTypeId, q.contractTypeId));
      if (q.expiringWithin) where.push(eq(contract.status, 'active'), gte(contract.endDate, today), lte(contract.endDate, addDays(today, q.expiringWithin)));
      if (q.q) {
        const like = `%${q.q.replace(/[%_\\]/g, (ch) => `\\${ch}`)}%`;
        where.push(or(ilike(contract.contractNo, like), ilike(employee.employeeNo, like), ilike(employee.fullNameAr, like), ilike(employee.fullNameEn, like))!);
      }
      const rows = await tx
        .select({ c: contract })
        .from(contract)
        .innerJoin(employee, eq(employee.id, contract.employeeId))
        .leftJoin(employeeCurrentAssignment, eq(employeeCurrentAssignment.employeeId, contract.employeeId))
        .where(and(...where))
        .orderBy(asc(contract.endDate), asc(contract.contractNo))
        .limit(500);
      return this.summaries(tx, rows.map((r) => r.c));
    });
  }

  /** Signatures waiting for the current user. */
  async toSign(principal: Principal): Promise<ContractSummaryDto[]> {
    return this.database.tx(principal.rls(), async (tx) => {
      const rows = await tx
        .select({ c: contract, role: contractSignature.role })
        .from(contractSignature)
        .innerJoin(contractVersion, eq(contractVersion.id, contractSignature.versionId))
        .innerJoin(contract, eq(contract.id, contractVersion.contractId))
        .where(and(eq(contractSignature.status, 'pending'), eq(contractVersion.status, 'awaiting_signature')));
      const mine = rows.filter((r) => this.maySign(principal, r.role, r.c)).map((r) => r.c);
      return this.summaries(tx, [...new Map(mine.map((c) => [c.id, c])).values()]);
    });
  }

  // --- daily job (CON-04, CON-07..09) ---------------------------------------------------------------

  async daily(): Promise<{ renewed: number; expired: number; alerts: number }> {
    const today = await this.today();
    const out = { renewed: 0, expired: 0, alerts: 0 };
    const active = await this.database.system((tx) => tx.select().from(contract).where(eq(contract.status, 'active')));
    for (const c of active) {
      const policy = await this.settings.get('contracts.policy', c.companyId);
      await this.database.system(async (tx) => {
        const typePolicy = await this.policyOf(tx, c.contractTypeId);
        // Automatic renewal on the end date, only for types that allow it (CON-04).
        if (c.endDate && c.endDate <= today && typePolicy.autoRenew) {
          const [orig] = await tx.select().from(contractVersion).where(and(eq(contractVersion.contractId, c.id), eq(contractVersion.versionNo, 1)));
          const newEnd = addDays(addMonths(addDays(c.endDate, 1), typePolicy.autoRenewMonths), -1);
          const n = await this.nextVersionNo(tx, c.id);
          const text = extensionText(orig!.language, c.contractNo, c.endDate, newEnd, true);
          const v = await this.insertVersion(tx, null, c.id, n, 'auto_renewal', orig!.language, text, {}, addDays(c.endDate, 1), newEnd, true);
          await tx.insert(contractSignature).values({ id: uuidv7(), versionId: v.id, role: 'company', status: 'signed', method: 'system', signedAt: new Date(), documentHash: v.bodySha256 });
          await this.applyVersion(tx, c, v, today);
          out.renewed++;
          return;
        }
        if (c.endDate && c.endDate < today) {
          if (policy.expiryDuringLeave === 'hold_until_return') {
            const onLeave = await tx
              .select({ id: leaveRequest.id })
              .from(leaveRequest)
              .where(and(eq(leaveRequest.employeeId, c.employeeId), eq(leaveRequest.status, 'approved'), lte(leaveRequest.startDate, today), gte(leaveRequest.endDate, today)));
            if (onLeave.length) return;
          }
          await tx.update(contract).set({ status: 'expired', updatedAt: new Date() }).where(eq(contract.id, c.id));
          await this.audit.record(tx, { action: 'contracts.expired', entityType: 'contract', entityId: c.id, companyId: c.companyId, actor: { userId: null, username: 'system' } });
          out.expired++;
          return;
        }
        if (c.endDate) out.alerts += await this.alert(tx, c, 'expiry', c.endDate, policy.expiryAlertDays, policy.alertRecipients, today);
        if (c.probationEnd && (!c.probationOutcome || c.probationOutcome === 'extended') && c.probationEnd >= today) {
          out.alerts += await this.alert(tx, c, 'probation', c.probationEnd, policy.probationAlertDays, policy.alertRecipients, today);
        }
      });
    }
    if (out.renewed || out.expired || out.alerts) this.logger.log(`Contracts: ${out.renewed} renewed, ${out.expired} expired, ${out.alerts} alert(s)`);
    return out;
  }

  /** One alert per threshold reached; a late first run sends a single alert for all of them. */
  private async alert(
    tx: Tx,
    c: ContractRow,
    kind: 'expiry' | 'probation',
    due: string,
    thresholds: number[],
    recipients: ('hr' | 'direct_manager' | 'employee')[],
    today: string,
  ): Promise<number> {
    const left = Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
    const reached = thresholds.filter((d) => left <= d);
    if (!reached.length) return 0;
    const sent = await tx.select().from(contractAlert).where(and(eq(contractAlert.contractId, c.id), eq(contractAlert.kind, kind), eq(contractAlert.dueDate, due)));
    const fresh = reached.filter((d) => !sent.some((s) => s.daysBefore === d));
    if (!fresh.length) return 0;
    await tx.insert(contractAlert).values(fresh.map((d) => ({ contractId: c.id, kind, daysBefore: d, dueDate: due }))).onConflictDoNothing();
    const users = new Set<string>();
    if (recipients.includes('employee')) for (const u of await this.userIdsOfEmployee(tx, c.employeeId)) users.add(u);
    if (recipients.includes('direct_manager')) {
      const [a] = await tx.select({ m: employeeCurrentAssignment.managerEmployeeId }).from(employeeCurrentAssignment).where(eq(employeeCurrentAssignment.employeeId, c.employeeId));
      if (a?.m) for (const u of await this.userIdsOfEmployee(tx, a.m)) users.add(u);
    }
    if (recipients.includes('hr')) {
      const hr = await tx
        .select({ u: roleAssignment.userId })
        .from(roleAssignment)
        .innerJoin(role, eq(role.id, roleAssignment.roleId))
        .where(and(eq(role.key, 'hr'), or(eq(roleAssignment.companyId, c.companyId), eq(roleAssignment.scopeType, 'GROUP')), or(isNull(roleAssignment.validTo), gte(roleAssignment.validTo, today))));
      for (const r of hr) users.add(r.u);
    }
    const [e] = await tx.select({ ar: employee.fullNameAr, en: employee.fullNameEn }).from(employee).where(eq(employee.id, c.employeeId));
    const title =
      kind === 'expiry'
        ? { ar: `ينتهي العقد ${c.contractNo} (${e?.ar}) في ${due}`, en: `Contract ${c.contractNo} (${e?.en}) ends on ${due}` }
        : { ar: `تنتهي فترة التجربة (${e?.ar}) في ${due}`, en: `Probation of ${e?.en} ends on ${due}` };
    await this.notifications.notify(tx, { userIds: [...users], companyId: c.companyId, eventType: `contracts.${kind}`, title, link: `/contracts/${c.id}`, entityType: 'contract', entityId: c.id });
    return 1;
  }

  private async userIdsOfEmployee(tx: Tx, employeeId: string): Promise<string[]> {
    const rows = await tx.execute<{ id: string }>(sql`select id from user_account where employee_id = ${employeeId} and status = 'active'`);
    return (rows as unknown as { rows: { id: string }[] }).rows.map((r) => r.id);
  }
}

