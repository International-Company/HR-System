import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { API, TEST_PASSWORD, setup, type Session, type TestEnv } from './helpers.js';
import { SeparationService } from '../src/separation/separation.service.js';
import { addDays } from '../src/attendance/time.js';
import { employmentAssignment, separation } from '../src/db/schema.js';

const allWeek = [1, 2, 3, 4, 5, 6, 7].map((d) => ({ isoWeekday: d, isWorkday: true, startTime: '08:00', endTime: '16:00', breaks: [] }));

describe('separation and rehire (TRM-01..08)', () => {
  let env: TestEnv;
  const s: Record<string, Session> = {};
  let A: string;
  let emp: string;
  let fin: string;
  let empSeparation: string;
  const today = new Date().toISOString().slice(0, 10);

  const decide = async (who: string, subjectId: string) => {
    const tasks = await s[who]!.get('/workflow/tasks');
    const inst = tasks.body.find((i: { subjectId: string }) => i.subjectId === subjectId);
    expect(inst, `${who} has no task`).toBeTruthy();
    const task = inst.tasks.find((t: { status: string }) => t.status === 'pending');
    return s[who]!.post(`/workflow/tasks/${task.id}/decision`, { decision: 'approve' });
  };

  beforeAll(async () => {
    env = await setup();
    A = env.seeded.companies['DEMO-A']!;
    emp = env.seeded.employees['employee.a']!;
    fin = env.seeded.employees['emp.fin']!;
    for (const u of ['admin', 'hr.a', 'hr.b', 'employee.a', 'sales.manager', 'manager.a']) s[u] = await env.login(u);
    const sched = await s['hr.a']!.post('/schedules', { companyId: A, code: 'ALL', nameAr: 'كل الأيام', nameEn: 'All days', graceInMinutes: 10, graceOutMinutes: 5, days: allWeek });
    await s['hr.a']!.post('/schedule-assignments', { scheduleId: sched.body.id, targetType: 'company', companyId: A, validFrom: '2020-01-01' });
    await s['admin']!.put('/settings/payroll.endOfService', { value: { method: 'days_per_year', bands: [{ fromYears: 0, daysPerYear: 15 }], monthsPerYear: 0, minYears: 1, capMonths: null } });
  });
  afterAll(async () => env.close());

  it('employees resign themselves with the notice period; only resignation; one at a time (TRM-01, TRM-04)', async () => {
    expect((await s['employee.a']!.post('/separations', { type: 'resignation', lastWorkingDay: addDays(today, 10), reason: 'New job abroad' })).status).toBe(400);
    expect((await s['employee.a']!.post('/separations', { type: 'termination', lastWorkingDay: addDays(today, 40), reason: 'x x x' })).status).toBe(403);
    expect((await s['employee.a']!.post('/separations', { employeeId: fin, type: 'resignation', lastWorkingDay: addDays(today, 40), reason: 'x x x' })).status).toBe(404);
    const r = await s['employee.a']!.post('/separations', { type: 'resignation', lastWorkingDay: addDays(today, 40), reason: 'New job abroad' });
    expect(r.status, r.text).toBe(201);
    expect(r.body).toMatchObject({ status: 'pending', initiatedBySelf: true });
    expect((await s['employee.a']!.post('/separations', { type: 'resignation', lastWorkingDay: addDays(today, 50), reason: 'again' })).status).toBe(409);
    // The direct manager gets the first step.
    expect((await s['sales.manager']!.get('/workflow/tasks')).body.some((i: { subjectId: string }) => i.subjectId === r.body.id)).toBe(true);
    const c = await s['employee.a']!.post(`/separations/${r.body.id}/cancel`, { reason: 'Changed my mind' });
    expect(c.body.status).toBe('cancelled');
  });

  it('a cancelled approved separation restores the employment (TRM-02)', async () => {
    const r = await s['hr.a']!.post('/separations', { employeeId: fin, type: 'termination', lastWorkingDay: addDays(today, 20), reason: 'Restructuring' });
    expect(r.status, r.text).toBe(201);
    expect((await decide('manager.a', r.body.id)).body.status).toBe('approved');
    const [a1] = await env.database.system((tx) => tx.select().from(employmentAssignment).where(eq(employmentAssignment.employeeId, fin)));
    expect(a1!.validTo).toBe(addDays(today, 20));
    const c = await s['hr.a']!.post(`/separations/${r.body.id}/cancel`, { reason: 'Position kept' });
    expect(c.body.status).toBe('cancelled');
    const [a2] = await env.database.system((tx) => tx.select().from(employmentAssignment).where(eq(employmentAssignment.employeeId, fin)));
    expect(a2!.validTo).toBeNull();
  });

  it('a past last working day completes on approval: access ends, history stays (TRM-05, TRM-06, NEG-05)', async () => {
    const leave = await s['employee.a']!.post('/leave/requests', { leaveTypeId: (await s['employee.a']!.get('/leave/types')).body.find((t: { code: string }) => t.code === 'ANNUAL').id, startDate: addDays(today, 60), endDate: addDays(today, 61) });
    expect(leave.status, leave.text).toBe(201);
    const r = await s['hr.a']!.post('/separations', { employeeId: emp, type: 'termination', lastWorkingDay: addDays(today, -1), reason: 'Gross misconduct', rehireEligible: true });
    expect(r.status, r.text).toBe(201);
    empSeparation = r.body.id;
    const d = await decide('manager.a', r.body.id);
    expect(d.body.status, d.text).toBe('approved');

    // NEG-05: the old session no longer works, and the account cannot sign in.
    expect((await s['employee.a']!.get('/auth/session')).status).toBe(401);
    const login = await env.anon().post(`${API}/auth/login`).send({ username: 'employee.a', password: TEST_PASSWORD });
    expect(login.status).toBeGreaterThanOrEqual(400);

    const sep = await s['hr.a']!.get(`/separations/${r.body.id}`);
    expect(sep.body).toMatchObject({ status: 'completed', completedAt: expect.any(String) });
    // Hired 2023-06-15: ~3.3 years × 15 days of (3100 ÷ 30); visible with the financial permission only.
    expect(sep.body.settlement.amount).toBeGreaterThan(5000);
    expect((await s['manager.a']!.get(`/separations/${r.body.id}`)).body.settlement).toBeNull();

    // History is intact and the former employee stays visible to the company's HR (TRM-06).
    const e = await s['hr.a']!.get(`/employees/${emp}`);
    expect(e.status, e.text).toBe(200);
    expect(e.body.status).toBe('terminated');
    const h = await s['hr.a']!.get(`/employees/${emp}/history`);
    expect(h.body.events.map((x: { type: string }) => x.type)).toEqual(expect.arrayContaining(['hire', 'separation_approved', 'separation']));
    const req = await s['hr.a']!.get(`/leave/requests/${leave.body.id}`);
    expect(req.body.status).toBe('cancelled');
    expect((await s['hr.b']!.get(`/employees/${emp}`)).status).toBe(404);
  });

  it('the daily job completes due separations', async () => {
    const r = await s['hr.a']!.post('/separations', { employeeId: fin, type: 'retirement', lastWorkingDay: addDays(today, 5), reason: 'Retirement age' });
    expect((await decide('manager.a', r.body.id)).body.status).toBe('approved');
    const svc = env.app.get(SeparationService);
    expect(await svc.daily()).toBe(0);
    await env.database.system(async (tx) => {
      await tx.update(separation).set({ lastWorkingDay: addDays(today, -2) }).where(eq(separation.id, r.body.id));
      await tx.update(employmentAssignment).set({ validTo: addDays(today, -2) }).where(eq(employmentAssignment.employeeId, fin));
    });
    expect(await svc.daily()).toBe(1);
    expect((await s['hr.a']!.get(`/employees/${fin}`)).body.status).toBe('terminated');
  });

  it('rehire keeps the employee number and history; ineligibility needs an override (TRM-07)', async () => {
    const before = (await s['hr.a']!.get(`/employees/${emp}`)).body;
    await s['hr.a']!.post(`/separations/${empSeparation}/eligibility`, { rehireEligible: false });
    const body = { effectiveDate: today, probationEndDate: null, assignment: { companyId: A }, reason: 'Rehired after review' };
    expect((await s['hr.a']!.post(`/employees/${emp}/rehire`, { ...body, effectiveDate: addDays(today, -1) })).status).toBe(400);
    expect((await s['hr.a']!.post(`/employees/${emp}/rehire`, body)).status).toBe(409);
    const r = await s['hr.a']!.post(`/employees/${emp}/rehire`, { ...body, overrideIneligible: true });
    expect(r.status, r.text).toBe(201);
    expect(r.body).toMatchObject({ employeeNo: before.employeeNo, status: 'active', hireDate: today });
    const h = await s['hr.a']!.get(`/employees/${emp}/history`);
    expect(h.body.assignments.length).toBeGreaterThanOrEqual(2);
    expect(h.body.events.map((x: { type: string }) => x.type)).toContain('rehire');
    expect((await s['hr.a']!.post(`/employees/${emp}/rehire`, body)).status).toBe(409);
  });
});
