import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, gt, isNotNull, lt } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import type { z } from 'zod';
import { DATASETS, type DatasetDef, type ReportField, type ReportFilters, type ReportResultDto, type SavedReportDto, type reportRunInput, type savedReportInput } from '@hrms/shared';
import { DATABASE } from '../common/tokens.js';
import type { Database, Tx } from '../db/database.js';
import { department, reportOutput, savedReport, userAccount } from '../db/schema.js';
import { ApiError } from '../common/errors.js';
import { uuidv7 } from '../common/ids.js';
import type { Principal } from '../access/principal.js';
import { PolicyService } from '../access/policy.service.js';
import { AuditService } from '../audit/audit.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { LeaveService } from '../leave/leave.service.js';
import { localDate } from '../attendance/time.js';
import { RUNNERS, type Row } from './datasets.js';

const MAX_ROWS = 5000;
/** Byte-order mark so spreadsheet programs read the CSV as UTF-8. */
const BOM = String.fromCharCode(0xfeff);
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Text that a spreadsheet would read as a formula is prefixed so it stays text. */
export function safeCell(v: string | number | null): string | number | null {
  if (typeof v !== 'string') return v;
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

export interface ExportFile {
  body: Buffer;
  mime: string;
  fileName: string;
}

/**
 * Reports on curated datasets (RPT-01..05, C-10): the dataset permission and company scope
 * decide the rows; field sensitivity decides the columns; exports are audited and safe from
 * spreadsheet formula injection; scheduled reports are delivered in the app (C-03).
 */
@Injectable()
export class ReportsService {
  private readonly logger = new Logger('Reports');

  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
    @Inject(LeaveService) private readonly leave: LeaveService,
    @Inject(PolicyService) private readonly policy: PolicyService,
  ) {}

  private def(key: string): DatasetDef {
    const d = DATASETS.find((x) => x.key === key);
    if (!d) throw ApiError.validation([{ path: 'dataset', message: 'Unknown dataset' }]);
    return d;
  }

  /** Fields the principal may see in this company (C-10). */
  allowedFields(principal: Principal, d: DatasetDef, companyId: string): ReportField[] {
    const financial = principal.canCompany('employee.financial.view', companyId) || (d.permission.startsWith('payroll.') && principal.canCompany(d.permission, companyId));
    const identity = principal.canCompany('employee.identity.view', companyId);
    return d.fields.filter((f) => f.sensitivity === 'normal' || (f.sensitivity === 'financial' && financial) || (f.sensitivity === 'identity' && identity));
  }

  /** Datasets the principal can run (in any company), with the fields of a given company. */
  catalogue(principal: Principal, companyId?: string): (DatasetDef & { fields: ReportField[] })[] {
    if (!principal.has('reports.run')) return [];
    return DATASETS.filter((d) => principal.has(d.permission)).map((d) => ({ ...d, fields: companyId ? this.allowedFields(principal, d, companyId) : d.fields.filter((f) => f.sensitivity === 'normal') }));
  }

  /** null = whole company; [] never returned (403 instead). */
  private async scope(principal: Principal, d: DatasetDef, companyId: string): Promise<string[] | null> {
    const s = principal.scope(d.permission);
    if (s.all || s.companyIds.includes(companyId)) return null;
    if (!s.departmentIds.length) throw ApiError.forbidden('This report is not available for that company');
    const deps = await this.database.tx(principal.rls(), (tx) => tx.select({ id: department.id, c: department.companyId }).from(department));
    const mine = deps.filter((x) => x.c === companyId && s.departmentIds.includes(x.id)).map((x) => x.id);
    if (!mine.length) throw ApiError.forbidden('This report is not available for that company');
    return mine;
  }

  async run(principal: Principal, input: z.infer<typeof reportRunInput>): Promise<ReportResultDto> {
    if (!principal.has('reports.run')) throw ApiError.forbidden();
    const d = this.def(input.dataset);
    const companyId = input.filters.companyId;
    const departments = await this.scope(principal, d, companyId);
    const allowed = this.allowedFields(principal, d, companyId);
    // Fields the user may not see are dropped, never returned (C-10).
    const columns = input.fields.map((k) => allowed.find((f) => f.key === k)).filter((f): f is ReportField => !!f);
    if (!columns.length) throw ApiError.validation([{ path: 'fields', message: 'Choose at least one field you may see' }]);
    if (input.filters.status && d.statuses && !d.statuses.includes(input.filters.status)) throw ApiError.validation([{ path: 'filters.status', message: 'Unknown status' }]);
    const lang = (await this.settings.get('general.language')) as 'ar' | 'en';
    const today = localDate(new Date(), await this.settings.get('general.timezone'));
    let rows: Row[];
    try {
      rows = await RUNNERS[d.key]!({
        principal,
        filters: input.filters,
        departments,
        lang,
        today,
        tx: (fn) => this.database.tx(principal.rls(), fn),
        leave: this.leave,
      });
    } catch (err) {
      if (err instanceof RangeError) throw ApiError.validation([{ path: 'filters', message: 'The date range must be one year at most and start before it ends' }]);
      throw err;
    }
    const truncated = rows.length > MAX_ROWS;
    return { columns, rows: rows.slice(0, MAX_ROWS).map((r) => Object.fromEntries(columns.map((c) => [c.key, r[c.key] ?? null]))), truncated };
  }

  private async toFile(result: ReportResultDto, format: 'xlsx' | 'csv', title: string, lang: 'ar' | 'en'): Promise<ExportFile> {
    const label = (c: ReportField) => (lang === 'ar' ? c.ar : c.en);
    const stamp = new Date().toISOString().slice(0, 10);
    const base = `${title.replace(/[^\p{L}\p{N} _-]/gu, '').trim() || 'report'} ${stamp}`;
    if (format === 'csv') {
      const esc = (v: string | number | null) => {
        const s = v === null ? '' : String(safeCell(v));
        return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const lines = [result.columns.map((c) => esc(label(c))).join(','), ...result.rows.map((r) => result.columns.map((c) => esc(r[c.key] ?? null)).join(','))];
      return { body: Buffer.from(`${BOM}${lines.join('\r\n')}\r\n`, 'utf8'), mime: 'text/csv; charset=utf-8', fileName: `${base}.csv` };
    }
    const wb = new ExcelJS.Workbook();
    wb.creator = 'HRMS';
    const ws = wb.addWorksheet(title.slice(0, 31) || 'Report', { views: [{ rightToLeft: lang === 'ar', state: 'frozen', ySplit: 1 }] });
    ws.columns = result.columns.map((c) => ({ header: label(c), key: c.key, width: Math.min(40, Math.max(12, label(c).length + 4)) }));
    ws.getRow(1).font = { bold: true };
    for (const r of result.rows) {
      // Values are written as plain values (never formulas); text that looks like one is prefixed.
      ws.addRow(Object.fromEntries(result.columns.map((c) => [c.key, safeCell(r[c.key] ?? null)])));
    }
    result.columns.forEach((c, i) => {
      if (c.type === 'money') ws.getColumn(i + 1).numFmt = '#,##0.00';
    });
    return { body: Buffer.from(await wb.xlsx.writeBuffer()), mime: XLSX, fileName: `${base}.xlsx` };
  }

  async export(principal: Principal, input: z.infer<typeof reportRunInput>, format: 'xlsx' | 'csv'): Promise<ExportFile> {
    if (!principal.has('reports.export')) throw ApiError.forbidden();
    const result = await this.run(principal, input);
    const d = this.def(input.dataset);
    const lang = (await this.settings.get('general.language')) as 'ar' | 'en';
    const file = await this.toFile(result, format, lang === 'ar' ? d.ar : d.en, lang);
    await this.audit.recordStandalone({
      action: 'reports.exported',
      entityType: 'report',
      entityId: d.key,
      companyId: input.filters.companyId,
      details: { dataset: d.key, format, fields: result.columns.map((c) => c.key), filters: input.filters, rows: result.rows.length },
    });
    return file;
  }

  // --- saved reports (RPT-01) -------------------------------------------------------------------

  private toSaved(r: typeof savedReport.$inferSelect): SavedReportDto {
    return { id: r.id, name: r.name, dataset: r.dataset, fields: r.fields, filters: r.filters, schedule: r.schedule ?? null, lastRunAt: r.lastRunAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString() };
  }

  async listSaved(principal: Principal): Promise<SavedReportDto[]> {
    return this.database.tx(principal.rls(), async (tx) =>
      (await tx.select().from(savedReport).where(eq(savedReport.userId, principal.userId)).orderBy(desc(savedReport.updatedAt))).map((r) => this.toSaved(r)),
    );
  }

  async save(principal: Principal, input: z.infer<typeof savedReportInput>, id?: string): Promise<SavedReportDto> {
    if (!principal.has('reports.run')) throw ApiError.forbidden();
    // Validate by running once (scope and fields are checked again at every run).
    await this.run(principal, input);
    if (input.schedule && !principal.has('reports.export')) throw ApiError.forbidden('Scheduled reports deliver a file: the export permission is needed');
    return this.database.tx(principal.rls(), async (tx) => {
      const values = { name: input.name, dataset: input.dataset, fields: input.fields, filters: input.filters, schedule: input.schedule, updatedAt: new Date() };
      if (id) {
        const [r] = await tx.update(savedReport).set(values).where(and(eq(savedReport.id, id), eq(savedReport.userId, principal.userId))).returning();
        if (!r) throw ApiError.notFound('Report');
        return this.toSaved(r);
      }
      const [r] = await tx.insert(savedReport).values({ id: uuidv7(), userId: principal.userId, ...values }).returning();
      return this.toSaved(r!);
    });
  }

  async remove(principal: Principal, id: string): Promise<void> {
    await this.database.tx(principal.rls(), async (tx) => {
      const [r] = await tx.select().from(savedReport).where(and(eq(savedReport.id, id), eq(savedReport.userId, principal.userId)));
      if (!r) throw ApiError.notFound('Report');
      const outputs = await tx.select({ id: reportOutput.id }).from(reportOutput).where(eq(reportOutput.reportId, id));
      // Reports with delivered files are kept (unscheduled) so the files stay available.
      if (outputs.length) await tx.update(savedReport).set({ schedule: null, name: `${r.name} (archived)` }).where(eq(savedReport.id, id));
      else await tx.delete(savedReport).where(eq(savedReport.id, id));
    });
  }

  // --- scheduled delivery (RPT-03, C-03) --------------------------------------------------------

  private due(schedule: { frequency: 'daily' | 'weekly' | 'monthly'; hour: number }, last: Date | null, now: Date, tz: string): boolean {
    const today = localDate(now, tz);
    const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(now));
    if (hour < schedule.hour) return false;
    if (last && localDate(last, tz) >= today) return false;
    const weekday = new Date(`${today}T12:00:00Z`).getUTCDay(); // 1 = Monday
    if (schedule.frequency === 'weekly' && weekday !== 1) return false;
    if (schedule.frequency === 'monthly' && today.slice(8) !== '01') return false;
    return true;
  }

  /** Runs due scheduled reports as their owners and delivers the file to the notification centre. */
  async runSchedules(now = new Date()): Promise<number> {
    const tz = await this.settings.get('general.timezone');
    const lang = (await this.settings.get('general.language')) as 'ar' | 'en';
    const reports = await this.database.system((tx) =>
      tx.select({ r: savedReport, u: userAccount }).from(savedReport).innerJoin(userAccount, eq(userAccount.id, savedReport.userId)).where(isNotNull(savedReport.schedule)),
    );
    let n = 0;
    for (const { r, u } of reports) {
      if (!r.schedule || !this.due(r.schedule, r.lastRunAt, now, tz)) continue;
      let note: { ok: boolean; outputId?: string; rows?: number } = { ok: false };
      try {
        if (u.status !== 'active') throw ApiError.forbidden();
        const principal = await this.policy.loadPrincipal({ id: u.id, username: u.username, employeeId: u.employeeId }, 'scheduled-report', () => 'active');
        const result = await this.run(principal, { dataset: r.dataset, fields: r.fields, filters: r.filters as ReportFilters });
        if (!principal.has('reports.export')) throw ApiError.forbidden();
        const file = await this.toFile(result, 'xlsx', r.name, lang);
        const id = uuidv7();
        await this.database.system((tx) =>
          tx.insert(reportOutput).values({ id, reportId: r.id, userId: u.id, fileName: file.fileName, mime: file.mime, body: file.body, rowCount: result.rows.length, expiresAt: new Date(now.getTime() + 30 * 86_400_000) }),
        );
        note = { ok: true, outputId: id, rows: result.rows.length };
      } catch (err) {
        this.logger.warn(`Scheduled report ${r.id} failed: ${(err as Error).message}`);
      }
      await this.database.system(async (tx: Tx) => {
        await tx.update(savedReport).set({ lastRunAt: now }).where(eq(savedReport.id, r.id));
        await this.notifications.notify(tx, {
          userIds: [u.id],
          eventType: note.ok ? 'reports.delivered' : 'reports.failed',
          title: note.ok ? { ar: `التقرير جاهز: ${r.name}`, en: `Report ready: ${r.name}` } : { ar: `تعذّر إنشاء التقرير: ${r.name}`, en: `Report could not be created: ${r.name}` },
          link: note.ok ? `/reports?output=${note.outputId}` : '/reports',
          entityType: 'saved_report',
          entityId: r.id,
        });
        await this.audit.record(tx, { action: note.ok ? 'reports.delivered' : 'reports.delivery_failed', entityType: 'saved_report', entityId: r.id, details: { rows: note.rows ?? 0 }, actor: { userId: null, username: 'system' } });
      });
      n++;
    }
    return n;
  }

  async outputs(principal: Principal) {
    return this.database.tx(principal.rls(), async (tx) =>
      (
        await tx
          .select({ id: reportOutput.id, reportId: reportOutput.reportId, fileName: reportOutput.fileName, rowCount: reportOutput.rowCount, createdAt: reportOutput.createdAt })
          .from(reportOutput)
          .where(and(eq(reportOutput.userId, principal.userId), gt(reportOutput.expiresAt, new Date())))
          .orderBy(desc(reportOutput.createdAt))
          .limit(50)
      ).map((o) => ({ ...o, createdAt: o.createdAt.toISOString() })),
    );
  }

  async output(principal: Principal, id: string): Promise<ExportFile> {
    const [o] = await this.database.tx(principal.rls(), (tx) => tx.select().from(reportOutput).where(and(eq(reportOutput.id, id), eq(reportOutput.userId, principal.userId), gt(reportOutput.expiresAt, new Date()))));
    if (!o) throw ApiError.notFound('Report file');
    return { body: o.body, mime: o.mime, fileName: o.fileName };
  }

  /** Expired files are removed (they are copies; the data stays in the system). */
  async pruneOutputs(): Promise<void> {
    await this.database.system((tx) => tx.delete(reportOutput).where(lt(reportOutput.expiresAt, new Date())));
  }
}
