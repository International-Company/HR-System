import { and, eq, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import type { AppConfig } from './config.js';
import type { Database } from './db/database.js';
import {
  company,
  companyGroup,
  compensation,
  compensationItem,
  department,
  employee,
  employmentAssignment,
  lifecycleEvent,
  lookupValue,
  role,
  roleAssignment,
  settingValue,
  userAccount,
  workLocation,
} from './db/schema.js';
import { Encryptor } from './common/crypto.js';
import { uuidv7 } from './common/ids.js';
import { PasswordService } from './auth/password.service.js';

/**
 * Deterministic synthetic data for development, tests and demos (QA-04).
 * Never runs in production; every account is flagged is_seed (QA-05).
 */
export interface SeedResult {
  password: string;
  companies: Record<string, string>;
  departments: Record<string, string>;
  users: Record<string, string>;
  employees: Record<string, string>;
}

const COMPANIES = [
  { code: 'DEMO-A', nameAr: 'شركة النخبة للتجارة', nameEn: 'Al Nokhba Trading' },
  { code: 'DEMO-B', nameAr: 'شركة الأفق للخدمات', nameEn: 'Horizon Services' },
  { code: 'DEMO-C', nameAr: 'شركة الريادة القابضة', nameEn: 'Riyada Holdings' },
] as const;

const DEPARTMENTS = [
  { company: 'DEMO-A', code: 'SALES', nameAr: 'المبيعات', nameEn: 'Sales' },
  { company: 'DEMO-A', code: 'FIN', nameAr: 'المالية', nameEn: 'Finance' },
  { company: 'DEMO-B', code: 'OPS', nameAr: 'العمليات', nameEn: 'Operations' },
  // DEMO-C intentionally has no departments (departments are optional, ORG-09).
] as const;

const PERSONAS: {
  username: string;
  name: string;
  role: string;
  scope: 'GROUP' | 'COMPANY' | 'DEPARTMENT' | 'SELF';
  company?: string;
  dept?: string;
}[] = [
  { username: 'admin', name: 'مدير النظام (تجريبي)', role: 'system_admin', scope: 'GROUP' },
  { username: 'senior', name: 'الإدارة العليا (تجريبي)', role: 'senior_management', scope: 'GROUP' },
  { username: 'hr.a', name: 'موارد بشرية - النخبة', role: 'hr', scope: 'COMPANY', company: 'DEMO-A' },
  { username: 'hr.b', name: 'موارد بشرية - الأفق', role: 'hr', scope: 'COMPANY', company: 'DEMO-B' },
  { username: 'manager.a', name: 'مدير شركة النخبة', role: 'company_manager', scope: 'COMPANY', company: 'DEMO-A' },
  { username: 'sales.manager', name: 'مدير المبيعات', role: 'department_manager', scope: 'DEPARTMENT', company: 'DEMO-A', dept: 'SALES' },
  { username: 'finance.a', name: 'محاسب النخبة', role: 'finance', scope: 'COMPANY', company: 'DEMO-A' },
  { username: 'time.a', name: 'مسؤول حضور النخبة', role: 'timekeeping', scope: 'COMPANY', company: 'DEMO-A' },
  { username: 'employee.a', name: 'موظف تجريبي', role: 'employee', scope: 'SELF' },
];

export async function seed(
  database: Database,
  cfg: AppConfig,
  opts: { password?: string; relaxMfa?: boolean } = {},
): Promise<SeedResult> {
  if (cfg.isProduction) throw new Error('Refusing to seed a production database');
  const password = opts.password ?? `Demo-${randomBytes(6).toString('base64url')}-2026`;
  const passwordHash = await new PasswordService().hash(password);

  return database.system(async (tx) => {
    let [group] = await tx.select().from(companyGroup);
    if (!group) {
      [group] = await tx
        .insert(companyGroup)
        .values({ id: uuidv7(), nameAr: 'مجموعة تجريبية', nameEn: 'Demo Holding' })
        .returning();
    }
    const companies: Record<string, string> = {};
    for (const c of COMPANIES) {
      const [existing] = await tx.select().from(company).where(eq(company.code, c.code));
      companies[c.code] =
        existing?.id ??
        (await tx.insert(company).values({ id: uuidv7(), groupId: group!.id, ...c }).returning())[0]!.id;
      if (!existing) {
        await tx.insert(workLocation).values({
          id: uuidv7(),
          companyId: companies[c.code]!,
          code: 'HQ',
          nameAr: 'المقر الرئيسي',
          nameEn: 'Head office',
        });
      }
    }
    const departments: Record<string, string> = {};
    for (const d of DEPARTMENTS) {
      const companyId = companies[d.company]!;
      const [existing] = await tx
        .select()
        .from(department)
        .where(and(eq(department.companyId, companyId), eq(department.code, d.code)));
      departments[`${d.company}/${d.code}`] = existing
          ? existing.id
          : (
              await tx
                .insert(department)
                .values({ id: uuidv7(), companyId, code: d.code, nameAr: d.nameAr, nameEn: d.nameEn })
                .returning()
            )[0]!.id;
    }
    const roles = Object.fromEntries((await tx.select().from(role)).map((r) => [r.key, r.id]));
    const users: Record<string, string> = {};
    for (const p of PERSONAS) {
      const [existing] = await tx.select().from(userAccount).where(eq(userAccount.username, p.username));
      if (existing) {
        users[p.username] = existing.id;
        continue;
      }
      const id = uuidv7();
      await tx.insert(userAccount).values({
        id,
        username: p.username,
        displayName: p.name,
        passwordHash,
        isSeed: true,
      });
      await tx.insert(roleAssignment).values({
        id: uuidv7(),
        userId: id,
        roleId: roles[p.role]!,
        scopeType: p.scope,
        companyId: p.company ? companies[p.company]! : null,
        departmentId: p.dept ? departments[`${p.company}/${p.dept}`]! : null,
      });
      users[p.username] = id;
    }
    if (opts.relaxMfa) {
      const [existing] = await tx.select().from(settingValue).where(eq(settingValue.key, 'security.mfa'));
      if (!existing) {
        await tx.insert(settingValue).values({
          id: uuidv7(),
          key: 'security.mfa',
          companyId: null,
          value: { requiredForRoles: [] },
        });
      }
    }

    // --- Phase 2 demo employees (synthetic) ---------------------------------------------
    const encryptor = Encryptor.fromConfig(cfg);
    const lookups = await tx.select().from(lookupValue);
    const lookupId = (kind: string, code: string) => lookups.find((l) => l.kind === kind && l.code === code)?.id ?? null;
    const titleIds: Record<string, string> = {};
    for (const [code, ar, en] of [
      ['ACC', 'محاسب', 'Accountant'],
      ['SALES_REP', 'مندوب مبيعات', 'Sales representative'],
      ['MGR', 'مدير', 'Manager'],
      ['HR_SPEC', 'أخصائي موارد بشرية', 'HR specialist'],
    ] as const) {
      const existing = lookups.find((l) => l.kind === 'job_title' && l.code === code);
      titleIds[code] =
        existing?.id ??
        (await tx.insert(lookupValue).values({ id: uuidv7(), kind: 'job_title', companyId: null, code, nameAr: ar, nameEn: en }).returning())[0]!.id;
    }
    const allowanceType =
      lookups.find((l) => l.kind === 'allowance_type' && l.code === 'TRANSPORT')?.id ??
      (await tx
        .insert(lookupValue)
        .values({ id: uuidv7(), kind: 'allowance_type', companyId: null, code: 'TRANSPORT', nameAr: 'بدل نقل', nameEn: 'Transport allowance' })
        .returning())[0]!.id;

    const employees: Record<string, string> = {};
    const DEMO_EMPLOYEES = [
      { key: 'sales.manager', ar: 'خالد العمري', en: 'Khalid Al-Omari', company: 'DEMO-A', dept: 'SALES', title: 'MGR', salary: '5200', idNo: 'DEMO1000001', hire: '2022-03-01' },
      { key: 'employee.a', ar: 'سارة الحسن', en: 'Sara Al-Hassan', company: 'DEMO-A', dept: 'SALES', title: 'SALES_REP', salary: '3100', idNo: 'DEMO1000002', hire: '2023-06-15', manager: 'sales.manager' },
      { key: 'emp.fin', ar: 'محمد يوسف', en: 'Mohammed Yousef', company: 'DEMO-A', dept: 'FIN', title: 'ACC', salary: '3800', idNo: 'DEMO1000003', hire: '2021-01-10' },
      { key: 'emp.ops', ar: 'ليلى منصور', en: 'Layla Mansour', company: 'DEMO-B', dept: 'OPS', title: 'HR_SPEC', salary: '3500', idNo: 'DEMO1000004', hire: '2024-02-01' },
      { key: 'emp.c', ar: 'عمر شريف', en: 'Omar Sharif', company: 'DEMO-C', dept: null, title: 'MGR', salary: '6100', idNo: 'DEMO1000005', hire: '2020-09-01' },
    ] as const;
    for (const d of DEMO_EMPLOYEES) {
      const bidx = encryptor.blindIndex('employee-id', `national_id:${d.idNo}`);
      const [existing] = await tx.select({ id: employee.id }).from(employee).where(eq(employee.idNumberBidx, bidx));
      if (existing) {
        employees[d.key] = existing.id;
        continue;
      }
      const id = uuidv7();
      const no = await tx.execute<{ n: string }>(sql`select next_employee_no('EMP-', 6) as n`);
      const companyId = companies[d.company]!;
      await tx.insert(employee).values({
        id,
        employeeNo: (no as unknown as { rows: { n: string }[] }).rows[0]!.n,
        fullNameAr: d.ar,
        fullNameEn: d.en,
        idType: 'national_id',
        idNumberEnc: encryptor.encrypt(d.idNo, `employee-id:${id}`),
        idNumberBidx: bidx,
        hireDate: d.hire,
        status: 'active',
        isSeed: true,
      });
      await tx.insert(employmentAssignment).values({
        id: uuidv7(),
        employeeId: id,
        companyId,
        departmentId: d.dept ? departments[`${d.company}/${d.dept}`]! : null,
        jobTitleId: titleIds[d.title]!,
        managerEmployeeId: 'manager' in d ? employees[d.manager]! : null,
        employmentCategoryId: lookupId('employment_category', 'full_time'),
        contractTypeId: lookupId('contract_type', 'open_ended'),
        validFrom: d.hire,
        changeReason: 'hire',
      });
      const compId = uuidv7();
      await tx.insert(compensation).values({
        id: compId,
        employeeId: id,
        companyId,
        baseSalary: d.salary,
        currency: 'EUR',
        paymentMethod: 'bank_transfer',
        validFrom: d.hire,
        changeReason: 'hire',
      });
      await tx.insert(compensationItem).values({ id: uuidv7(), compensationId: compId, kind: 'allowance', typeId: allowanceType, calc: 'fixed', amount: '150' });
      await tx.insert(lifecycleEvent).values({ id: uuidv7(), employeeId: id, companyId, type: 'hire', effectiveDate: d.hire, details: { seed: true } });
      employees[d.key] = id;
    }
    // Link demo accounts to their employee records (SELF access).
    for (const username of ['sales.manager', 'employee.a'] as const) {
      await tx.update(userAccount).set({ employeeId: employees[username]! }).where(eq(userAccount.username, username));
    }
    return { password, companies, departments, users, employees };
  });
}
