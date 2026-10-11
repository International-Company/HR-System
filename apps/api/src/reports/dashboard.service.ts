import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, eq, gte, ilike, inArray, lte, ne, or } from 'drizzle-orm';
import { WIDGETS, type SearchResultDto, type WidgetDto, type WidgetKey } from '@hrms/shared';
import { DATABASE } from '../common/tokens.js';
import type { Database } from '../db/database.js';
import { attendanceDay, candidate, company, employee, employeeCurrentAssignment, leaveRequest, payrollRun, vacancy } from '../db/schema.js';
import type { Principal } from '../access/principal.js';
import { SettingsService } from '../settings/settings.service.js';
import { EmployeesService } from '../employees/employees.service.js';
import { ContractsService } from '../contracts/contracts.service.js';
import { LeaveService } from '../leave/leave.service.js';
import { WorkflowService } from '../workflow/workflow.service.js';
import { BackupService } from '../backup/backup.service.js';
import { localDate } from '../attendance/time.js';

/** Which permission a widget needs (DASH-01: what a role sees is still limited by its scope). */
const NEEDS: Record<WidgetKey, (p: Principal) => boolean> = {
  my_attendance: (p) => !!p.employeeId && p.has('attendance.punch'),
  my_leave: (p) => !!p.employeeId && p.has('leave.request.view'),
  my_tasks: () => true,
  headcount: (p) => p.has('employee.profile.view') && !p.roleKeys.has('employee'),
  attendance_today: (p) => p.has('attendance.record.view'),
  on_leave_today: (p) => p.has('leave.request.view'),
  pending_approvals: (p) => p.has('workflow.instances.view'),
  contracts_expiring: (p) => p.has('contracts.view') || p.has('contracts.manage'),
  open_vacancies: (p) => p.has('recruitment.view') || p.has('recruitment.manage'),
  payroll_status: (p) => p.has('payroll.view') || p.has('payroll.summary.view'),
  system_health: (p) => p.has('system.backup.view'),
};

/**
 * Global search (SRCH-01/02) and dashboards (DASH-01/02). Every query runs with the user's
 * own scope, so results never cross company boundaries (NEG-11).
 */
@Injectable()
export class DashboardService {
  private readonly logger = new Logger('Dashboard');

  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(EmployeesService) private readonly employees: EmployeesService,
    @Inject(ContractsService) private readonly contracts: ContractsService,
    @Inject(LeaveService) private readonly leave: LeaveService,
    @Inject(WorkflowService) private readonly workflow: WorkflowService,
    @Inject(BackupService) private readonly backups: BackupService,
  ) {}

  // --- search ----------------------------------------------------------------------------------

  async search(principal: Principal, q: string): Promise<SearchResultDto[]> {
    const text = q.trim();
    if (text.length < 2) return [];
    const lang = await this.settings.get('general.language');
    const out: SearchResultDto[] = [];
    if (principal.has('employee.profile.view')) {
      for (const e of await this.employees.list(principal, { q: text, limit: 10 })) {
        out.push({ kind: 'employee', id: e.id, title: lang === 'ar' ? e.fullNameAr : e.fullNameEn, subtitle: e.employeeNo, link: `/employees/${e.id}` });
      }
    }
    if (principal.has('contracts.view') || principal.has('contracts.manage')) {
      for (const c of (await this.contracts.search(principal, { q: text })).slice(0, 10)) {
        out.push({ kind: 'contract', id: c.id, title: c.contractNo, subtitle: lang === 'ar' ? c.employeeName.ar : c.employeeName.en, link: `/contracts/${c.id}` });
      }
    }
    const recruitCompanies = (await this.database.tx(principal.rls(), (tx) => tx.select({ id: company.id }).from(company)))
      .map((c) => c.id)
      .filter((id) => principal.touchesCompany('recruitment.view', id) || principal.canCompany('recruitment.manage', id));
    if (recruitCompanies.length) {
      const like = `%${text.replace(/[%_\\]/g, (ch) => `\\${ch}`)}%`;
      await this.database.tx(principal.rls(), async (tx) => {
        const cands = await tx
          .select()
          .from(candidate)
          .where(and(inArray(candidate.companyId, recruitCompanies), or(ilike(candidate.fullNameAr, like), ilike(candidate.fullNameEn, like), ilike(candidate.email, like))))
          .limit(10);
        for (const c of cands) out.push({ kind: 'candidate', id: c.id, title: lang === 'ar' ? c.fullNameAr : c.fullNameEn, subtitle: c.email ?? '', link: `/recruitment?candidate=${c.id}` });
        const vacs = await tx.select().from(vacancy).where(and(inArray(vacancy.companyId, recruitCompanies), ilike(vacancy.title, like))).limit(10);
        for (const v of vacs) out.push({ kind: 'vacancy', id: v.id, title: v.title, subtitle: v.status, link: `/recruitment/vacancies/${v.id}` });
      });
    }
    return out;
  }

  // --- dashboards -------------------------------------------------------------------------------

  async widgets(principal: Principal): Promise<WidgetDto[]> {
    const layouts = await this.settings.get('dashboard.layouts');
    const chosen = new Map<WidgetKey, 'small' | 'large'>();
    for (const roleKey of principal.roleKeys) for (const w of layouts.roles[roleKey] ?? []) if (!chosen.has(w.widget)) chosen.set(w.widget, w.size);
    const keys = WIDGETS.filter((k) => chosen.has(k) && NEEDS[k](principal));
    const tz = await this.settings.get('general.timezone');
    const today = localDate(new Date(), tz);
    const out: WidgetDto[] = [];
    for (const widget of keys) {
      try {
        out.push({ widget, size: chosen.get(widget)!, data: await this.data(widget, principal, today) });
      } catch (err) {
        // One failing widget must not break the dashboard.
        this.logger.warn(`Widget ${widget} failed: ${(err as Error).message}`);
      }
    }
    return out;
  }

  private companiesFor(principal: Principal, perm: Parameters<Principal['scope']>[0]) {
    return this.database.tx(principal.rls(), async (tx) => {
      const rows = await tx.select({ id: company.id, ar: company.nameAr, en: company.nameEn }).from(company).orderBy(asc(company.code));
      return rows.filter((c) => principal.touchesCompany(perm, c.id) || principal.canCompany(perm, c.id));
    });
  }

  private async data(widget: WidgetKey, principal: Principal, today: string): Promise<Record<string, unknown>> {
    switch (widget) {
      case 'my_attendance': {
        const [d] = await this.database.tx(principal.rls(), (tx) => tx.select().from(attendanceDay).where(and(eq(attendanceDay.employeeId, principal.employeeId!), eq(attendanceDay.workDate, today))));
        return { status: d?.status ?? null, firstIn: d?.firstIn?.toISOString() ?? null, lateMinutes: d?.lateMinutes ?? 0 };
      }
      case 'my_leave': {
        const b = await this.leave.balances(principal, principal.employeeId!);
        return { balances: b.filter((x) => x.tracked).slice(0, 3).map((x) => ({ nameAr: x.nameAr, nameEn: x.nameEn, available: x.available })) };
      }
      case 'my_tasks':
        return { pending: (await this.workflow.myTasks(principal, 'pending')).length };
      case 'headcount': {
        const cos = await this.companiesFor(principal, 'employee.profile.view');
        const rows = await this.database.tx(principal.rls(), (tx) =>
          tx
            .select({ c: employeeCurrentAssignment.companyId, d: employeeCurrentAssignment.departmentId })
            .from(employeeCurrentAssignment)
            .innerJoin(employee, eq(employee.id, employeeCurrentAssignment.employeeId))
            .where(and(inArray(employeeCurrentAssignment.companyId, ids(cos)), ne(employee.status, 'terminated'))),
        );
        const mine = rows.filter((r) => principal.canDepartment('employee.profile.view', r.c, r.d ?? ''));
        return { companies: cos.map((c) => ({ nameAr: c.ar, nameEn: c.en, count: mine.filter((r) => r.c === c.id).length })) };
      }
      case 'attendance_today': {
        const cos = await this.companiesFor(principal, 'attendance.record.view');
        const rows = await this.database.tx(principal.rls(), (tx) =>
          tx
            .select({ c: attendanceDay.companyId, d: employeeCurrentAssignment.departmentId, status: attendanceDay.status, late: attendanceDay.lateMinutes })
            .from(attendanceDay)
            .leftJoin(employeeCurrentAssignment, eq(employeeCurrentAssignment.employeeId, attendanceDay.employeeId))
            .where(and(eq(attendanceDay.workDate, today), inArray(attendanceDay.companyId, ids(cos)))),
        );
        const scoped = rows.filter((r) => principal.canDepartment('attendance.record.view', r.c, r.d ?? ''));
        return {
          companies: cos.map((c) => {
            const mine = scoped.filter((r) => r.c === c.id);
            return {
              nameAr: c.ar,
              nameEn: c.en,
              present: mine.filter((r) => r.status === 'present' || r.status === 'incomplete').length,
              late: mine.filter((r) => r.late > 0).length,
              absent: mine.filter((r) => r.status === 'absent_pending' || r.status === 'absent_confirmed').length,
            };
          }),
        };
      }
      case 'on_leave_today': {
        const cos = await this.companiesFor(principal, 'leave.request.view');
        const rows = await this.database.tx(principal.rls(), (tx) =>
          tx
            .select({ c: leaveRequest.companyId, d: employeeCurrentAssignment.departmentId, ar: employee.fullNameAr, en: employee.fullNameEn, end: leaveRequest.endDate })
            .from(leaveRequest)
            .innerJoin(employee, eq(employee.id, leaveRequest.employeeId))
            .leftJoin(employeeCurrentAssignment, eq(employeeCurrentAssignment.employeeId, leaveRequest.employeeId))
            .where(and(eq(leaveRequest.status, 'approved'), lte(leaveRequest.startDate, today), gte(leaveRequest.endDate, today), inArray(leaveRequest.companyId, ids(cos))))
            .limit(200),
        );
        const mine = rows.filter((r) => principal.canDepartment('leave.request.view', r.c, r.d ?? ''));
        return { count: mine.length, people: mine.slice(0, 8).map((r) => ({ nameAr: r.ar, nameEn: r.en, until: r.end })) };
      }
      case 'pending_approvals': {
        const list = await this.workflow.companyInstances(principal, { status: 'pending' });
        const by = new Map<string, { nameAr: string; nameEn: string; count: number }>();
        for (const i of list) {
          const g = by.get(i.definitionKey) ?? { nameAr: i.definitionNameAr, nameEn: i.definitionNameEn, count: 0 };
          g.count++;
          by.set(i.definitionKey, g);
        }
        return { total: list.length, byType: [...by.values()] };
      }
      case 'contracts_expiring': {
        const list = await this.contracts.search(principal, { expiringWithin: 30 });
        return { count: list.length, contracts: list.slice(0, 8).map((c) => ({ id: c.id, no: c.contractNo, nameAr: c.employeeName.ar, nameEn: c.employeeName.en, endDate: c.endDate })) };
      }
      case 'open_vacancies': {
        const cos = (await this.companiesFor(principal, 'recruitment.view')).map((c) => c.id);
        const rows = await this.database.tx(principal.rls(), (tx) =>
          tx.select({ id: vacancy.id, title: vacancy.title, openings: vacancy.openings }).from(vacancy).where(and(eq(vacancy.status, 'open'), inArray(vacancy.companyId, cos.concat('00000000-0000-0000-0000-000000000000')))).limit(20),
        );
        return { count: rows.length, vacancies: rows.slice(0, 6) };
      }
      case 'payroll_status': {
        const month = today.slice(0, 7);
        const cos = await this.companiesFor(principal, principal.has('payroll.view') ? 'payroll.view' : 'payroll.summary.view');
        const runs = await this.database.tx(principal.rls(), (tx) =>
          tx
            .select({ c: payrollRun.companyId, status: payrollRun.status, period: payrollRun.period })
            .from(payrollRun)
            .where(and(inArray(payrollRun.period, [month, prevMonth(month)]), ne(payrollRun.status, 'superseded'), inArray(payrollRun.companyId, cos.map((c) => c.id).concat('00000000-0000-0000-0000-000000000000')))),
        );
        return {
          month,
          companies: cos.map((c) => ({
            nameAr: c.ar,
            nameEn: c.en,
            current: runs.find((r) => r.c === c.id && r.period === month)?.status ?? null,
            previous: runs.find((r) => r.c === c.id && r.period === prevMonth(month))?.status ?? null,
          })),
        };
      }
      case 'system_health': {
        const s = await this.backups.status();
        return { lastBackup: s.lastBackup ? { at: s.lastBackup.startedAt, status: s.lastBackup.status } : null, lastRestoreTest: s.lastRestoreTest ? { at: s.lastRestoreTest.startedAt, status: s.lastRestoreTest.status } : null, configured: s.configured };
      }
    }
  }
}

function prevMonth(m: string): string {
  const [y, mo] = m.split('-').map(Number);
  return new Date(Date.UTC(y!, mo! - 2, 1)).toISOString().slice(0, 7);
}

/** Company ids for an IN list (never empty). */
function ids(cos: { id: string }[]): string[] {
  return cos.map((c) => c.id).concat('00000000-0000-0000-0000-000000000000');
}
