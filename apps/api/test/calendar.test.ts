import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, type Session, type TestEnv } from './helpers.js';
import { isoWeekday } from '../src/calendar/calendar.service.js';

const week = (start: string, end: string, breaks: { startTime: string; endTime: string }[] = []) =>
  [1, 2, 3, 4, 5, 6, 7].map((d) => ({
    isoWeekday: d,
    isWorkday: d <= 5,
    startTime: d <= 5 ? start : null,
    endTime: d <= 5 ? end : null,
    breaks: d <= 5 ? breaks.map((b) => ({ ...b, paid: false })) : [],
  }));

/** Monday of the ISO week containing the given date. */
function monday(date = new Date()): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - (isoWeekday(d.toISOString().slice(0, 10)) - 1));
  return d.toISOString().slice(0, 10);
}
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

describe('work schedules & holidays (SCH-01..04)', () => {
  let env: TestEnv;
  const s: Record<string, Session> = {};
  let A: string, B: string, sales: string, emp: string;
  let companySched: string, salesSched: string;
  const mon = monday();

  beforeAll(async () => {
    env = await setup();
    A = env.seeded.companies['DEMO-A']!;
    B = env.seeded.companies['DEMO-B']!;
    sales = env.seeded.departments['DEMO-A/SALES']!;
    emp = env.seeded.employees['employee.a']!;
    for (const u of ['admin', 'hr.a', 'hr.b', 'employee.a', 'time.a', 'manager.a']) s[u] = await env.login(u);
  });
  afterAll(async () => env.close());

  it('creates schedules with breaks, validating the week', async () => {
    const bad = await s['hr.a']!.post('/schedules', {
      companyId: A, code: 'BAD', nameAr: 'س', nameEn: 'Bad', graceInMinutes: 10, graceOutMinutes: 0, days: week('09:00', '09:00'),
    });
    expect(bad.status).toBe(400);
    const r = await s['hr.a']!.post('/schedules', {
      companyId: A, code: 'STD', nameAr: 'الدوام الرسمي', nameEn: 'Standard', graceInMinutes: 10, graceOutMinutes: 5,
      days: week('08:00', '16:00', [{ startTime: '12:00', endTime: '12:30' }]),
    });
    expect(r.status, r.text).toBe(201);
    companySched = r.body.id;
    const sales2 = await s['time.a']!.post('/schedules', {
      companyId: A, code: 'SALES', nameAr: 'المبيعات', nameEn: 'Sales', graceInMinutes: 0, graceOutMinutes: 0,
      days: week('10:00', '18:00'),
    });
    expect(sales2.status).toBe(201);
    salesSched = sales2.body.id;
  });

  it('group-wide schedules and holidays need group scope; other companies are refused', async () => {
    const g = await s['hr.a']!.post('/schedules', {
      code: 'GRP', nameAr: 'س', nameEn: 'G', graceInMinutes: 0, graceOutMinutes: 0, days: week('08:00', '16:00'),
    });
    expect(g.status).toBe(403);
    expect((await s['hr.b']!.post('/schedule-assignments', { scheduleId: companySched, targetType: 'company', companyId: A, validFrom: mon })).status).toBe(403);
    const bList = await s['hr.b']!.get('/schedules');
    expect(bList.body.map((x: { id: string }) => x.id)).not.toContain(companySched);
    expect((await s['hr.a']!.post('/holidays', { date: `${mon.slice(0, 4)}-12-25`, nameAr: 'ع', nameEn: 'X' })).status).toBe(403);
  });

  it('resolves employee > department > company, with holidays and rest days', async () => {
    expect((await s['hr.a']!.post('/schedule-assignments', { scheduleId: companySched, targetType: 'company', companyId: A, validFrom: addDays(mon, -30) })).status).toBe(201);
    // Wednesday is a group holiday; Thursday a company-B-only holiday (must not affect A).
    expect((await s['admin']!.post('/holidays', { date: addDays(mon, 2), nameAr: 'عطلة', nameEn: 'Holiday' })).status).toBe(201);
    expect((await s['hr.b']!.post('/holidays', { companyId: B, date: addDays(mon, 3), nameAr: 'محلية', nameEn: 'Local' })).status).toBe(201);

    const days = await s['hr.a']!.get(`/employees/${emp}/workdays?from=${mon}&to=${addDays(mon, 6)}`);
    expect(days.status, days.text).toBe(200);
    const [m, , w, th, , sat] = days.body;
    expect(m).toMatchObject({ isWorkday: true, startTime: '08:00', endTime: '16:00', graceInMinutes: 10 });
    expect(m.breaks).toEqual([{ startTime: '12:00', endTime: '12:30', paid: false }]);
    expect(w.isWorkday).toBe(false);
    expect(w.holiday.nameEn).toBe('Holiday');
    expect(th.isWorkday).toBe(true);
    expect(th.holiday).toBeNull();
    expect(sat.isWorkday).toBe(false);

    // Department assignment overrides the company default from Tuesday.
    expect((await s['hr.a']!.post('/schedule-assignments', { scheduleId: salesSched, targetType: 'department', companyId: A, departmentId: env.seeded.departments['DEMO-A/SALES'], validFrom: addDays(mon, 1) })).status).toBe(201);
    const after = await s['hr.a']!.get(`/employees/${emp}/workdays?from=${mon}&to=${addDays(mon, 1)}`);
    expect(after.body[0].startTime).toBe('08:00');
    expect(after.body[1].startTime).toBe('10:00');
    void sales;
  });

  it('a new assignment closes the previous one (history kept)', async () => {
    const r = await s['hr.a']!.post('/schedule-assignments', { scheduleId: salesSched, targetType: 'company', companyId: A, validFrom: addDays(mon, 14) });
    expect(r.status).toBe(201);
    const list = await s['hr.a']!.get(`/schedule-assignments?companyId=${A}`);
    const company = list.body.filter((x: { targetType: string }) => x.targetType === 'company');
    expect(company).toHaveLength(2);
    expect(company.find((x: { scheduleId: string }) => x.scheduleId === companySched).validTo).toBe(addDays(mon, 13));
    const overlap = await env.database.owner
      .exec(`insert into schedule_assignment (id, schedule_id, target_type, company_id, valid_from)
             values (gen_random_uuid(), '${companySched}', 'company', '${A}', '${addDays(mon, 20)}')`)
      .then(() => 'inserted', (e: Error) => e.message);
    expect(overlap).toMatch(/schedule_assignment_no_overlap|conflicting key|exclusion/i);
  });

  it('employees see their own working days; others cannot', async () => {
    expect((await s['employee.a']!.get(`/employees/${emp}/workdays?from=${mon}&to=${addDays(mon, 2)}`)).status).toBe(200);
    expect((await s['employee.a']!.get(`/employees/${env.seeded.employees['emp.fin']}/workdays?from=${mon}&to=${mon}`)).status).toBe(404);
    expect((await s['hr.b']!.get(`/employees/${emp}/workdays?from=${mon}&to=${mon}`)).status).toBe(404);
    const holidays = await s['employee.a']!.get(`/holidays?year=${mon.slice(0, 4)}&companyId=${A}`);
    expect(holidays.body.map((h: { nameEn: string }) => h.nameEn)).toEqual(expect.arrayContaining(['Holiday']));
    expect(holidays.body.map((h: { nameEn: string }) => h.nameEn)).not.toContain('Local');
  });
});
