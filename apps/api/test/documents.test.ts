import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { API, grant, setup, type Session, type TestEnv } from './helpers.js';
import { documentCategory, role, rolePermission } from '../src/db/schema.js';
import { uuidv7 } from '../src/common/ids.js';

const PDF = Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\ntrailer << >>\n%%EOF\n');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const EXE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(100, 0)]);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe('documents (DOC-01..06)', () => {
  let env: TestEnv;
  const s: Record<string, Session> = {};
  const cat: Record<string, string> = {};
  let empA: string;

  const upload = (who: string, employeeId: string, categoryCode: string, file: Buffer, name: string, extra: Record<string, string> = {}) => {
    let req = s[who]!.agent
      .post(`${API}/employees/${employeeId}/documents`)
      .set('x-csrf-token', s[who]!.csrf)
      .field('categoryId', cat[categoryCode]!)
      .field('title', `Test ${categoryCode}`);
    for (const [k, v] of Object.entries(extra)) req = req.field(k, v);
    return req.attach('file', file, name);
  };

  beforeAll(async () => {
    env = await setup();
    empA = env.seeded.employees['employee.a']!;
    const cats = await env.database.system((tx) => tx.select().from(documentCategory));
    for (const c of cats) cat[c.code] = c.id;
    // A custom role granting medical-document access to hr.a for company A.
    await env.database.system(async (tx) => {
      const id = uuidv7();
      await tx.insert(role).values({ id, key: 'medical_officer', nameAr: 'طبي', nameEn: 'Medical officer' });
      await tx.insert(rolePermission).values([
        { roleId: id, permissionKey: 'documents.view' },
        { roleId: id, permissionKey: 'documents.view.medical' },
      ]);
    });
    await grant(env, 'hr.a', 'medical_officer', 'COMPANY', 'DEMO-A');
    for (const u of ['hr.a', 'hr.b', 'manager.a', 'employee.a', 'sales.manager']) s[u] = await env.login(u);
  });
  afterAll(async () => env.close());

  it('uploads, encrypts at rest and downloads the exact bytes', async () => {
    const r = await upload('hr.a', empA, 'qualifications', PDF, 'شهادة.pdf');
    expect(r.status, r.text).toBe(201);
    expect(r.body.mime).toBe('application/pdf');
    const stored = walk(env.filesDir).map((f) => readFileSync(f));
    expect(stored.length).toBeGreaterThan(0);
    for (const b of stored) expect(b.includes(Buffer.from('%PDF-1.7'))).toBe(false);
    const dl = await s['hr.a']!.agent.get(`${API}/documents/${r.body.id}/content`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(dl.status).toBe(200);
    expect(Buffer.compare(dl.body as Buffer, PDF)).toBe(0);
    expect(dl.headers['content-disposition']).toMatch(/^attachment;/);
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
  });

  it('rejects disguised executables, disallowed types and oversized files', async () => {
    const exe = await upload('hr.a', empA, 'qualifications', EXE, 'cv.pdf');
    expect(exe.status).toBe(400);
    const wrongType = await upload('hr.a', empA, 'photo', PDF, 'photo.pdf');
    expect(wrongType.status).toBe(400);
    const admin = await env.login('admin');
    await admin.put('/settings/documents.limits', { value: { maxUploadMb: 1 } });
    const big = await upload('hr.a', empA, 'other', Buffer.concat([PDF, Buffer.alloc(1_100_000, 32)]), 'big.pdf');
    expect(big.status).toBe(400);
    await admin.put('/settings/documents.limits', { value: { maxUploadMb: 20 } });
  });

  it('applies category sensitivity: restricted and medical documents need extra permissions', async () => {
    const restricted = await upload('hr.a', empA, 'identity', PDF, 'passport.pdf', { expiryDate: '2030-01-01' });
    expect(restricted.status, restricted.text).toBe(201);
    const medical = await upload('hr.a', empA, 'medical', PDF, 'sick-note.pdf');
    expect(medical.status, medical.text).toBe(201);

    const mgr = await s['manager.a']!.get(`/employees/${empA}/documents`);
    const mgrTitles = mgr.body.map((d: { title: string }) => d.title);
    expect(mgrTitles).toContain('Test qualifications');
    expect(mgrTitles).not.toContain('Test identity');
    expect(mgrTitles).not.toContain('Test medical');
    expect((await s['manager.a']!.get(`/documents/${medical.body.id}/content`)).status).toBe(404);

    // C-12: the employee sees their own visible categories, never medical ones.
    const own = await s['employee.a']!.get(`/employees/${empA}/documents`);
    const ownTitles = own.body.map((d: { title: string }) => d.title);
    expect(ownTitles).toContain('Test identity');
    expect(ownTitles).not.toContain('Test medical');
    expect((await s['employee.a']!.get(`/documents/${medical.body.id}/content`)).status).toBe(404);
  });

  it('other companies and other employees cannot list or download (404)', async () => {
    const docs = await s['hr.a']!.get(`/employees/${empA}/documents`);
    const id = docs.body[0].id;
    expect((await s['hr.b']!.get(`/employees/${empA}/documents`)).status).toBe(404);
    expect((await s['hr.b']!.get(`/documents/${id}/content`)).status).toBe(404);
    const other = env.seeded.employees['emp.fin']!;
    expect((await s['employee.a']!.get(`/employees/${other}/documents`)).status).toBe(404);
  });

  it('replacement keeps the previous file as superseded (C-11); delete is soft and restorable', async () => {
    const first = await upload('hr.a', empA, 'employment', PDF, 'offer.pdf');
    const rep = await s['hr.a']!.agent
      .post(`${API}/documents/${first.body.id}/replace`)
      .set('x-csrf-token', s['hr.a']!.csrf)
      .attach('file', PDF, 'offer-v2.pdf');
    expect(rep.status, rep.text).toBe(201);
    expect(rep.body.supersedesId).toBe(first.body.id);
    const list = await s['hr.a']!.get(`/employees/${empA}/documents`);
    const old = list.body.find((d: { id: string }) => d.id === first.body.id);
    expect(old.status).toBe('superseded');

    expect((await s['hr.a']!.post(`/documents/${rep.body.id}/delete`)).status).toBe(204);
    expect((await s['hr.a']!.get(`/documents/${rep.body.id}/content`)).status).toBe(404);
    expect((await s['manager.a']!.get(`/employees/${empA}/documents`)).body.map((d: { id: string }) => d.id)).not.toContain(rep.body.id);
    expect((await s['hr.a']!.post(`/documents/${rep.body.id}/restore`)).status).toBe(204);
    expect((await s['hr.a']!.get(`/documents/${rep.body.id}/content`)).status).toBe(200);
  });

  it('profile photo: image only, visible to anyone who can see the employee', async () => {
    const r = await s['hr.a']!.agent
      .post(`${API}/employees/${empA}/photo`)
      .set('x-csrf-token', s['hr.a']!.csrf)
      .attach('file', PNG, 'me.png');
    expect(r.status, r.text).toBe(201);
    const seen = await s['sales.manager']!.get(`/employees/${empA}/photo`);
    expect(seen.status).toBe(200);
    expect(seen.headers['content-type']).toBe('image/png');
    expect((await s['hr.b']!.get(`/employees/${empA}/photo`)).status).toBe(404);
  });

  it('category administration is group-only and validated', async () => {
    expect((await s['hr.a']!.post('/document-categories', {
      code: 'visa', nameAr: 'تأشيرة', nameEn: 'Visa', allowedTypes: ['pdf'], maxSizeMb: 5,
      sensitivity: 'restricted', employeeVisible: true, allowReplace: true, allowDelete: false, hasExpiry: true,
    })).status).toBe(403);
    const admin = await env.login('admin');
    const ok = await admin.post('/document-categories', {
      code: 'visa', nameAr: 'تأشيرة', nameEn: 'Visa', allowedTypes: ['pdf'], maxSizeMb: 5,
      sensitivity: 'restricted', employeeVisible: true, allowReplace: true, allowDelete: false, hasExpiry: true,
    });
    expect(ok.status).toBe(201);
    const [row] = await env.database.system((tx) => tx.select().from(documentCategory).where(eq(documentCategory.code, 'visa')));
    expect(row!.allowDelete).toBe(false);
  });

  it('no document-expiry notification exists anywhere in the code (DOC-04 exclusion)', () => {
    const srcDir = fileURLToPath(new URL('../src', import.meta.url));
    const offenders = walk(srcDir)
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => /eventType:\s*[`'"][^`'"]*expir/i.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
