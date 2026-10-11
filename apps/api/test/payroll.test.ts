import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { setup, type Session, type TestEnv } from './helpers.js';
import { uuidv7 } from '../src/common/ids.js';
import { attendanceDay, leaveRequest, leaveType, role, roleAssignment, rolePermission, userAccount } from '../src/db/schema.js';

const allWeek = [1, 2, 3, 4, 5, 6, 7].map((d) => ({ isoWeekday: d, isWorkday: true, startTime: '08:00', endTime: '16:00', breaks: [] }));

describe('payroll (PAY-01..11)', () => {
  let env: TestEnv;
  const s: Record<string, Session> = {};
  let A: string;
  let emp: string;
  let mgr: string;
  let runId: string;
  // Last full month.
  const now = new Date();
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const period = first.toISOString().slice(0, 7);
  const d = (day: number) => `${period}-${String(day).padStart(2, '0')}`;
  const daysInPeriod = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();

  const lineOf = (run: { lines: { employeeId: string }[] }, id: string) => run.lines.find((l) => l.employeeId === id) as unknown as { id: string; gross: number; deductions: number; net: number; items: { id: string; code: string; amount: number; source: string; explanation: string }[] };
  const item = (line: ReturnType<typeof lineOf>, code: string) => line.items.find((i) => i.code === code)?.amount;

  beforeAll(async () => {
    env = await setup();
    A = env.seeded.companies['DEMO-A']!;
    emp = env.seeded.employees['employee.a']!;
    mgr = env.seeded.employees['sales.manager']!;
    for (const u of ['admin', 'hr.a', 'hr.b', 'employee.a', 'manager.a', 'finance.a', 'senior']) s[u] = await env.login(u);
    const sched = await s['hr.a']!.post('/schedules', { companyId: A, code: 'ALL', nameAr: 'كل الأيام', nameEn: 'All days', graceInMinutes: 10, graceOutMinutes: 5, days: allWeek });
    await s['hr.a']!.post('/schedule-assignments', { scheduleId: sched.body.id, targetType: 'company', companyId: A, validFrom: '2020-01-01' });
    // Attendance and unpaid leave facts for the period (normally produced by Phases 4 and 5).
    await env.database.system(async (tx) => {
      const base = { employeeId: emp, companyId: A, dayClass: 'workday' as const, scheduledStart: '08:00', scheduledEnd: '16:00', flags: [] as string[] };
      await tx.insert(attendanceDay).values([
        { id: uuidv7(), ...base, workDate: d(3), status: 'present', workedMinutes: 600, overtimeMinutes: 120, lateMinutes: 0 },
        { id: uuidv7(), ...base, workDate: d(4), status: 'present', workedMinutes: 400, lateMinutes: 80 },
        { id: uuidv7(), ...base, workDate: d(5), status: 'absent_confirmed' },
      ]);
      const [unpaid] = await tx.select().from(leaveType).where(eq(leaveType.code, 'UNPAID'));
      const [u] = await tx.select().from(userAccount).where(eq(userAccount.username, 'employee.a'));
      await tx.insert(leaveRequest).values({ id: uuidv7(), employeeId: emp, companyId: A, leaveTypeId: unpaid!.id, startDate: d(10), endDate: d(11), days: '2', status: 'approved', requestedBy: u!.id });
    });
  });
  afterAll(async () => env.close());

  it('only payroll staff of the company prepare payroll', async () => {
    expect((await s['hr.a']!.post('/payroll/runs', { companyId: A, period })).status).toBe(403);
    expect((await s['employee.a']!.get(`/payroll/runs?companyId=${A}`)).status).toBe(404);
  });

  it('calculates every employee from salary records, attendance and leave, with explanations', async () => {
    const r = await s['finance.a']!.post('/payroll/runs', { companyId: A, period });
    expect(r.status, r.text).toBe(201);
    runId = r.body.id;
    expect(r.body).toMatchObject({ status: 'draft', revision: 1, periodStart: d(1), periodEnd: d(daysInPeriod) });
    expect(r.body.lines).toHaveLength(3);
    const line = lineOf(r.body, emp);
    // 3100/30 = 103.333…: overtime 2 h × 103.33/8 × 1.25; absence 1 day; unpaid leave 2 days; lateness off by default.
    expect(item(line, 'BASE')).toBe(3100);
    expect(line.items.find((i) => i.source === 'recurring')?.amount).toBe(150);
    expect(item(line, 'OVERTIME')).toBe(32.29);
    expect(item(line, 'ABSENCE')).toBe(103.33);
    expect(item(line, 'UNPAID_LEAVE')).toBe(206.67);
    expect(item(line, 'LATENESS')).toBeUndefined();
    expect(line).toMatchObject({ gross: 3282.29, deductions: 310, net: 2972.29 });
    expect(line.items.find((i) => i.code === 'OVERTIME')?.explanation).toContain('× 1.25');
    expect(r.body.totals).toEqual([{ currency: 'EUR', gross: expect.any(Number), deductions: 310, net: expect.any(Number), employees: 3 }]);
    expect((await s['finance.a']!.post('/payroll/runs', { companyId: A, period })).status).toBe(409);
  });

  it('manual bonuses are kept across recalculation and can be removed before approval', async () => {
    const r = await s['finance.a']!.post(`/payroll/runs/${runId}/employees/${emp}/items`, { kind: 'earning', label: 'Sales bonus', amount: 200 });
    expect(r.status, r.text).toBe(201);
    expect(lineOf(r.body, emp).net).toBe(3172.29);
    const again = await s['finance.a']!.post(`/payroll/runs/${runId}/calculate`);
    const bonus = lineOf(again.body, emp).items.find((i) => i.source === 'manual')!;
    expect(bonus.amount).toBe(200);
    const removed = await s['finance.a']!.post(`/payroll/runs/${runId}/items/${bonus.id}/remove`);
    expect(lineOf(removed.body, emp).net).toBe(2972.29);
    await s['finance.a']!.post(`/payroll/runs/${runId}/employees/${emp}/items`, { kind: 'earning', label: 'Sales bonus', amount: 200 });
  });

  it('approval: the preparer cannot approve; the company manager approves; the run is locked (PAY-04, PAY-05)', async () => {
    const sub = await s['finance.a']!.post(`/payroll/runs/${runId}/submit`);
    expect(sub.status, sub.text).toBe(201);
    expect(sub.body.status).toBe('submitted');
    expect((await s['finance.a']!.get('/workflow/tasks')).body.some((i: { subjectId: string }) => i.subjectId === runId)).toBe(false);
    expect((await s['finance.a']!.post(`/payroll/runs/${runId}/calculate`)).status).toBe(409);
    const tasks = await s['manager.a']!.get('/workflow/tasks');
    const inst = tasks.body.find((i: { subjectId: string }) => i.subjectId === runId);
    const task = inst.tasks.find((t: { status: string }) => t.status === 'pending');
    expect((await s['manager.a']!.post(`/workflow/tasks/${task.id}/decision`, { decision: 'approve' })).body.status).toBe('approved');
    const run = await s['finance.a']!.get(`/payroll/runs/${runId}`);
    expect(run.body).toMatchObject({ status: 'approved', lockedAt: expect.any(String) });
  });

  it('a locked run cannot be changed through the API or the database (NEG-07)', async () => {
    expect((await s['finance.a']!.post(`/payroll/runs/${runId}/employees/${emp}/items`, { kind: 'earning', label: 'Late bonus', amount: 1 })).status).toBe(409);
    await expect(env.database.owner.exec(`update payroll_item set amount = 1`)).rejects.toThrow(/locked/);
    await expect(env.database.owner.exec(`delete from payroll_line`)).rejects.toThrow(/locked/);
    await expect(env.database.owner.exec(`update payroll_run set fx_rates = '{"USD":1}' where locked_at is not null`)).rejects.toThrow(/locked/);
    await expect(env.database.owner.exec(`delete from payroll_run`)).rejects.toThrow(/cannot be deleted/);
  });

  it('employees see only their own approved payslips (PAY-03, NEG-01)', async () => {
    const mine = await s['employee.a']!.get('/payroll/payslips/mine');
    expect(mine.status).toBe(200);
    expect(mine.body).toHaveLength(1);
    expect(mine.body[0]).toMatchObject({ period, net: 3172.29, currency: 'EUR', paymentStatus: null });
    const run = await s['finance.a']!.get(`/payroll/runs/${runId}`);
    const other = lineOf(run.body, mgr);
    expect((await s['employee.a']!.get(`/payroll/payslips/${other.id}`)).status).toBe(404);
    expect((await s['employee.a']!.get(`/payroll/runs/${runId}`)).status).toBe(404);
    const notes = await s['employee.a']!.get('/notifications');
    expect(notes.body.some((n: { eventType: string }) => n.eventType === 'payroll.payslip')).toBe(true);
  });

  it('payments are recorded with history (PAY-06)', async () => {
    const run = await s['finance.a']!.get(`/payroll/runs/${runId}`);
    const line = lineOf(run.body, emp);
    expect((await s['hr.a']!.post(`/payroll/lines/${line.id}/payments`, { status: 'paid', method: 'bank_transfer', amount: 1 })).status).toBe(403);
    await s['finance.a']!.post(`/payroll/lines/${line.id}/payments`, { status: 'pending', method: 'bank_transfer', amount: line.net });
    const p = await s['finance.a']!.post(`/payroll/lines/${line.id}/payments`, { status: 'paid', method: 'bank_transfer', amount: line.net, reference: 'TRX-1', paidOn: d(28) });
    expect(p.status, p.text).toBe(201);
    expect(p.body.payments.map((x: { status: string }) => x.status)).toEqual(['pending', 'paid']);
    expect((await s['employee.a']!.get(`/payroll/payslips/${line.id}`)).body.paymentStatus).toBe('paid');
  });

  it('reopening needs the special permission and creates a new revision (PAY-05)', async () => {
    expect((await s['finance.a']!.post(`/payroll/runs/${runId}/reopen`, { reason: 'Missing overtime' })).status).toBe(403);
    await env.database.system(async (tx) => {
      const id = uuidv7();
      await tx.insert(role).values({ id, key: 'payroll_supervisor', nameAr: 'مشرف رواتب', nameEn: 'Payroll supervisor' });
      await tx.insert(rolePermission).values([{ roleId: id, permissionKey: 'payroll.reopen' }]);
      const [u] = await tx.select().from(userAccount).where(eq(userAccount.username, 'finance.a'));
      await tx.insert(roleAssignment).values({ id: uuidv7(), userId: u!.id, roleId: id, scopeType: 'COMPANY', companyId: A });
    });
    const r = await s['finance.a']!.post(`/payroll/runs/${runId}/reopen`, { reason: 'Missing overtime' });
    expect(r.status, r.text).toBe(201);
    expect(r.body).toMatchObject({ status: 'draft', revision: 2, revisionOfId: runId, reopenReason: 'Missing overtime' });
    expect(lineOf(r.body, emp).items.some((i) => i.source === 'manual')).toBe(true);
    expect((await s['finance.a']!.get(`/payroll/runs/${runId}`)).body.status).toBe('superseded');
    const list = await s['finance.a']!.get(`/payroll/runs?companyId=${A}`);
    expect(list.body.map((x: { revision: number }) => x.revision)).toEqual([2, 1]);
    // The old approved payslip is no longer shown; the new one appears once approved.
    expect((await s['employee.a']!.get('/payroll/payslips/mine')).body).toHaveLength(0);
  });

  it('group summary: per-currency totals and conversion with rates entered on the run (Q-13)', async () => {
    const list = await s['finance.a']!.get(`/payroll/runs?companyId=${A}`);
    const current = list.body.find((x: { status: string }) => x.status === 'draft');
    await s['finance.a']!.put(`/payroll/runs/${current.id}/fx-rates`, { rates: { USD: 0.9 } });
    expect((await s['finance.a']!.get(`/payroll/summary?period=${period}`)).status).toBe(403);
    const sum = await s['senior']!.get(`/payroll/summary?period=${period}`);
    expect(sum.status, sum.text).toBe(200);
    const a = sum.body.companies.find((c: { companyId: string }) => c.companyId === A);
    expect(a.totals[0]).toMatchObject({ currency: 'EUR', employees: 3 });
    expect(sum.body.totals).toEqual([expect.objectContaining({ currency: 'EUR', employees: 3 })]);
    expect(sum.body.converted).toMatchObject({ currency: 'EUR', missingRates: [] });
  });

  it('end of service uses the configured method (PAY-11)', async () => {
    const none = await s['finance.a']!.get(`/payroll/end-of-service/${emp}?endDate=2026-06-14`);
    expect(none.body).toMatchObject({ amount: 0, monthlyBase: 3100 });
    const set = await s['admin']!.put('/settings/payroll.endOfService', { value: { method: 'days_per_year', bands: [{ fromYears: 0, daysPerYear: 15 }], monthsPerYear: 0, minYears: 1, capMonths: null } });
    expect(set.status, set.text).toBe(204);
    const r = await s['finance.a']!.get(`/payroll/end-of-service/${emp}?endDate=2026-06-14`);
    // Hired 2023-06-15: 3 years × 15 days × 3100/30
    expect(r.body.serviceYears).toBeCloseTo(3, 1);
    expect(r.body.amount).toBeCloseTo(4650, -1);
    expect((await s['hr.b']!.get(`/payroll/end-of-service/${emp}?endDate=2026-06-14`)).status).toBe(404);
  });
});
