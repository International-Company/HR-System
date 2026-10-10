import { and, eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import type { AppConfig } from './config.js';
import type { Database } from './db/database.js';
import { company, companyGroup, department, role, roleAssignment, settingValue, userAccount, workLocation } from './db/schema.js';
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
    return { password, companies, departments, users };
  });
}
