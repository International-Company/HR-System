import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { and, asc, desc, eq, ilike, inArray, isNotNull, or, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type {
  ApplicationDto,
  ApplicationSummaryDto,
  CandidateDto,
  InterviewDto,
  OfferDto,
  RecruitmentStages,
  VacancyDto,
  candidateInput,
  candidateUpdateInput,
  convertInput,
  interviewInput,
  interviewResultInput,
  offerInput,
  offerStatusInput,
  vacancyInput,
  vacancyUpdateInput,
} from '@hrms/shared';
import { DATABASE } from '../common/tokens.js';
import type { Database, Tx } from '../db/database.js';
import { applicationEvent, candidate, interview, jobApplication, jobOffer, userAccount, vacancy } from '../db/schema.js';
import { ApiError } from '../common/errors.js';
import { uuidv7 } from '../common/ids.js';
import type { Principal } from '../access/principal.js';
import { AuditService } from '../audit/audit.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { ModulesService } from '../settings/modules.service.js';
import { EmployeesService } from '../employees/employees.service.js';
import { WorkflowService } from '../workflow/workflow.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { DocumentsService, type UploadedFile } from '../documents/documents.service.js';
import { assertLookups } from '../employees/lookups.service.js';
import { localDate } from '../attendance/time.js';
import { addMonths } from '../leave/rules.js';

type VacancyRow = typeof vacancy.$inferSelect;
type CandidateRow = typeof candidate.$inferSelect;
type AppRow = typeof jobApplication.$inferSelect;
type OfferRow = typeof jobOffer.$inferSelect;

const OFFER_FLOW: Record<string, string[]> = {
  approved: ['sent', 'withdrawn'],
  sent: ['accepted', 'declined', 'withdrawn'],
  draft: ['withdrawn'],
};

/**
 * Recruitment (REC-01..07): vacancies, candidates and their files, applications through
 * configurable stages with an append-only history, interviews, offers with approval, and
 * conversion into an employee record without duplicates (REC-06).
 */
@Injectable()
export class RecruitmentService implements OnModuleInit {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(ModulesService) private readonly modules: ModulesService,
    @Inject(EmployeesService) private readonly employees: EmployeesService,
    @Inject(WorkflowService) private readonly workflow: WorkflowService,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
    @Inject(DocumentsService) private readonly documents: DocumentsService,
  ) {}

  onModuleInit() {
    this.workflow.registerHandler('job_offer', {
      onCompleted: async (tx, inst, outcome) => {
        const [o] = await tx.select().from(jobOffer).where(eq(jobOffer.id, inst.subjectId));
        if (!o) return;
        await tx
          .update(jobOffer)
          .set({ status: outcome === 'approved' ? 'approved' : 'draft', workflowInstanceId: outcome === 'approved' ? o.workflowInstanceId : null, updatedAt: new Date() })
          .where(eq(jobOffer.id, o.id));
        await this.event(tx, o.applicationId, 'offer', null, outcome === 'approved' ? 'Offer approved' : `Offer ${outcome}`, inst.requesterUserId);
      },
      link: (inst) => `/recruitment?offer=${inst.subjectId}`,
    });
  }

  // --- access ----------------------------------------------------------------------------------

  private canView(principal: Principal, companyId: string, departmentId?: string | null) {
    return principal.canDepartment('recruitment.view', companyId, departmentId ?? '') || principal.canCompany('recruitment.manage', companyId);
  }

  private requireManage(principal: Principal, companyId: string) {
    if (!principal.canCompany('recruitment.manage', companyId)) throw ApiError.forbidden();
  }

  private async moduleOn(companyId: string) {
    if ((await this.modules.access('recruitment', companyId)) !== 'enabled') throw new ApiError(403, 'MODULE_DISABLED', 'Recruitment is disabled for this company');
  }

  private async event(tx: Tx, applicationId: string, kind: 'stage' | 'note' | 'interview' | 'offer' | 'converted', stage: string | null, text: string | null, by: string | null) {
    await tx.insert(applicationEvent).values({ id: uuidv7(), applicationId, kind, stage, text, createdBy: by });
    await tx.update(jobApplication).set({ updatedAt: new Date() }).where(eq(jobApplication.id, applicationId));
  }

  async stages(): Promise<RecruitmentStages> {
    return this.settings.get('recruitment.stages');
  }

  // --- vacancies (REC-01) -------------------------------------------------------------------------

  private async vacancyDtos(tx: Tx, rows: VacancyRow[]): Promise<VacancyDto[]> {
    if (!rows.length) return [];
    const counts = await tx
      .select({ v: jobApplication.vacancyId, n: sql<number>`count(*)::int`, hired: sql<number>`count(${jobApplication.employeeId})::int` })
      .from(jobApplication)
      .where(inArray(jobApplication.vacancyId, rows.map((r) => r.id)))
      .groupBy(jobApplication.vacancyId);
    return rows.map((v) => ({
      id: v.id,
      companyId: v.companyId,
      departmentId: v.departmentId,
      jobTitleId: v.jobTitleId,
      employmentCategoryId: v.employmentCategoryId,
      contractTypeId: v.contractTypeId,
      workLocationId: v.workLocationId,
      title: v.title,
      description: v.description,
      openings: v.openings,
      status: v.status,
      requiredDocumentCategoryIds: v.requiredDocumentCategoryIds,
      applications: counts.find((c) => c.v === v.id)?.n ?? 0,
      hired: counts.find((c) => c.v === v.id)?.hired ?? 0,
      createdAt: v.createdAt.toISOString(),
    }));
  }

  async vacancies(principal: Principal, companyId: string): Promise<VacancyDto[]> {
    if (!this.canView(principal, companyId) && !principal.touchesCompany('recruitment.view', companyId)) throw ApiError.notFound('Company');
    return this.database.tx(principal.rls(), async (tx) => {
      const rows = await tx.select().from(vacancy).where(eq(vacancy.companyId, companyId)).orderBy(desc(vacancy.createdAt));
      return this.vacancyDtos(tx, rows.filter((v) => this.canView(principal, v.companyId, v.departmentId)));
    });
  }

  private async checkVacancyRefs(tx: Tx, input: z.infer<typeof vacancyUpdateInput>, companyId: string) {
    await assertLookups(tx, companyId, [
      { id: input.jobTitleId, kind: 'job_title', field: 'jobTitleId' },
      { id: input.employmentCategoryId, kind: 'employment_category', field: 'employmentCategoryId' },
      { id: input.contractTypeId, kind: 'contract_type', field: 'contractTypeId' },
    ]);
  }

  async createVacancy(principal: Principal, input: z.infer<typeof vacancyInput>): Promise<VacancyDto> {
    this.requireManage(principal, input.companyId);
    await this.moduleOn(input.companyId);
    const id = uuidv7();
    await this.database.tx(principal.rls(), async (tx) => {
      await this.checkVacancyRefs(tx, { ...input, status: 'draft' }, input.companyId);
      await tx.insert(vacancy).values({ id, ...input, departmentId: input.departmentId ?? null, createdBy: principal.userId, updatedBy: principal.userId });
      await this.audit.record(tx, { action: 'recruitment.vacancy_created', entityType: 'vacancy', entityId: id, companyId: input.companyId, after: { title: input.title, openings: input.openings } });
    });
    return this.vacancy(principal, id);
  }

  async updateVacancy(principal: Principal, id: string, input: z.infer<typeof vacancyUpdateInput>): Promise<VacancyDto> {
    await this.database.tx(principal.rls(), async (tx) => {
      const [v] = await tx.select().from(vacancy).where(eq(vacancy.id, id));
      if (!v) throw ApiError.notFound('Vacancy');
      this.requireManage(principal, v.companyId);
      await this.checkVacancyRefs(tx, input, v.companyId);
      await tx.update(vacancy).set({ ...input, updatedBy: principal.userId, updatedAt: new Date() }).where(eq(vacancy.id, id));
      await this.audit.record(tx, { action: 'recruitment.vacancy_updated', entityType: 'vacancy', entityId: id, companyId: v.companyId, before: { status: v.status, openings: v.openings }, after: { status: input.status, openings: input.openings } });
    });
    return this.vacancy(principal, id);
  }

  async vacancy(principal: Principal, id: string): Promise<VacancyDto> {
    return this.database.tx(principal.rls(), async (tx) => {
      const [v] = await tx.select().from(vacancy).where(eq(vacancy.id, id));
      if (!v || !this.canView(principal, v.companyId, v.departmentId)) throw ApiError.notFound('Vacancy');
      return (await this.vacancyDtos(tx, [v]))[0]!;
    });
  }

  // --- candidates (REC-02) -------------------------------------------------------------------------

  private toCandidate(c: CandidateRow): CandidateDto {
    return {
      id: c.id,
      companyId: c.companyId,
      fullNameAr: c.fullNameAr,
      fullNameEn: c.fullNameEn,
      email: c.email,
      phone: c.phone,
      nationality: c.nationality,
      source: c.source,
      notes: c.notes,
      employeeId: c.employeeId,
      retainUntil: c.retainUntil,
      createdAt: c.createdAt.toISOString(),
    };
  }

  async candidates(principal: Principal, companyId: string, q?: string): Promise<CandidateDto[]> {
    if (!this.canView(principal, companyId)) throw ApiError.notFound('Company');
    return this.database.tx(principal.rls(), async (tx) => {
      const like = q ? `%${q.replace(/[%_\\]/g, (ch) => `\\${ch}`)}%` : null;
      const rows = await tx
        .select()
        .from(candidate)
        .where(and(eq(candidate.companyId, companyId), like ? or(ilike(candidate.fullNameAr, like), ilike(candidate.fullNameEn, like), ilike(candidate.email, like)) : undefined))
        .orderBy(desc(candidate.createdAt))
        .limit(500);
      return rows.map((c) => this.toCandidate(c));
    });
  }

  async createCandidate(principal: Principal, input: z.infer<typeof candidateInput>): Promise<CandidateDto> {
    this.requireManage(principal, input.companyId);
    await this.moduleOn(input.companyId);
    const { retentionMonths } = await this.stages();
    const today = localDate(new Date(), await this.settings.get('general.timezone'));
    const id = uuidv7();
    await this.database.tx(principal.rls(), async (tx) => {
      if (input.email) {
        const dup = await tx.select({ id: candidate.id }).from(candidate).where(and(eq(candidate.companyId, input.companyId), eq(candidate.email, input.email)));
        if (dup.length) throw ApiError.conflict('A candidate with this e-mail already exists');
      }
      await tx.insert(candidate).values({
        id,
        ...input,
        email: input.email ?? null,
        phone: input.phone ?? null,
        nationality: input.nationality ?? null,
        retainUntil: addMonths(today, retentionMonths),
        createdBy: principal.userId,
        updatedBy: principal.userId,
      });
      await this.audit.record(tx, { action: 'recruitment.candidate_created', entityType: 'candidate', entityId: id, companyId: input.companyId, after: { source: input.source } });
    });
    return this.candidate(principal, id);
  }

  async updateCandidate(principal: Principal, id: string, input: z.infer<typeof candidateUpdateInput>): Promise<CandidateDto> {
    await this.database.tx(principal.rls(), async (tx) => {
      const [c] = await tx.select().from(candidate).where(eq(candidate.id, id));
      if (!c) throw ApiError.notFound('Candidate');
      this.requireManage(principal, c.companyId);
      await tx
        .update(candidate)
        .set({ ...input, email: input.email ?? null, phone: input.phone ?? null, nationality: input.nationality ?? null, updatedBy: principal.userId, updatedAt: new Date() })
        .where(eq(candidate.id, id));
      await this.audit.record(tx, { action: 'recruitment.candidate_updated', entityType: 'candidate', entityId: id, companyId: c.companyId });
    });
    return this.candidate(principal, id);
  }

  private async loadCandidate(tx: Tx, principal: Principal, id: string): Promise<CandidateRow> {
    const [c] = await tx.select().from(candidate).where(eq(candidate.id, id));
    if (!c || !this.canView(principal, c.companyId)) throw ApiError.notFound('Candidate');
    return c;
  }

  async candidate(principal: Principal, id: string): Promise<CandidateDto> {
    return this.database.tx(principal.rls(), async (tx) => this.toCandidate(await this.loadCandidate(tx, principal, id)));
  }

  async uploadFile(principal: Principal, candidateId: string, fields: { categoryId: string; title: string }, file: UploadedFile | undefined) {
    const c = await this.database.tx(principal.rls(), (tx) => this.loadCandidate(tx, principal, candidateId));
    this.requireManage(principal, c.companyId);
    return this.documents.upload(principal, '', fields, file, { candidate: { id: c.id, companyId: c.companyId } });
  }

  async file(principal: Principal, candidateId: string, documentId: string) {
    await this.database.tx(principal.rls(), (tx) => this.loadCandidate(tx, principal, candidateId));
    return this.documents.candidateContent(principal, candidateId, documentId);
  }

  // --- applications (REC-03, REC-04) ----------------------------------------------------------------

  async apply(principal: Principal, vacancyId: string, candidateId: string): Promise<ApplicationDto> {
    const stages = await this.stages();
    const id = uuidv7();
    await this.database.tx(principal.rls(), async (tx) => {
      const [v] = await tx.select().from(vacancy).where(eq(vacancy.id, vacancyId));
      if (!v) throw ApiError.notFound('Vacancy');
      this.requireManage(principal, v.companyId);
      if (v.status !== 'open') throw ApiError.conflict('The vacancy is not open');
      const c = await this.loadCandidate(tx, principal, candidateId);
      if (c.companyId !== v.companyId) throw ApiError.validation([{ path: 'candidateId', message: 'The candidate belongs to another company' }]);
      const dup = await tx.select({ id: jobApplication.id }).from(jobApplication).where(and(eq(jobApplication.vacancyId, vacancyId), eq(jobApplication.candidateId, candidateId)));
      if (dup.length) throw ApiError.conflict('The candidate already applied for this vacancy');
      const first = stages.stages[0]!;
      await tx.insert(jobApplication).values({ id, vacancyId, candidateId, companyId: v.companyId, stage: first.key, outcome: 'open', createdBy: principal.userId });
      await this.event(tx, id, 'stage', first.key, null, principal.userId);
      await this.audit.record(tx, { action: 'recruitment.applied', entityType: 'job_application', entityId: id, companyId: v.companyId, details: { vacancyId, candidateId } });
    });
    return this.application(principal, id);
  }

  async applications(principal: Principal, vacancyId: string): Promise<ApplicationSummaryDto[]> {
    return this.database.tx(principal.rls(), async (tx) => {
      const [v] = await tx.select().from(vacancy).where(eq(vacancy.id, vacancyId));
      if (!v || !this.canView(principal, v.companyId, v.departmentId)) throw ApiError.notFound('Vacancy');
      const rows = await tx
        .select({ a: jobApplication, ar: candidate.fullNameAr, en: candidate.fullNameEn })
        .from(jobApplication)
        .innerJoin(candidate, eq(candidate.id, jobApplication.candidateId))
        .where(eq(jobApplication.vacancyId, vacancyId))
        .orderBy(desc(jobApplication.updatedAt));
      return rows.map(({ a, ar, en }) => ({
        id: a.id,
        vacancyId: a.vacancyId,
        candidateId: a.candidateId,
        candidateName: { ar, en },
        stage: a.stage,
        outcome: a.outcome,
        employeeId: a.employeeId,
        updatedAt: a.updatedAt.toISOString(),
      }));
    });
  }

  /** Staff of the company, or an interviewer of this application (limited view). */
  private async loadApplication(tx: Tx, principal: Principal, id: string): Promise<{ app: AppRow; v: VacancyRow; staff: boolean }> {
    const [app] = await tx.select().from(jobApplication).where(eq(jobApplication.id, id));
    if (!app) throw ApiError.notFound('Application');
    const [v] = await tx.select().from(vacancy).where(eq(vacancy.id, app.vacancyId));
    const staff = this.canView(principal, app.companyId, v?.departmentId);
    if (!staff) {
      const mine = await tx.select({ id: interview.id }).from(interview).where(and(eq(interview.applicationId, id), sql`${principal.userId}::uuid = any(${interview.interviewerUserIds})`));
      if (!mine.length) throw ApiError.notFound('Application');
    }
    return { app, v: v!, staff };
  }

  async application(principal: Principal, id: string): Promise<ApplicationDto> {
    return this.database.tx(principal.rls(), async (tx) => {
      const { app, v, staff } = await this.loadApplication(tx, principal, id);
      const [c] = await tx.select().from(candidate).where(eq(candidate.id, app.candidateId));
      const events = await tx.select().from(applicationEvent).where(eq(applicationEvent.applicationId, id)).orderBy(asc(applicationEvent.createdAt));
      const interviews = await tx.select().from(interview).where(eq(interview.applicationId, id)).orderBy(asc(interview.scheduledAt));
      const offers = staff ? await tx.select().from(jobOffer).where(eq(jobOffer.applicationId, id)).orderBy(asc(jobOffer.createdAt)) : [];
      const userIds = [...new Set([...events.map((e) => e.createdBy), ...interviews.flatMap((i) => i.interviewerUserIds)].filter((x): x is string => !!x))];
      const users = userIds.length ? await tx.select({ id: userAccount.id, n: userAccount.displayName }).from(userAccount).where(inArray(userAccount.id, userIds)) : [];
      const name = (uid: string | null) => users.find((u) => u.id === uid)?.n ?? null;
      const docs = staff ? await this.documents.listForCandidate(tx, app.candidateId) : [];
      const seeSalary = principal.canCompany('recruitment.offers', app.companyId);
      return {
        id: app.id,
        vacancyId: app.vacancyId,
        vacancyTitle: v.title,
        companyId: app.companyId,
        candidate: this.toCandidate(c!),
        stage: app.stage,
        outcome: app.outcome,
        employeeId: app.employeeId,
        missingDocumentCategoryIds: v.requiredDocumentCategoryIds.filter((cid) => !docs.some((d) => d.categoryId === cid)),
        documents: docs.map((d) => ({ id: d.id, title: d.title, categoryId: d.categoryId, mime: d.mime, sizeBytes: d.sizeBytes, createdAt: d.createdAt })),
        // Interviewers see the process, not internal notes.
        events: events
          .filter((e) => staff || e.kind !== 'note')
          .map((e) => ({ id: e.id, kind: e.kind, stage: e.stage, text: e.text, byName: name(e.createdBy), at: e.createdAt.toISOString() })),
        interviews: interviews.map(
          (i): InterviewDto => ({
            id: i.id,
            scheduledAt: i.scheduledAt.toISOString(),
            durationMinutes: i.durationMinutes,
            mode: i.mode,
            location: i.location,
            interviewers: i.interviewerUserIds.map((u) => ({ userId: u, name: name(u) ?? '—' })),
            status: i.status,
            result: i.result,
            score: i.score,
            feedback: i.feedback,
            canRecordResult: i.status !== 'cancelled' && (i.interviewerUserIds.includes(principal.userId) || principal.canCompany('recruitment.manage', app.companyId)),
          }),
        ),
        offers: offers.map((o) => this.toOffer(o, seeSalary)),
        createdAt: app.createdAt.toISOString(),
      };
    });
  }

  async changeStage(principal: Principal, id: string, stageKey: string, note?: string): Promise<ApplicationDto> {
    const stages = await this.stages();
    const stage = stages.stages.find((s) => s.key === stageKey);
    if (!stage) throw ApiError.validation([{ path: 'stage', message: 'Unknown stage' }]);
    await this.database.tx(principal.rls(), async (tx) => {
      const { app } = await this.loadApplication(tx, principal, id);
      this.requireManage(principal, app.companyId);
      if (app.employeeId) throw ApiError.conflict('The candidate has been hired');
      if (app.stage === stageKey) throw ApiError.conflict('Already at this stage');
      await tx.update(jobApplication).set({ stage: stageKey, outcome: stage.outcome }).where(eq(jobApplication.id, id));
      await this.event(tx, id, 'stage', stageKey, note?.trim() || null, principal.userId);
      await this.audit.record(tx, { action: 'recruitment.stage_changed', entityType: 'job_application', entityId: id, companyId: app.companyId, before: { stage: app.stage }, after: { stage: stageKey } });
    });
    return this.application(principal, id);
  }

  async addNote(principal: Principal, id: string, note: string): Promise<ApplicationDto> {
    await this.database.tx(principal.rls(), async (tx) => {
      const { app } = await this.loadApplication(tx, principal, id);
      this.requireManage(principal, app.companyId);
      await this.event(tx, id, 'note', null, note, principal.userId);
    });
    return this.application(principal, id);
  }

  // --- interviews -----------------------------------------------------------------------------------

  async scheduleInterview(principal: Principal, id: string, input: z.infer<typeof interviewInput>): Promise<ApplicationDto> {
    await this.database.tx(principal.rls(), async (tx) => {
      const { app, v } = await this.loadApplication(tx, principal, id);
      this.requireManage(principal, app.companyId);
      if (app.outcome !== 'open') throw ApiError.conflict('The application is closed');
      const users = await tx.select({ id: userAccount.id }).from(userAccount).where(and(inArray(userAccount.id, input.interviewerUserIds), eq(userAccount.status, 'active')));
      if (users.length !== new Set(input.interviewerUserIds).size) throw ApiError.validation([{ path: 'interviewerUserIds', message: 'Unknown or inactive users' }]);
      const iid = uuidv7();
      await tx.insert(interview).values({
        id: iid,
        applicationId: id,
        companyId: app.companyId,
        scheduledAt: new Date(input.scheduledAt),
        durationMinutes: input.durationMinutes,
        mode: input.mode,
        location: input.location ?? null,
        interviewerUserIds: [...new Set(input.interviewerUserIds)],
        createdBy: principal.userId,
      });
      await this.event(tx, id, 'interview', null, `Scheduled ${input.scheduledAt}`, principal.userId);
      await this.notifications.notify(tx, {
        userIds: input.interviewerUserIds,
        companyId: app.companyId,
        eventType: 'recruitment.interview',
        title: { ar: `مقابلة: ${v.title}`, en: `Interview: ${v.title}` },
        link: `/recruitment/applications/${id}`,
        entityType: 'job_application',
        entityId: id,
      });
    });
    return this.application(principal, id);
  }

  async recordInterview(principal: Principal, interviewId: string, input: z.infer<typeof interviewResultInput>): Promise<ApplicationDto> {
    const appId = await this.database.tx(principal.rls(), async (tx) => {
      const [i] = await tx.select().from(interview).where(eq(interview.id, interviewId));
      if (!i) throw ApiError.notFound('Interview');
      if (!i.interviewerUserIds.includes(principal.userId) && !principal.canCompany('recruitment.manage', i.companyId)) throw ApiError.notFound('Interview');
      if (i.status === 'cancelled') throw ApiError.conflict('The interview was cancelled');
      await tx
        .update(interview)
        .set({ status: 'done', result: input.result, score: input.score ?? null, feedback: input.feedback, recordedBy: principal.userId, recordedAt: new Date() })
        .where(eq(interview.id, interviewId));
      await this.event(tx, i.applicationId, 'interview', null, `Result: ${input.result}${input.score ? ` (${input.score}/5)` : ''}`, principal.userId);
      return i.applicationId;
    });
    return this.application(principal, appId);
  }

  async cancelInterview(principal: Principal, interviewId: string): Promise<ApplicationDto> {
    const appId = await this.database.tx(principal.rls(), async (tx) => {
      const [i] = await tx.select().from(interview).where(eq(interview.id, interviewId));
      if (!i) throw ApiError.notFound('Interview');
      this.requireManage(principal, i.companyId);
      if (i.status !== 'scheduled') throw ApiError.conflict('Only scheduled interviews can be cancelled');
      await tx.update(interview).set({ status: 'cancelled' }).where(eq(interview.id, interviewId));
      await this.event(tx, i.applicationId, 'interview', null, 'Interview cancelled', principal.userId);
      return i.applicationId;
    });
    return this.application(principal, appId);
  }

  // --- offers (REC-05) ----------------------------------------------------------------------------------

  private toOffer(o: OfferRow, seeSalary: boolean): OfferDto {
    return {
      id: o.id,
      status: o.status,
      baseSalary: seeSalary ? Number(o.baseSalary) : null,
      currency: seeSalary ? o.currency : null,
      startDate: o.startDate,
      jobTitleId: o.jobTitleId,
      notes: o.notes,
      workflowInstanceId: o.workflowInstanceId,
      createdAt: o.createdAt.toISOString(),
    };
  }

  async createOffer(principal: Principal, id: string, input: z.infer<typeof offerInput>): Promise<ApplicationDto> {
    await this.database.tx(principal.rls(), async (tx) => {
      const { app } = await this.loadApplication(tx, principal, id);
      if (!principal.canCompany('recruitment.offers', app.companyId)) throw ApiError.forbidden();
      if (app.outcome !== 'open' && app.outcome !== 'accepted') throw ApiError.conflict('The application is closed');
      const live = await tx.select({ id: jobOffer.id }).from(jobOffer).where(and(eq(jobOffer.applicationId, id), inArray(jobOffer.status, ['draft', 'pending_approval', 'approved', 'sent', 'accepted'])));
      if (live.length) throw ApiError.conflict('An offer is already in progress');
      await assertLookups(tx, app.companyId, [{ id: input.jobTitleId, kind: 'job_title', field: 'jobTitleId' }]);
      const oid = uuidv7();
      await tx.insert(jobOffer).values({ id: oid, applicationId: id, companyId: app.companyId, baseSalary: String(input.baseSalary), currency: input.currency, startDate: input.startDate, jobTitleId: input.jobTitleId ?? null, notes: input.notes ?? null, createdBy: principal.userId });
      await this.event(tx, id, 'offer', null, 'Offer prepared', principal.userId);
      await this.audit.record(tx, { action: 'recruitment.offer_created', entityType: 'job_offer', entityId: oid, companyId: app.companyId, after: { startDate: input.startDate } });
    });
    return this.application(principal, id);
  }

  async submitOffer(principal: Principal, offerId: string): Promise<ApplicationDto> {
    const appId = await this.database.tx(principal.rls(), async (tx) => {
      const [o] = await tx.select().from(jobOffer).where(eq(jobOffer.id, offerId)).for('update');
      if (!o || !principal.canCompany('recruitment.offers', o.companyId)) throw ApiError.notFound('Offer');
      if (o.status !== 'draft') throw ApiError.conflict('Only draft offers can be submitted');
      const [app] = await tx.select().from(jobApplication).where(eq(jobApplication.id, o.applicationId));
      const [c] = await tx.select().from(candidate).where(eq(candidate.id, app!.candidateId));
      const inst = await this.workflow.start(tx, principal, {
        definitionKey: 'recruitment.offer',
        companyId: o.companyId,
        subjectType: 'job_offer',
        subjectId: o.id,
        summary: { candidate: { ar: c!.fullNameAr, en: c!.fullNameEn }, startDate: o.startDate },
      });
      // A route without approvers completes immediately; keep that outcome.
      const [now] = await tx.select({ status: jobOffer.status }).from(jobOffer).where(eq(jobOffer.id, o.id));
      if (now!.status === 'draft' && inst.status === 'pending') await tx.update(jobOffer).set({ status: 'pending_approval', workflowInstanceId: inst.id, updatedAt: new Date() }).where(eq(jobOffer.id, o.id));
      await this.event(tx, o.applicationId, 'offer', null, 'Offer submitted for approval', principal.userId);
      return o.applicationId;
    });
    return this.application(principal, appId);
  }

  async setOfferStatus(principal: Principal, offerId: string, input: z.infer<typeof offerStatusInput>): Promise<ApplicationDto> {
    const appId = await this.database.tx(principal.rls(), async (tx) => {
      const [o] = await tx.select().from(jobOffer).where(eq(jobOffer.id, offerId)).for('update');
      if (!o || !principal.canCompany('recruitment.offers', o.companyId)) throw ApiError.notFound('Offer');
      if (!(OFFER_FLOW[o.status] ?? []).includes(input.status)) throw ApiError.conflict(`An offer that is ${o.status} cannot become ${input.status}`);
      await tx.update(jobOffer).set({ status: input.status, updatedAt: new Date() }).where(eq(jobOffer.id, o.id));
      await this.event(tx, o.applicationId, 'offer', null, `Offer ${input.status}${input.note ? `: ${input.note}` : ''}`, principal.userId);
      await this.audit.record(tx, { action: `recruitment.offer_${input.status}`, entityType: 'job_offer', entityId: o.id, companyId: o.companyId, before: { status: o.status } });
      return o.applicationId;
    });
    return this.application(principal, appId);
  }

  // --- conversion (REC-06) -----------------------------------------------------------------------------

  async convert(principal: Principal, id: string, input: z.infer<typeof convertInput>): Promise<ApplicationDto> {
    const pre = await this.database.tx(principal.rls(), async (tx) => {
      const { app, v } = await this.loadApplication(tx, principal, id);
      this.requireManage(principal, app.companyId);
      if (app.outcome !== 'accepted') throw ApiError.conflict('Only accepted candidates can be hired');
      const [c] = await tx.select().from(candidate).where(eq(candidate.id, app.candidateId));
      if (app.employeeId || c!.employeeId) throw ApiError.conflict('This candidate already has an employee record');
      const [offer] = await tx.select().from(jobOffer).where(and(eq(jobOffer.applicationId, id), eq(jobOffer.status, 'accepted')));
      return { app, v, c: c!, offer: offer ?? null };
    });
    const { app, v, c, offer } = pre;
    const emp = await this.employees.create(principal, {
      personal: { fullNameAr: c.fullNameAr, fullNameEn: c.fullNameEn, email: c.email, phone: c.phone, nationality: c.nationality },
      hireDate: input.hireDate,
      probationEndDate: input.probationEndDate ?? null,
      assignment: {
        companyId: app.companyId,
        departmentId: input.departmentId !== undefined ? input.departmentId : v.departmentId,
        jobTitleId: offer?.jobTitleId ?? v.jobTitleId,
        managerEmployeeId: input.managerEmployeeId ?? null,
        workLocationId: v.workLocationId,
        employmentCategoryId: v.employmentCategoryId,
        contractTypeId: v.contractTypeId,
      },
      ...(offer ? { compensation: { baseSalary: Number(offer.baseSalary).toFixed(2), currency: offer.currency, paymentMethod: input.paymentMethod, items: [] } } : {}),
    });
    await this.database.tx(principal.rls(), async (tx) => {
      await tx.update(jobApplication).set({ employeeId: emp.id, updatedAt: new Date() }).where(eq(jobApplication.id, id));
      await tx.update(candidate).set({ employeeId: emp.id, updatedAt: new Date() }).where(eq(candidate.id, c.id));
      const files = await this.documents.linkCandidateFilesToEmployee(tx, c.id, emp.id);
      await this.event(tx, id, 'converted', null, emp.employeeNo, principal.userId);
      const hired = await tx.select({ n: sql<number>`count(*)::int` }).from(jobApplication).where(and(eq(jobApplication.vacancyId, v.id), isNotNull(jobApplication.employeeId)));
      if ((hired[0]?.n ?? 0) >= v.openings) await tx.update(vacancy).set({ status: 'filled', updatedAt: new Date() }).where(eq(vacancy.id, v.id));
      await this.audit.record(tx, { action: 'recruitment.converted', entityType: 'job_application', entityId: id, companyId: app.companyId, details: { employeeId: emp.id, employeeNo: emp.employeeNo, files } });
    });
    return this.application(principal, id);
  }
}
