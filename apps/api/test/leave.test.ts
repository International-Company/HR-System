import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API, grant, setup, type Session, type TestEnv } from './helpers.js';
import { AttendanceService } from '../src/attendance/attendance.service.js';
import { LeaveService } from '../src/leave/leave.service.js';
import { addDays } from '../src/attendance/time.js';

const allWeek = [1, 2, 3, 4, 5, 6, 7].map((d) => ({ isoWeekday: d, isWorkday: true, startTime: '08:00', endTime: '16:00', breaks: [] }));
const PDF = Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\ntrailer << >>\n%%EOF\n');

describe('leave and in-day permissions (LEV-01..08)', () => {
  let env: TestEnv;
  const s: Record<string, Session> = {};
  let A: string;
  let emp: string;
  const types: Record<string, string> = {};
  const today = new Date().toISOString().slice(0, 10);

  const balance = async (code: string, who = 'employee.a') => {
    const r = await s[who]!.get(`/leave/employees/${emp}/balances`);
    expect(r.status, r.text).toBe(200);
    return r.body.find((b: { code: string }) => b.code === code);
  };
  const decide = async (who: string, subjectId: string, decision: 'approve' | 'reject' = 'approve') => {
    const tasks = await s[who]!.get('/workflow/tasks');
    const inst = tasks.body.find((i: { subjectId: string }) => i.subjectId === subjectId);
    expect(inst, `${who} has no task for ${subjectId}`).toBeTruthy();
    const task = inst.tasks.find((t: { status: string }) => t.status === 'pending');
    return s[who]!.post(`/workflow/tasks/${task.id}/decision`, { decision, comment: decision === 'reject' ? 'Not now' : undefined });
  };
  const approveAll = async (id: string, hr = 'hr.a') => {
    expect((await decide('sales.manager', id)).status).toBe(201);
    const r = await decide(hr, id);
    expect(r.body.status).toBe('approved');
  };
  const ask = (who: string, body: Record<string, unknown>) => s[who]!.post('/leave/requests', body);

  beforeAll(async () => {
    env = await setup();
    A = env.seeded.companies['DEMO-A']!;
    emp = env.seeded.employees['employee.a']!;
    await grant(env, 'time.a', 'hr', 'COMPANY', 'DEMO-A');
    for (const u of ['admin', 'hr.a', 'hr.b', 'employee.a', 'sales.manager', 'manager.a', 'time.a']) s[u] = await env.login(u);
    const sched = await s['hr.a']!.post('/schedules', { companyId: A, code: 'ALL', nameAr: 'كل الأيام', nameEn: 'All days', graceInMinutes: 10, graceOutMinutes: 5, days: allWeek });
    await s['hr.a']!.post('/schedule-assignments', { scheduleId: sched.body.id, targetType: 'company', companyId: A, validFrom: addDays(today, -60) });
    for (const t of (await s['employee.a']!.get('/leave/types')).body) types[t.code] = t.id;
  });
  afterAll(async () => env.close());

  it('employees can read their own company schedule (regression, DL-037)', async () => {
    const wd = await s['employee.a']!.get(`/employees/${emp}/workdays?from=${today}&to=${today}`);
    expect(wd.body[0]).toMatchObject({ isWorkday: true, startTime: '08:00' });
  });

  it('ships annual, sick and unpaid leave; balances accrue automatically', async () => {
    expect(Object.keys(types)).toEqual(expect.arrayContaining(['ANNUAL', 'SICK', 'UNPAID']));
    expect(await balance('ANNUAL')).toMatchObject({ tracked: true, balance: 21, available: 21 });
    expect(await balance('SICK')).toMatchObject({ tracked: false });
  });

  it('HR sets the opening balance; employees and other companies cannot', async () => {
    const body = { employeeId: emp, leaveTypeId: types.ANNUAL, kind: 'opening', amount: 10, effectiveDate: today, note: 'Balance from the old records' };
    expect((await s['employee.a']!.post('/leave/balances/adjust', body)).status).toBe(403);
    expect((await s['hr.b']!.post('/leave/balances/adjust', body)).status).toBe(404);
    const r = await s['hr.a']!.post('/leave/balances/adjust', body);
    expect(r.status, r.text).toBe(201);
    expect(await balance('ANNUAL')).toMatchObject({ balance: 10, available: 10 });
    const ledger = await s['employee.a']!.get(`/leave/employees/${emp}/ledger?leaveTypeId=${types.ANNUAL}`);
    expect(ledger.body.map((e: { kind: string }) => e.kind)).toEqual(expect.arrayContaining(['opening', 'accrual']));
  });

  it('a request goes employee → manager → HR and is deducted on approval (C-05)', async () => {
    const from = addDays(today, 20);
    const r = await ask('employee.a', { leaveTypeId: types.ANNUAL, startDate: from, endDate: addDays(from, 4), reason: 'Family trip' });
    expect(r.status, r.text).toBe(201);
    expect(r.body).toMatchObject({ status: 'pending', days: 5 });
    expect(await balance('ANNUAL')).toMatchObject({ balance: 10, pending: 5, available: 5 });

    const tooMuch = await ask('employee.a', { leaveTypeId: types.ANNUAL, startDate: addDays(from, 10), endDate: addDays(from, 15) });
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.body).toMatchObject({ code: 'INSUFFICIENT_BALANCE', meta: { available: 5, requested: 6 } });
    expect((await ask('employee.a', { leaveTypeId: types.ANNUAL, startDate: addDays(from, 4), endDate: addDays(from, 5) })).status).toBe(409);

    // The employee cannot approve; HR cannot skip the manager step.
    expect((await s['hr.a']!.get('/workflow/tasks')).body.some((i: { subjectId: string }) => i.subjectId === r.body.id)).toBe(false);
    await approveAll(r.body.id);
    expect(await balance('ANNUAL')).toMatchObject({ balance: 5, pending: 0, available: 5 });
    const ledger = await s['employee.a']!.get(`/leave/employees/${emp}/ledger?leaveTypeId=${types.ANNUAL}`);
    expect(ledger.body).toContainEqual(expect.objectContaining({ kind: 'usage', amount: -5, sourceId: r.body.id }));
  });

  it('approved leave turns possible absences into leave days (LEV-07)', async () => {
    const d1 = addDays(today, -3);
    const d2 = addDays(today, -2);
    await env.app.get(AttendanceService).dailyRecompute(3);
    const before = await s['hr.a']!.get(`/attendance/review?companyId=${A}&from=${d1}&to=${d2}`);
    expect(before.body.some((x: { employeeId: string; status: string }) => x.employeeId === emp && x.status === 'absent_pending')).toBe(true);

    const r = await ask('employee.a', { leaveTypeId: types.ANNUAL, startDate: d1, endDate: d2 });
    expect(r.status, r.text).toBe(201);
    await approveAll(r.body.id);
    const days = await s['employee.a']!.get(`/attendance/employees/${emp}/days?from=${d1}&to=${d2}`);
    for (const d of days.body) expect(d).toMatchObject({ status: 'excused', flags: ['on_leave'] });
    const after = await s['hr.a']!.get(`/attendance/review?companyId=${A}&from=${d1}&to=${d2}`);
    expect(after.body.some((x: { employeeId: string }) => x.employeeId === emp)).toBe(false);
    expect(await balance('ANNUAL')).toMatchObject({ balance: 3 });
  });

  it('only HR cancels approved leave; it is refunded and the absence comes back (LEV-06)', async () => {
    const list = await s['employee.a']!.get(`/leave/employees/${emp}/requests`);
    const past = list.body.find((x: { startDate: string }) => x.startDate === addDays(today, -3));
    expect((await s['employee.a']!.post(`/leave/requests/${past.id}/cancel`, { reason: 'Changed my mind' })).status).toBe(403);
    const r = await s['hr.a']!.post(`/leave/requests/${past.id}/cancel`, { reason: 'Was at work after all' });
    expect(r.status, r.text).toBe(201);
    expect(r.body).toMatchObject({ status: 'cancelled', cancelReason: 'Was at work after all' });
    expect(await balance('ANNUAL')).toMatchObject({ balance: 5 });
    const days = await s['hr.a']!.get(`/attendance/employees/${emp}/days?from=${addDays(today, -3)}&to=${addDays(today, -3)}`);
    expect(days.body[0].status).toBe('absent_pending');
  });

  it('deduct-on-submission types refund on rejection and on cancellation', async () => {
    const rules = { ...(await s['admin']!.get('/leave/types')).body.find((t: { code: string }) => t.code === 'ANNUAL').rules, entitlementDays: 5, deductWhen: 'submission' };
    const t = await s['admin']!.post('/leave/types', { companyId: null, code: 'TRAIN', nameAr: 'إجازة تدريب', nameEn: 'Training leave', paid: true, rules });
    expect(t.status, t.text).toBe(201);
    const from = addDays(today, 60);
    const r = await ask('employee.a', { leaveTypeId: t.body.id, startDate: from, endDate: addDays(from, 1) });
    expect(r.status, r.text).toBe(201);
    expect(await balance('TRAIN')).toMatchObject({ balance: 3, pending: 0, available: 3 });
    expect((await decide('sales.manager', r.body.id, 'reject')).status).toBe(201);
    expect(await balance('TRAIN')).toMatchObject({ balance: 5 });

    const again = await ask('employee.a', { leaveTypeId: t.body.id, startDate: from, endDate: from });
    expect(await balance('TRAIN')).toMatchObject({ balance: 4 });
    const c = await s['employee.a']!.post(`/leave/requests/${again.body.id}/cancel`, { reason: 'Course moved' });
    expect(c.body.status).toBe('cancelled');
    expect(await balance('TRAIN')).toMatchObject({ balance: 5 });
  });

  it('HR may record leave for an employee (even retroactively); another HR approves it', async () => {
    const old = addDays(today, -30);
    expect((await ask('employee.a', { leaveTypeId: types.UNPAID, startDate: old, endDate: old })).status).toBe(400);
    const r = await ask('hr.a', { employeeId: emp, leaveTypeId: types.UNPAID, startDate: old, endDate: addDays(old, 1), reason: 'Recorded late' });
    expect(r.status, r.text).toBe(201);
    expect((await s['hr.a']!.get('/workflow/tasks')).body.some((i: { subjectId: string }) => i.subjectId === r.body.id)).toBe(false);
    await approveAll(r.body.id, 'time.a');
    expect((await s['hr.b']!.post('/leave/requests', { employeeId: emp, leaveTypeId: types.UNPAID, startDate: today, endDate: today })).status).toBe(404);
  });

  it('sick-leave attachments are medical: approvers see the decision, not the file (C-12)', async () => {
    const d = addDays(today, 40);
    const r = await s['employee.a']!.agent
      .post(`${API}/leave/requests`)
      .set('x-csrf-token', s['employee.a']!.csrf)
      .field('leaveTypeId', types.SICK!)
      .field('startDate', d)
      .field('endDate', d)
      .attach('file', PDF, 'sick-note.pdf');
    expect(r.status, r.text).toBe(201);
    expect(r.body).toMatchObject({ hasAttachment: true, attachmentId: null });
    for (const who of ['sales.manager', 'hr.a']) {
      const seen = await s[who]!.get(`/leave/requests/${r.body.id}`);
      expect(seen.status, `${who} ${seen.text}`).toBe(200);
      expect(seen.body).toMatchObject({ hasAttachment: true, attachmentId: null });
    }
    const docs = await s['hr.a']!.get(`/employees/${emp}/documents`);
    expect(docs.body.some((x: { title: string }) => x.title.startsWith('Sick leave'))).toBe(false);
    const unpaid = await s['employee.a']!.agent
      .post(`${API}/leave/requests`)
      .set('x-csrf-token', s['employee.a']!.csrf)
      .field('leaveTypeId', types.UNPAID!)
      .field('startDate', addDays(d, 5))
      .field('endDate', addDays(d, 5))
      .attach('file', PDF, 'x.pdf');
    expect(unpaid.status).toBe(400);
  });

  it('an approved in-day permission removes the lateness it covers (LEV-05)', async () => {
    const y = addDays(today, -1);
    const fix = await s['hr.a']!.post('/attendance/corrections', { employeeId: emp, workDate: y, add: [{ kind: 'in', time: '10:00' }, { kind: 'out', time: '16:00' }], reason: 'Card reader fault' });
    expect(fix.status, fix.text).toBe(201);
    const day = async () => (await s['employee.a']!.get(`/attendance/employees/${emp}/days?from=${y}&to=${y}`)).body[0];
    expect((await day()).lateMinutes).toBe(120);

    expect((await s['employee.a']!.post('/leave/permissions', { date: y, startTime: '07:00', endTime: '08:30', reason: 'Doctor' })).status).toBe(400);
    expect((await s['employee.a']!.post('/leave/permissions', { date: y, startTime: '08:00', endTime: '13:00', reason: 'Doctor' })).status).toBe(400);
    const p = await s['employee.a']!.post('/leave/permissions', { date: y, startTime: '08:00', endTime: '10:00', reason: 'Doctor appointment' });
    expect(p.status, p.text).toBe(201);
    expect(p.body).toMatchObject({ status: 'pending', minutes: 120 });
    expect((await s['employee.a']!.post('/leave/permissions', { date: y, startTime: '09:00', endTime: '09:30', reason: 'Overlap' })).status).toBe(409);
    await approveAll(p.body.id);
    expect(await day()).toMatchObject({ lateMinutes: 0, flags: expect.arrayContaining(['permission']) });
  });

  it('scope: other companies cannot see balances or requests', async () => {
    expect((await s['hr.b']!.get(`/leave/employees/${emp}/balances`)).status).toBe(404);
    expect((await s['hr.b']!.get(`/leave/requests?companyId=${A}&from=${addDays(today, -60)}&to=${addDays(today, 90)}`)).status).toBe(404);
    const list = await s['manager.a']!.get(`/leave/requests?companyId=${A}&from=${addDays(today, -60)}&to=${addDays(today, 90)}`);
    expect(list.status, list.text).toBe(200);
    expect(list.body.length).toBeGreaterThan(2);
  });

  it('the accrual job is idempotent and the ledger is append-only', async () => {
    const svc = env.app.get(LeaveService);
    await svc.dailyAccrual();
    expect(await svc.dailyAccrual()).toBe(0);
    await expect(env.database.owner.exec(`update leave_ledger set amount = 99`)).rejects.toThrow(/append-only/);
    await expect(env.database.owner.exec(`delete from leave_ledger`)).rejects.toThrow(/append-only/);
  });

  it('the leave chain stays locked', async () => {
    const defs = await s['admin']!.get('/workflow/definitions');
    const leave = defs.body.find((d: { key: string }) => d.key === 'leave.standard');
    // Editing is refused for locked routes (covered in workflow.test.ts).
    expect(leave.locked).toBe(true);
  });
});
