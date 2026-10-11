import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API, setup, type Session, type TestEnv } from './helpers.js';
import { addDays } from '../src/attendance/time.js';

const PDF = Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\ntrailer << >>\n%%EOF\n');

describe('recruitment (REC-01..07)', () => {
  let env: TestEnv;
  const s: Record<string, Session> = {};
  let A: string;
  let cvCategory: string;
  let medicalCategory: string;
  let vacancyId: string;
  let candidateId: string;
  let appId: string;
  const today = new Date().toISOString().slice(0, 10);

  const uploadCv = (who: string, cid: string, categoryId: string) =>
    s[who]!.agent
      .post(`${API}/recruitment/candidates/${cid}/files`)
      .set('x-csrf-token', s[who]!.csrf)
      .field('categoryId', categoryId)
      .field('title', 'CV')
      .attach('file', PDF, 'cv.pdf');

  beforeAll(async () => {
    env = await setup();
    A = env.seeded.companies['DEMO-A']!;
    for (const u of ['admin', 'hr.a', 'hr.b', 'manager.a', 'sales.manager', 'employee.a']) s[u] = await env.login(u);
    const cats = (await s['hr.a']!.get('/document-categories')).body as { id: string; code: string }[];
    cvCategory = cats.find((c) => c.code === 'cv')!.id;
    medicalCategory = cats.find((c) => c.code === 'medical')!.id;
  });
  afterAll(async () => env.close());

  it('vacancies per company with required documents chosen per vacancy (REC-01, REC-07)', async () => {
    const body = { companyId: A, title: 'Sales representative', description: 'Field sales', openings: 1, requiredDocumentCategoryIds: [cvCategory] };
    expect((await s['hr.b']!.post('/recruitment/vacancies', body)).status).toBe(403);
    const r = await s['hr.a']!.post('/recruitment/vacancies', body);
    expect(r.status, r.text).toBe(201);
    vacancyId = r.body.id;
    expect(r.body.status).toBe('draft');
    const open = await s['hr.a']!.patch(`/recruitment/vacancies/${vacancyId}`, { ...body, companyId: undefined, status: 'open' });
    expect(open.body.status).toBe('open');
    expect((await s['employee.a']!.get(`/recruitment/vacancies?companyId=${A}`)).status).toBe(404);
    expect((await s['hr.b']!.get(`/recruitment/vacancies/${vacancyId}`)).status).toBe(404);
  });

  it('candidates with files; medical files are refused; duplicates by e-mail (REC-02)', async () => {
    const r = await s['hr.a']!.post('/recruitment/candidates', { companyId: A, fullNameAr: 'ريم سالم', fullNameEn: 'Reem Salem', email: 'reem@example.com', nationality: 'JO', source: 'referral' });
    expect(r.status, r.text).toBe(201);
    candidateId = r.body.id;
    expect(r.body.retainUntil > today).toBe(true);
    expect((await s['hr.a']!.post('/recruitment/candidates', { companyId: A, fullNameAr: 'x', fullNameEn: 'x', email: 'REEM@example.com', source: 'direct' })).status).toBe(409);
    expect((await uploadCv('hr.a', candidateId, medicalCategory)).status).toBe(403);
    expect((await uploadCv('hr.b', candidateId, cvCategory)).status).toBe(404);
  });

  it('applications move through the configured stages with a history; required documents are tracked (REC-03, REC-04)', async () => {
    const r = await s['hr.a']!.post('/recruitment/applications', { vacancyId, candidateId });
    expect(r.status, r.text).toBe(201);
    appId = r.body.id;
    expect(r.body).toMatchObject({ stage: 'new', outcome: 'open', missingDocumentCategoryIds: [cvCategory] });
    expect((await s['hr.a']!.post('/recruitment/applications', { vacancyId, candidateId })).status).toBe(409);
    const up = await uploadCv('hr.a', candidateId, cvCategory);
    expect(up.status, up.text).toBe(201);
    const after = await s['hr.a']!.get(`/recruitment/applications/${appId}`);
    expect(after.body.missingDocumentCategoryIds).toEqual([]);
    expect(after.body.documents).toHaveLength(1);
    expect((await s['hr.a']!.post(`/recruitment/applications/${appId}/stage`, { stage: 'unknown_stage' })).status).toBe(400);
    expect((await s['hr.a']!.post(`/recruitment/applications/${appId}/stage`, { stage: 'interview', note: 'Strong CV' })).body.stage).toBe('interview');
    await s['hr.a']!.post(`/recruitment/applications/${appId}/notes`, { note: 'Internal: salary expectation 4k' });
    const bad = await s['admin']!.put('/settings/recruitment.stages', { value: { stages: [{ key: 'new', nameAr: 'ج', nameEn: 'New', outcome: 'open' }, { key: 'ok', nameAr: 'م', nameEn: 'OK', outcome: 'accepted' }, { key: 'x', nameAr: 'x', nameEn: 'x', outcome: 'open' }, { key: 'y', nameAr: 'y', nameEn: 'y', outcome: 'open' }], retentionMonths: 12 } });
    expect(bad.status).toBe(400);
  });

  it('interviewers see what they interview for (without internal notes) and record results', async () => {
    const userId = (await s['sales.manager']!.get('/auth/session')).body.user.id;
    expect((await s['sales.manager']!.get(`/recruitment/applications/${appId}`)).status).toBe(404);
    const r = await s['hr.a']!.post(`/recruitment/applications/${appId}/interviews`, { scheduledAt: `${addDays(today, 2)}T09:00:00Z`, durationMinutes: 45, mode: 'video', interviewerUserIds: [userId] });
    expect(r.status, r.text).toBe(201);
    const seen = await s['sales.manager']!.get(`/recruitment/applications/${appId}`);
    expect(seen.status).toBe(200);
    expect(seen.body.events.some((e: { kind: string }) => e.kind === 'note')).toBe(false);
    expect(seen.body.offers).toEqual([]);
    const res = await s['sales.manager']!.post(`/recruitment/interviews/${r.body.interviews[0].id}/result`, { result: 'pass', score: 4, feedback: 'Good communication' });
    expect(res.body.interviews[0]).toMatchObject({ status: 'done', result: 'pass', score: 4 });
    expect((await s['hr.b']!.get(`/recruitment/applications/${appId}`)).status).toBe(404);
  });

  it('offers: salary only for the offers permission; approval; accepted (REC-05)', async () => {
    const r = await s['hr.a']!.post(`/recruitment/applications/${appId}/offers`, { baseSalary: '4000', currency: 'EUR', startDate: addDays(today, 30) });
    expect(r.status, r.text).toBe(201);
    const offer = r.body.offers[0];
    expect(offer).toMatchObject({ status: 'draft', baseSalary: 4000 });
    expect((await s['manager.a']!.get(`/recruitment/applications/${appId}`)).body.offers[0].baseSalary).toBeNull();
    const sub = await s['hr.a']!.post(`/recruitment/offers/${offer.id}/submit`);
    expect(sub.body.offers[0].status).toBe('pending_approval');
    const tasks = await s['manager.a']!.get('/workflow/tasks');
    const inst = tasks.body.find((i: { subjectId: string }) => i.subjectId === offer.id);
    await s['manager.a']!.post(`/workflow/tasks/${inst.tasks.find((t: { status: string }) => t.status === 'pending').id}/decision`, { decision: 'approve' });
    expect((await s['hr.a']!.post(`/recruitment/offers/${offer.id}/status`, { status: 'accepted' })).status).toBe(409);
    await s['hr.a']!.post(`/recruitment/offers/${offer.id}/status`, { status: 'sent' });
    const acc = await s['hr.a']!.post(`/recruitment/offers/${offer.id}/status`, { status: 'accepted' });
    expect(acc.body.offers[0].status).toBe('accepted');
  });

  it('hiring converts the candidate once, with the offer salary and the files (REC-06)', async () => {
    expect((await s['hr.a']!.post(`/recruitment/applications/${appId}/convert`, { hireDate: addDays(today, 30) })).status).toBe(409);
    await s['hr.a']!.post(`/recruitment/applications/${appId}/stage`, { stage: 'accepted' });
    const r = await s['hr.a']!.post(`/recruitment/applications/${appId}/convert`, { hireDate: addDays(today, 30) });
    expect(r.status, r.text).toBe(201);
    const empId = r.body.employeeId as string;
    expect(empId).toBeTruthy();
    const e = await s['hr.a']!.get(`/employees/${empId}`);
    expect(e.body).toMatchObject({ fullNameEn: 'Reem Salem', nationality: 'JO', hireDate: addDays(today, 30) });
    const docs = await s['hr.a']!.get(`/employees/${empId}/documents`);
    expect(docs.body.some((d: { title: string }) => d.title === 'CV')).toBe(true);
    const comp = await s['hr.a']!.get(`/employees/${empId}/history`);
    expect(Number(comp.body.compensation?.[0]?.baseSalary)).toBe(4000);
    expect(comp.body.compensation?.[0]?.currency).toBe('EUR');
    expect((await s['hr.a']!.post(`/recruitment/applications/${appId}/convert`, { hireDate: addDays(today, 30) })).status).toBe(409);
    expect((await s['hr.a']!.post(`/recruitment/applications/${appId}/stage`, { stage: 'rejected' })).status).toBe(409);
    expect((await s['hr.a']!.get(`/recruitment/vacancies/${vacancyId}`)).body).toMatchObject({ status: 'filled', hired: 1 });
  });
});
