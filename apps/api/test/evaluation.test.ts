import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_EVALUATION_POLICY, PERMISSION_KEYS } from '@hrms/shared';
import { setup, type Session, type TestEnv } from './helpers.js';

const allWeek = [1, 2, 3, 4, 5, 6, 7].map((d) => ({ isoWeekday: d, isWorkday: true, startTime: '08:00', endTime: '16:00', breaks: [] }));

describe('attendance commitment evaluation (CEV-01..03)', () => {
  let env: TestEnv;
  const s: Record<string, Session> = {};
  let A: string;
  let emp: string;
  let fin: string;
  const now = new Date();
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const period = first.toISOString().slice(0, 7);
  const d = (day: number) => `${period}-${String(day).padStart(2, '0')}`;

  const results = async (who = 'hr.a') => (await s[who]!.get(`/evaluation/results?companyId=${A}&period=${period}`)).body as { employeeId: string; score: number; status: string; calcVersion: number; components: { key: string; score: number }[] }[];
  const mine = async () => (await results()).find((r) => r.employeeId === emp)!;
  const comp = (r: { components: { key: string; score: number }[] }, key: string) => r.components.find((c) => c.key === key)!.score;

  beforeAll(async () => {
    env = await setup();
    A = env.seeded.companies['DEMO-A']!;
    emp = env.seeded.employees['employee.a']!;
    fin = env.seeded.employees['emp.fin']!;
    for (const u of ['admin', 'hr.a', 'hr.b', 'employee.a', 'sales.manager', 'manager.a', 'finance.a']) s[u] = await env.login(u);
    const sched = await s['hr.a']!.post('/schedules', { companyId: A, code: 'ALL', nameAr: 'كل الأيام', nameEn: 'All days', graceInMinutes: 10, graceOutMinutes: 5, days: allWeek });
    await s['hr.a']!.post('/schedule-assignments', { scheduleId: sched.body.id, targetType: 'company', companyId: A, validFrom: '2020-01-01' });
    for (const [day, inT] of [[2, '08:00'], [3, '08:00'], [4, '08:30']] as const) {
      const r = await s['hr.a']!.post('/attendance/corrections', { employeeId: emp, workDate: d(day), add: [{ kind: 'in', time: inT }, { kind: 'out', time: '16:00' }], reason: 'Card reader fault' });
      expect(r.status, r.text).toBe(201);
    }
  });
  afterAll(async () => env.close());

  it('scores from attendance only; only staff with the permission calculate', async () => {
    expect((await s['employee.a']!.post('/evaluation/calculate', { companyId: A, period })).status).toBe(403);
    expect((await s['hr.a']!.post('/evaluation/calculate', { companyId: A, period: `${period.slice(0, 4)}-Q1` })).status).toBe(400);
    const r = await s['hr.a']!.post('/evaluation/calculate', { companyId: A, period });
    expect(r.status, r.text).toBe(201);
    expect(r.body.calculated).toBeGreaterThanOrEqual(3);
    const m = await mine();
    expect(m.status).toBe('draft');
    expect(comp(m, 'attendance')).toBe(100);
    expect(comp(m, 'punctuality')).toBe(66.67);
    expect(m.components.map((c) => c.key).sort()).toEqual(['attendance', 'early_departure', 'overtime', 'punctuality', 'worked_hours']);
  });

  it('a confirmed absence lowers the attendance component after recalculation', async () => {
    const review = await s['hr.a']!.post(`/attendance/employees/${emp}/days/${d(5)}/review`, { action: 'confirm_absence', note: 'No contact' });
    expect(review.status, review.text).toBe(204);
    await s['hr.a']!.post('/evaluation/calculate', { companyId: A, period });
    const m = await mine();
    expect(comp(m, 'attendance')).toBe(75);
    expect(m.calcVersion).toBe(2);
  });

  it('final results change only with a reason, audited (CEV-02)', async () => {
    expect((await s['hr.a']!.post('/evaluation/finalize', { companyId: A, period })).body.finalized).toBeGreaterThanOrEqual(3);
    const before = await mine();
    const again = await s['hr.a']!.post('/evaluation/calculate', { companyId: A, period });
    expect(again.body.skippedFinal).toBeGreaterThanOrEqual(3);
    expect((await mine()).calcVersion).toBe(before.calcVersion);
    expect((await s['hr.a']!.post('/evaluation/recalculate', { companyId: A, period })).status).toBe(400);
    const r = await s['hr.a']!.post('/evaluation/recalculate', { companyId: A, period, reason: 'Corrected attendance data' });
    expect(r.status, r.text).toBe(201);
    const after = await mine();
    expect(after).toMatchObject({ status: 'final', calcVersion: before.calcVersion + 1 });
    const audit = await s['admin']!.get('/audit-events?action=evaluation.recalculated');
    expect(audit.body.items.length).toBeGreaterThan(0);
  });

  it('visibility: own final results by policy; managers by department; other companies none', async () => {
    expect((await s['employee.a']!.get(`/evaluation/employees/${emp}`)).body).toHaveLength(1);
    expect((await s['employee.a']!.get(`/evaluation/employees/${fin}`)).body).toEqual([]);
    expect((await s['employee.a']!.get(`/evaluation/results?companyId=${A}&period=${period}`)).status).toBe(404);
    expect((await s['hr.b']!.get(`/evaluation/results?companyId=${A}&period=${period}`)).status).toBe(404);
    const dept = await results('sales.manager');
    expect(dept.some((r) => r.employeeId === emp)).toBe(true);
    expect(dept.some((r) => r.employeeId === fin)).toBe(false);
    await s['admin']!.put('/settings/evaluation.policy', { value: { ...DEFAULT_EVALUATION_POLICY, employeeVisible: false } });
    expect((await s['employee.a']!.get(`/evaluation/employees/${emp}`)).body).toEqual([]);
  });

  it('optional salary impact adds the band bonus to payroll (CEV-02)', async () => {
    const bands = DEFAULT_EVALUATION_POLICY.bands.map((b) => ({ ...b, bonusPercent: 5 }));
    expect((await s['admin']!.put('/settings/evaluation.policy', { value: { ...DEFAULT_EVALUATION_POLICY, bands, salaryImpact: true } })).status).toBe(204);
    // The band (and its bonus) is stored with the result: recalculate to apply the new bands.
    await s['hr.a']!.post('/evaluation/recalculate', { companyId: A, period, reason: 'New bonus bands' });
    const run = await s['finance.a']!.post('/payroll/runs', { companyId: A, period });
    expect(run.status, run.text).toBe(201);
    const line = run.body.lines.find((l: { employeeId: string }) => l.employeeId === emp);
    expect(line.items.find((i: { code: string }) => i.code === 'COMMITMENT')).toMatchObject({ amount: 155 }); // 3100 × 5%
  });

  it('has no performance-appraisal, goals or self-assessment features (CEV-03, EXC-01, EXC-02)', () => {
    const forbidden = /apprais|goal|self[-_ ]?assess|kpi|performance/i;
    expect(PERMISSION_KEYS.filter((k) => forbidden.test(k))).toEqual([]);
    const dir = join(__dirname, '..', 'src');
    const routes: string[] = [];
    const walk = (p: string) => {
      for (const f of readdirSync(p, { withFileTypes: true })) {
        if (f.isDirectory()) walk(join(p, f.name));
        else if (f.name.endsWith('.controller.ts')) routes.push(...[...readFileSync(join(p, f.name), 'utf8').matchAll(/@(?:Get|Post|Put|Patch|Delete|Controller)\('([^']*)'\)/g)].map((m) => m[1]!));
      }
    };
    walk(dir);
    expect(routes.length).toBeGreaterThan(50);
    expect(routes.filter((r) => forbidden.test(r))).toEqual([]);
  });
});
