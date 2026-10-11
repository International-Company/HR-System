import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATASETS } from '@hrms/shared';
import { API, setup, type Session, type TestEnv } from './helpers.js';
import { ReportsService, safeCell } from '../src/reports/reports.service.js';

const binary = (res: { on: (e: string, cb: (c?: Buffer) => void) => void }, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c?: Buffer) => chunks.push(c!));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

describe('reports, search and dashboards (RPT, SRCH, DASH)', () => {
  let env: TestEnv;
  const s: Record<string, Session> = {};
  let A: string;
  let B: string;
  const today = new Date().toISOString().slice(0, 10);
  const run = (who: string, dataset: string, fields: string[], filters: Record<string, unknown> = {}) => s[who]!.post('/reports/run', { dataset, fields, filters: { companyId: A, ...filters } });

  beforeAll(async () => {
    env = await setup();
    A = env.seeded.companies['DEMO-A']!;
    B = env.seeded.companies['DEMO-B']!;
    for (const u of ['admin', 'hr.a', 'hr.b', 'employee.a', 'sales.manager', 'manager.a', 'finance.a']) s[u] = await env.login(u);
  });
  afterAll(async () => env.close());

  it('the catalogue offers only fields the user may see (C-10)', async () => {
    const hr = await s['hr.a']!.get(`/reports/datasets?companyId=${A}`);
    const hrEmp = hr.body.find((d: { key: string }) => d.key === 'employees');
    expect(hrEmp.fields.map((f: { key: string }) => f.key)).toContain('baseSalary');
    const mgr = await s['manager.a']!.get(`/reports/datasets?companyId=${A}`);
    expect(mgr.body.find((d: { key: string }) => d.key === 'employees').fields.map((f: { key: string }) => f.key)).not.toContain('baseSalary');
    expect(mgr.body.some((d: { key: string }) => d.key === 'payroll')).toBe(true); // company managers may view payroll runs
    expect((await s['employee.a']!.get('/reports/datasets')).status).toBe(403);
  });

  it('runs respect company scope (NEG-04), departments, and strip hidden fields', async () => {
    const r = await run('hr.a', 'employees', ['employeeNo', 'nameEn', 'baseSalary', 'status']);
    expect(r.status, r.text).toBe(200);
    expect(r.body.rows).toHaveLength(3);
    expect(r.body.rows.find((x: { nameEn: string }) => x.nameEn === 'Sara Al-Hassan').baseSalary).toBe(3100);
    expect((await run('hr.a', 'employees', ['nameEn'], { companyId: B })).status).toBe(403);
    const mgr = await run('manager.a', 'employees', ['nameEn', 'baseSalary']);
    expect(mgr.body.columns.map((c: { key: string }) => c.key)).toEqual(['nameEn']);
    const dept = await run('sales.manager', 'employees', ['nameEn', 'department']);
    expect(dept.status, dept.text).toBe(200);
    expect(dept.body.rows.map((x: { nameEn: string }) => x.nameEn).sort()).toEqual(['Khalid Al-Omari', 'Sara Al-Hassan']);
    expect((await run('employee.a', 'employees', ['nameEn'])).status).toBe(403);
  });

  it('every dataset runs (RPT-04)', async () => {
    for (const d of DATASETS) {
      const who = d.permission.startsWith('payroll.') ? 'finance.a' : 'hr.a';
      const r = await run(who, d.key, d.fields.map((f) => f.key), d.filters.includes('month') ? { month: today.slice(0, 7) } : {});
      expect(r.status, `${d.key}: ${r.text}`).toBe(200);
    }
    const turnover = await run('hr.a', 'turnover', ['headcountEnd', 'turnoverRate']);
    expect(turnover.body.rows[0].headcountEnd).toBe(3);
  });

  it('exports are real spreadsheets, audited, and safe from formula injection (RPT-02)', async () => {
    const res = await s['hr.a']!.agent
      .post(`${API}/reports/export?format=xlsx`)
      .set('x-csrf-token', s['hr.a']!.csrf)
      .send({ dataset: 'employees', fields: ['employeeNo', 'nameAr'], filters: { companyId: A } })
      .buffer(true)
      .parse(binary);
    expect(res.status).toBe(201);
    expect((res.body as Buffer).subarray(0, 2).toString()).toBe('PK');
    const audit = await s['admin']!.get('/audit-events?action=reports.exported');
    expect(audit.body.items.length).toBeGreaterThan(0);

    expect(safeCell('=HYPERLINK("http://x")')).toBe(`'=HYPERLINK("http://x")`);
    expect(safeCell('+1')).toBe("'+1");
    expect(safeCell(-5)).toBe(-5);
    await s['hr.a']!.post('/recruitment/candidates', { companyId: A, fullNameAr: '=cmd|calc', fullNameEn: '=cmd|calc', source: 'direct' });
    const vac = await s['hr.a']!.post('/recruitment/vacancies', { companyId: A, title: 'Clerk', openings: 1 });
    await s['hr.a']!.patch(`/recruitment/vacancies/${vac.body.id}`, { title: 'Clerk', openings: 1, status: 'open', description: '', requiredDocumentCategoryIds: [] });
    const cands = await s['hr.a']!.get(`/recruitment/candidates?companyId=${A}`);
    await s['hr.a']!.post('/recruitment/applications', { vacancyId: vac.body.id, candidateId: cands.body[0].id });
    const csv = await s['hr.a']!.agent.post(`${API}/reports/export?format=csv`).set('x-csrf-token', s['hr.a']!.csrf).send({ dataset: 'recruitment', fields: ['candidate'], filters: { companyId: A } }).buffer(true).parse(binary);
    const text = (csv.body as Buffer).toString('utf8');
    expect(text).toContain("'=cmd|calc");
    expect(text).not.toMatch(/(^|\n)=cmd/);
    expect((await s['employee.a']!.post('/reports/export', { dataset: 'employees', fields: ['nameEn'], filters: { companyId: A } })).status).toBe(403);
  });

  it('scheduled reports are delivered to the owner in the app (RPT-03, C-03)', async () => {
    const saved = await s['hr.a']!.post('/reports/saved', { name: 'Daily headcount', dataset: 'employees', fields: ['employeeNo', 'nameEn'], filters: { companyId: A }, schedule: { frequency: 'daily', hour: 0 } });
    expect(saved.status, saved.text).toBe(201);
    const svc = env.app.get(ReportsService);
    expect(await svc.runSchedules()).toBe(1);
    expect(await svc.runSchedules()).toBe(0); // once a day
    const outputs = await s['hr.a']!.get('/reports/outputs');
    expect(outputs.body).toHaveLength(1);
    expect(outputs.body[0].rowCount).toBe(3);
    const notes = await s['hr.a']!.get('/notifications');
    expect(notes.body.some((n: { eventType: string }) => n.eventType === 'reports.delivered')).toBe(true);
    expect((await s['hr.b']!.get(`/reports/outputs/${outputs.body[0].id}`)).status).toBe(404);
    expect((await s['hr.b']!.get('/reports/saved')).body).toEqual([]);
  });

  it('global search stays inside the user’s scope (SRCH-02, NEG-11)', async () => {
    const mine = await s['hr.a']!.get(`/search?q=${encodeURIComponent('سارة')}`);
    expect(mine.body.some((r: { kind: string; title: string }) => r.kind === 'employee')).toBe(true);
    const other = await s['hr.b']!.get(`/search?q=${encodeURIComponent('سارة')}`);
    expect(other.body).toEqual([]);
    expect((await s['employee.a']!.get(`/search?q=${encodeURIComponent('محمد')}`)).body).toEqual([]);
  });

  it('dashboards show the widgets of the user’s roles, within scope (DASH-01, DASH-02)', async () => {
    const emp = await s['employee.a']!.get('/dashboard');
    expect(emp.body.map((w: { widget: string }) => w.widget)).toEqual(expect.arrayContaining(['my_tasks', 'my_leave']));
    expect(emp.body.some((w: { widget: string }) => w.widget === 'headcount')).toBe(false);
    const hr = await s['hr.a']!.get('/dashboard');
    const head = hr.body.find((w: { widget: string }) => w.widget === 'headcount');
    expect(head.data.companies).toEqual([expect.objectContaining({ count: 3 })]);
    const admin = await s['admin']!.get('/dashboard');
    expect(admin.body.some((w: { widget: string }) => w.widget === 'system_health')).toBe(true);
    // The administrator configures layouts per role.
    const set = await s['admin']!.put('/settings/dashboard.layouts', { value: { roles: { employee: [{ widget: 'my_leave', size: 'large' }] } } });
    expect(set.status).toBe(204);
    expect((await s['employee.a']!.get('/dashboard')).body.map((w: { widget: string }) => w.widget)).toEqual(['my_leave']);
  });
});
