import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { API, setup, type Session, type TestEnv } from './helpers.js';
import { ContractsService } from '../src/contracts/contracts.service.js';
import { renderContract } from '../src/contracts/render.js';
import { addDays } from '../src/attendance/time.js';
import { contract, lookupValue } from '../src/db/schema.js';

const PDF = Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\ntrailer << >>\n%%EOF\n');
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

describe('contract rendering (CON-01, CON-02)', () => {
  const base = { values: { 'employee.nameEn': 'Sara', 'contract.number': 'CTR-1' }, fields: {}, fieldDefs: [], clauses: {} };

  it('fills values, fields and clauses; clauses cannot nest', () => {
    const r = renderContract({
      ...base,
      template: '# Contract {{contract.number}}\n\nDear {{ employee.nameEn }}, role: {{field.role}}.\n\n\n\n{{clause.CONF}}',
      fields: { role: 'Sales' },
      fieldDefs: [{ key: 'role', required: true }],
      clauses: { CONF: 'Confidential for {{employee.nameEn}}. {{clause.CONF}}' },
    });
    expect(r.text).toBe('# Contract CTR-1\n\nDear Sara, role: Sales.\n\nConfidential for Sara. {{clause.CONF}}');
    expect(r.missing).toEqual(['clause.CONF']);
  });

  it('reports missing required fields and unknown names', () => {
    const r = renderContract({ ...base, template: '{{field.role}} {{field.note}} {{salary.base}}', fieldDefs: [{ key: 'role', required: true }, { key: 'note', required: false }] });
    expect(r.missing).toEqual(['field.role', 'salary.base']);
  });
});

describe('contracts (CON-01..11)', () => {
  let env: TestEnv;
  const s: Record<string, Session> = {};
  let emp: string;
  let fin: string;
  let fixedTerm: string;
  let templateId: string;
  let contractId: string;
  const today = new Date().toISOString().slice(0, 10);

  const get = async (who: string, id: string) => (await s[who]!.get(`/contracts/${id}`)).body;
  const signAll = async (id: string, who: string[]) => {
    for (const u of who) {
      const c = await get(u, id);
      const v = c.versions.find((x: { status: string }) => x.status === 'awaiting_signature');
      const sig = v.signatures.find((x: { canSign: boolean }) => x.canSign);
      expect(sig, `${u} has nothing to sign`).toBeTruthy();
      const r = await s[u]!.post(`/contracts/signatures/${sig.id}/sign`, { documentHash: sha(v.body), typedName: `Signed by ${u}`, consent: true });
      expect(r.status, r.text).toBe(201);
    }
  };
  const latest = (c: { versions: unknown[] }) => c.versions.at(-1) as { id: string; status: string; body: string; kind: string };

  beforeAll(async () => {
    env = await setup();
    emp = env.seeded.employees['employee.a']!;
    fin = env.seeded.employees['emp.fin']!;
    for (const u of ['admin', 'hr.a', 'hr.b', 'employee.a', 'manager.a', 'sales.manager']) s[u] = await env.login(u);
    const [t] = await env.database.system((tx) => tx.select().from(lookupValue).where(and(eq(lookupValue.kind, 'contract_type'), eq(lookupValue.code, 'fixed_term'))));
    fixedTerm = t!.id;
  });
  afterAll(async () => env.close());

  it('templates use known placeholders, reusable clauses and fields', async () => {
    const clause = await s['admin']!.post('/contracts/clauses', { companyId: null, code: 'CONF', title: 'السرية', language: 'ar', body: 'يلتزم {{employee.nameAr}} بالمحافظة على أسرار {{company.nameAr}}.' });
    expect(clause.status, clause.text).toBe(201);
    const bad = await s['admin']!.post('/contracts/templates', { companyId: null, contractTypeId: fixedTerm, code: 'BAD', name: 'x', language: 'ar', body: '{{employee.password}}' });
    expect(bad.status).toBe(400);
    expect((await s['hr.a']!.post('/contracts/templates', { companyId: null, contractTypeId: fixedTerm, code: 'X', name: 'x', language: 'ar', body: 'x' })).status).toBe(403);
    const tpl = await s['admin']!.post('/contracts/templates', {
      companyId: null,
      contractTypeId: fixedTerm,
      code: 'FT-AR',
      name: 'عقد محدد المدة',
      language: 'ar',
      body: '# عقد عمل رقم {{contract.number}}\n\nبين {{company.nameAr}} والموظف {{employee.nameAr}} ({{employee.number}}).\n\nالوظيفة: {{field.position}}\n\nيبدأ في {{contract.startDate}} وينتهي في {{contract.endDate}}.\n\nالراتب الأساسي: {{salary.base}} {{salary.currency}}\n\n{{clause.CONF}}',
      fields: [{ key: 'position', label: 'المسمى', required: true }],
    });
    expect(tpl.status, tpl.text).toBe(201);
    templateId = tpl.body.id;
  });

  it('HR prepares a draft from the template with employee and company data (CON-02)', async () => {
    const body = { employeeId: emp, templateId, startDate: today, endDate: addDays(today, 364), probationEnd: addDays(today, 89) };
    const missing = await s['hr.a']!.post('/contracts', body);
    expect(missing.status).toBe(400);
    expect((await s['hr.b']!.post('/contracts', { ...body, fieldValues: { position: 'x' } })).status).toBe(404);
    const r = await s['hr.a']!.post('/contracts', { ...body, fieldValues: { position: 'مندوب مبيعات' } });
    expect(r.status, r.text).toBe(201);
    contractId = r.body.id;
    expect(r.body).toMatchObject({ status: 'draft', contractNo: 'CTR-000001' });
    const text = r.body.versions[0].body as string;
    expect(text).toContain('سارة الحسن');
    expect(text).toContain('CTR-000001');
    expect(text).toContain('3100.00');
    expect(text).toContain('مندوب مبيعات');
    expect(text).toContain('يلتزم سارة الحسن بالمحافظة');
    // Employees never see drafts.
    expect((await s['employee.a']!.get(`/contracts/${contractId}`)).status).toBe(404);
    expect((await s['hr.a']!.post('/contracts', { ...body, fieldValues: { position: 'x' } })).status).toBe(409);
  });

  it('drafts can be edited; then signed in the app by both sides with evidence (CON-03)', async () => {
    const draft = await get('hr.a', contractId);
    const edited = `${draft.versions[0].body}\n\nبند إضافي يدوي.`;
    const up = await s['hr.a']!.put(`/contracts/${contractId}/draft`, { startDate: today, endDate: addDays(today, 364), probationEnd: addDays(today, 89), fieldValues: { position: 'مندوب مبيعات' }, bodyOverride: edited });
    expect(up.status, up.text).toBe(200);
    expect(up.body.versions[0].body).toContain('بند إضافي يدوي');

    const sent = await s['hr.a']!.post(`/contracts/${contractId}/versions/${up.body.versions[0].id}/send`);
    expect(sent.body.status).toBe('awaiting_signature');
    expect((await s['employee.a']!.get('/contracts/to-sign')).body.map((c: { id: string }) => c.id)).toContain(contractId);
    const notes = await s['employee.a']!.get('/notifications');
    expect(notes.body.some((n: { eventType: string }) => n.eventType === 'contracts.to_sign')).toBe(true);

    const mine = await get('employee.a', contractId);
    const v = mine.versions[0];
    const empSig = v.signatures.find((x: { role: string }) => x.role === 'employee');
    const coSig = v.signatures.find((x: { role: string }) => x.role === 'company');
    expect(empSig.canSign).toBe(true);
    expect(coSig.canSign).toBe(false);
    expect((await s['employee.a']!.post(`/contracts/signatures/${coSig.id}/sign`, { documentHash: sha(v.body), typedName: 'Sara', consent: true })).status).toBe(403);
    expect((await s['employee.a']!.post(`/contracts/signatures/${empSig.id}/sign`, { documentHash: sha('other text'), typedName: 'Sara', consent: true })).status).toBe(409);
    await signAll(contractId, ['employee.a']);
    expect((await get('hr.a', contractId)).status).toBe('awaiting_signature');
    await signAll(contractId, ['manager.a']);

    const done = await get('hr.a', contractId);
    expect(done.status).toBe('active');
    expect(done.versions[0]).toMatchObject({ status: 'signed', lockedAt: expect.any(String) });
    expect(done.versions[0].signatures.every((x: { status: string; method: string; ip: string; documentHash: string }) => x.status === 'signed' && x.method === 'in_app' && !!x.ip && x.documentHash === done.versions[0].bodySha256)).toBe(true);
  });

  it('a signed version can never change (CON-06, NEG-08)', async () => {
    expect((await s['hr.a']!.put(`/contracts/${contractId}/draft`, { startDate: today, endDate: null, probationEnd: null, fieldValues: {}, bodyOverride: 'x' })).status).toBe(409);
    await expect(env.database.owner.exec(`update contract_version set body = 'changed' where locked_at is not null`)).rejects.toThrow(/immutable/);
    await expect(env.database.owner.exec(`delete from contract_version`)).rejects.toThrow(/cannot be deleted/);
    await expect(env.database.owner.exec(`update contract_signature set typed_name = 'x'`)).rejects.toThrow(/immutable/);
  });

  it('addenda are new versions; a signed copy can be uploaded instead of signing in the app (CON-05)', async () => {
    const a = await s['hr.a']!.post(`/contracts/${contractId}/addenda`, { templateId: null, effectiveDate: addDays(today, 30), body: 'ملحق: يعدل مكان العمل.' });
    expect(a.status, a.text).toBe(201);
    const v = latest(a.body);
    expect(v).toMatchObject({ kind: 'addendum', status: 'draft' });
    expect((await s['hr.a']!.post(`/contracts/${contractId}/addenda`, { templateId: null, effectiveDate: today, body: 'again' })).status).toBe(409);
    await s['hr.a']!.post(`/contracts/${contractId}/versions/${v.id}/send`);
    const r = await s['hr.a']!.agent
      .post(`${API}/contracts/${contractId}/versions/${v.id}/signed-copy`)
      .set('x-csrf-token', s['hr.a']!.csrf)
      .attach('file', PDF, 'signed.pdf');
    expect(r.status, r.text).toBe(201);
    const signed = latest(r.body) as unknown as { status: string; signedCopyId: string; signatures: { method: string }[] };
    expect(signed.status).toBe('signed');
    expect(signed.signedCopyId).toBeTruthy();
    expect(signed.signatures.every((x) => x.method === 'upload')).toBe(true);
  });

  it('renewal by extension updates the end date once signed (CON-04)', async () => {
    const c = await get('hr.a', contractId);
    const newEnd = addDays(c.endDate, 365);
    const r = await s['hr.a']!.post(`/contracts/${contractId}/renew`, { newEndDate: newEnd });
    expect(r.status, r.text).toBe(201);
    const v = latest(r.body);
    expect(v.kind).toBe('extension');
    await s['hr.a']!.post(`/contracts/${contractId}/versions/${v.id}/send`);
    await signAll(contractId, ['employee.a', 'manager.a']);
    expect((await get('hr.a', contractId)).endDate).toBe(newEnd);
  });

  it('renewal as a new contract links both and marks the old one renewed', async () => {
    expect((await s['admin']!.put(`/contracts/type-policies/${fixedTerm}`, { renewal: 'new_contract', autoRenew: false, autoRenewMonths: 12, signers: ['employee', 'company'], defaultDurationMonths: 12, probationDays: null, retentionYears: 10 })).status).toBe(200);
    const c = await get('hr.a', contractId);
    const r = await s['hr.a']!.post(`/contracts/${contractId}/renew`, { newEndDate: addDays(c.endDate, 365) });
    expect(r.status, r.text).toBe(201);
    expect(r.body).toMatchObject({ renewalOfId: contractId, status: 'draft', startDate: addDays(c.endDate, 1) });
    await s['hr.a']!.post(`/contracts/${r.body.id}/versions/${r.body.versions[0].id}/send`);
    await signAll(r.body.id, ['employee.a', 'manager.a']);
    expect((await get('hr.a', contractId)).status).toBe('renewed');
    expect((await get('hr.a', contractId)).renewedById).toBe(r.body.id);
  });

  it('probation outcome is recorded once (CON-09)', async () => {
    const p = await s['hr.a']!.post(`/contracts/${contractId}/probation`, { outcome: 'confirmed', newProbationEnd: null, note: 'Good start' });
    expect(p.status).toBe(409); // renewed contract is no longer active
  });

  it('daily job: alerts once, expires, and renews automatically only where allowed (CON-04, CON-08)', async () => {
    await s['admin']!.put(`/contracts/type-policies/${fixedTerm}`, { renewal: 'extend', autoRenew: false, autoRenewMonths: 12, signers: ['company'], defaultDurationMonths: 12, probationDays: null, retentionYears: 10 });
    const make = async (start: string, end: string) => {
      const r = await s['hr.a']!.post('/contracts', { employeeId: fin, templateId, startDate: start, endDate: end, probationEnd: null, fieldValues: { position: 'محاسب' } });
      expect(r.status, r.text).toBe(201);
      await s['hr.a']!.post(`/contracts/${r.body.id}/versions/${r.body.versions[0].id}/send`);
      await signAll(r.body.id, ['manager.a']);
      return r.body.id as string;
    };
    const soon = await make(addDays(today, -300), addDays(today, 5));
    const svc = env.app.get(ContractsService);
    const first = await svc.daily();
    expect(first.alerts).toBe(1);
    expect((await svc.daily()).alerts).toBe(0);
    const notes = await s['hr.a']!.get('/notifications');
    expect(notes.body.some((n: { eventType: string }) => n.eventType === 'contracts.expiry')).toBe(true);

    const found = await s['hr.a']!.get('/contracts?expiringWithin=10');
    expect(found.body.map((c: { id: string }) => c.id)).toContain(soon);
    expect((await s['hr.b']!.get('/contracts?expiringWithin=10')).body).toEqual([]);
    expect((await s['hr.a']!.get(`/contracts?q=${encodeURIComponent('محمد')}`)).body.length).toBeGreaterThan(0);

    // Past its end date: expires, unless the type renews automatically.
    await env.database.system((tx) => tx.update(contract).set({ endDate: addDays(today, -1) }).where(eq(contract.id, soon)));
    expect((await svc.daily()).expired).toBe(1);
    expect((await get('hr.a', soon)).status).toBe('expired');

    await s['admin']!.put(`/contracts/type-policies/${fixedTerm}`, { renewal: 'extend', autoRenew: true, autoRenewMonths: 12, signers: ['company'], defaultDurationMonths: 12, probationDays: null, retentionYears: 10 });
    const renewSoon = await s['hr.a']!.post(`/contracts/${soon}/end`, { endDate: today, reason: 'x x x' });
    expect(renewSoon.status).toBe(409); // expired, not active
    const other = await s['hr.a']!.post('/contracts', { employeeId: fin, templateId, startDate: addDays(today, -200), endDate: addDays(today, 100), probationEnd: null, fieldValues: { position: 'محاسب' } });
    await s['hr.a']!.post(`/contracts/${other.body.id}/versions/${other.body.versions[0].id}/send`);
    await signAll(other.body.id, ['manager.a']);
    await env.database.system((tx) => tx.update(contract).set({ endDate: today }).where(eq(contract.id, other.body.id)));
    expect((await svc.daily()).renewed).toBe(1);
    const renewed = await get('hr.a', other.body.id);
    expect(renewed.status).toBe('active');
    expect(renewed.endDate > today).toBe(true);
    expect(latest(renewed)).toMatchObject({ kind: 'auto_renewal', status: 'signed' });

    // Probation: extended once, then confirmed; a second final decision is refused.
    await env.database.system((tx) => tx.update(contract).set({ probationEnd: addDays(today, 10) }).where(eq(contract.id, other.body.id)));
    const ext = await s['hr.a']!.post(`/contracts/${other.body.id}/probation`, { outcome: 'extended', newProbationEnd: addDays(today, 40), note: 'Needs more time' });
    expect(ext.body).toMatchObject({ probationOutcome: 'extended', probationEnd: addDays(today, 40) });
    expect((await s['hr.a']!.post(`/contracts/${other.body.id}/probation`, { outcome: 'confirmed', newProbationEnd: null, note: 'Confirmed' })).body.probationOutcome).toBe('confirmed');
    expect((await s['hr.a']!.post(`/contracts/${other.body.id}/probation`, { outcome: 'not_confirmed', newProbationEnd: null, note: 'x x x' })).status).toBe(409);
  });

  it('employees see only their own contracts; managers of other companies see none', async () => {
    const own = await s['employee.a']!.get(`/contracts/employee/${emp}`);
    expect(own.status).toBe(200);
    expect(own.body.every((c: { employeeId: string; status: string }) => c.employeeId === emp && c.status !== 'draft')).toBe(true);
    expect((await s['employee.a']!.get(`/contracts/employee/${fin}`)).status).toBe(404);
    expect((await s['hr.b']!.get(`/contracts/${contractId}`)).status).toBe(404);
  });
});
