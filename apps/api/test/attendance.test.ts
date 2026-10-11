import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API, setup, type Session, type TestEnv } from './helpers.js';
import { AttendanceService, ipInRanges } from '../src/attendance/attendance.service.js';
import { addDays } from '../src/attendance/time.js';

const allWeek = [1, 2, 3, 4, 5, 6, 7].map((d) => ({ isoWeekday: d, isWorkday: true, startTime: '08:00', endTime: '16:00', breaks: [] }));
const key = () => randomUUID();

describe('IP matching', () => {
  it('handles IPv4, IPv4-mapped IPv6 and IPv6', () => {
    expect(ipInRanges('203.0.113.7', ['203.0.113.0/24'])).toBe(true);
    expect(ipInRanges('::ffff:203.0.113.7', ['203.0.113.0/24'])).toBe(true);
    expect(ipInRanges('203.0.114.7', ['203.0.113.0/24'])).toBe(false);
    expect(ipInRanges('2001:db8::1', ['2001:db8::/32'])).toBe(true);
    expect(ipInRanges(null, ['0.0.0.0/8'])).toBe(false);
    expect(ipInRanges('not-an-ip', ['203.0.113.0/24'])).toBe(false);
  });
});

describe('attendance (ATT-01..17)', () => {
  let env: TestEnv;
  const s: Record<string, Session> = {};
  let A: string;
  let emp: string;
  let networkId: string;
  const today = new Date().toISOString().slice(0, 10);

  beforeAll(async () => {
    env = await setup();
    A = env.seeded.companies['DEMO-A']!;
    emp = env.seeded.employees['employee.a']!;
    for (const u of ['admin', 'hr.a', 'hr.b', 'employee.a', 'sales.manager', 'manager.a']) s[u] = await env.login(u);
    const sched = await s['hr.a']!.post('/schedules', { companyId: A, code: 'ALL', nameAr: 'كل الأيام', nameEn: 'All days', graceInMinutes: 10, graceOutMinutes: 5, days: allWeek });
    await s['hr.a']!.post('/schedule-assignments', { scheduleId: sched.body.id, targetType: 'company', companyId: A, validFrom: addDays(today, -60) });
  });
  afterAll(async () => env.close());

  it('refuses punches until an authorised network is configured, and audits the refusal', async () => {
    const t = await s['employee.a']!.get('/attendance/today');
    expect(t.status, t.text).toBe(200);
    expect(t.body.network).toMatchObject({ configured: false, allowed: false });
    const r = await s['employee.a']!.post('/attendance/punch', { kind: 'in', idempotencyKey: key() });
    expect(r.status).toBe(403);
    expect(r.body.meta.reason).toBe('no_network_configured');
    const audit = await s['admin']!.get('/audit-events?action=attendance.punch_denied');
    expect(audit.body.items.length).toBeGreaterThan(0);
  });

  it('HR configures networks for their company only; unsafe ranges are refused', async () => {
    expect((await s['hr.a']!.post('/attendance/networks', { companyId: A, cidr: 'not-ip', label: 'x' })).status).toBe(400);
    expect((await s['hr.a']!.post('/attendance/networks', { companyId: A, cidr: '0.0.0.0/0', label: 'all' })).status).toBe(400);
    expect((await s['hr.b']!.post('/attendance/networks', { companyId: A, cidr: '127.0.0.0/8', label: 'x' })).status).toBe(403);
    const r = await s['hr.a']!.post('/attendance/networks', { companyId: A, cidr: '127.0.0.0/8', label: 'Office' });
    expect(r.status, r.text).toBe(201);
    networkId = r.body.id;
    await s['hr.a']!.post('/attendance/networks', { companyId: A, cidr: '::1', label: 'Office v6' });
    expect((await s['hr.b']!.get(`/attendance/networks?companyId=${A}`)).status).toBe(404);
  });

  it('punches in, takes a break, punches out; sequence and idempotency are enforced', async () => {
    const k = key();
    const first = await s['employee.a']!.post('/attendance/punch', { kind: 'in', idempotencyKey: k });
    expect(first.status, first.text).toBe(201);
    expect(first.body.state).toBe('in');
    const again = await s['employee.a']!.post('/attendance/punch', { kind: 'in', idempotencyKey: k });
    expect(again.body.state).toBe('in'); // same request replayed: no duplicate
    expect((await s['employee.a']!.post('/attendance/punch', { kind: 'in', idempotencyKey: key() })).status).toBe(409);
    expect((await s['employee.a']!.post('/attendance/punch', { kind: 'break_start', idempotencyKey: key() })).body.state).toBe('on_break');
    expect((await s['employee.a']!.post('/attendance/punch', { kind: 'out', idempotencyKey: key() })).status).toBe(409);
    expect((await s['employee.a']!.post('/attendance/punch', { kind: 'break_end', idempotencyKey: key() })).body.state).toBe('in');
    const out = await s['employee.a']!.post('/attendance/punch', { kind: 'out', idempotencyKey: key() });
    expect(out.body.state).toBe('out');
    expect(out.body.day.punches).toHaveLength(4);
    expect(out.body.day.status).toBe('present');
  });

  it('a forged X-Forwarded-For header does not change the address used (no trusted proxy)', async () => {
    await s['hr.a']!.post(`/attendance/networks/${networkId}/deactivate`);
    const nets = await s['hr.a']!.get(`/attendance/networks?companyId=${A}`);
    for (const n of nets.body.filter((x: { status: string }) => x.status === 'active')) await s['hr.a']!.post(`/attendance/networks/${n.id}/deactivate`);
    await s['hr.a']!.post('/attendance/networks', { companyId: A, cidr: '198.51.100.7', label: 'Elsewhere' });
    const r = await s['employee.a']!.agent
      .post(`${API}/attendance/punch`)
      .set('x-csrf-token', s['employee.a']!.csrf)
      .set('X-Forwarded-For', '198.51.100.7')
      .send({ kind: 'in', idempotencyKey: key() });
    expect(r.status).toBe(403);
    expect(r.body.meta.reason).toBe('outside_network');
    const who = await env.anon().get(`${API}/network/whoami`).set('X-Forwarded-For', '198.51.100.7');
    expect(who.body.ip).not.toBe('198.51.100.7');
    await s['hr.a']!.post('/attendance/networks', { companyId: A, cidr: '127.0.0.0/8', label: 'Office again' });
    await s['hr.a']!.post('/attendance/networks', { companyId: A, cidr: '::1', label: 'Office v6 again' });
  });

  it('device-bound PIN: required by policy, common PINs refused, five wrong PINs disable it (C-06)', async () => {
    await s['admin']!.put('/settings/attendance.policy', {
      companyId: A,
      value: { requireNetwork: true, verification: 'pin', deviceApproval: false, autoCheckout: false, overtimeMinMinutes: 15, earlyArrival: 'ignore', restDayWork: 'flag', correctionWindowDays: 30 },
    });
    const without = await s['employee.a']!.post('/attendance/punch', { kind: 'in', idempotencyKey: key() });
    expect(without.status).toBe(403);
    expect(without.body.meta.reason).toBe('verification_required');
    expect((await s['employee.a']!.post('/attendance/devices/pin', { label: 'Phone', pin: '1111' })).status).toBe(400);
    const dev = await s['employee.a']!.post('/attendance/devices/pin', { label: 'Phone', pin: '2580' });
    expect(dev.status, dev.text).toBe(201);
    const token: string = dev.body.deviceToken;
    // The PIN alone (without this device's token) is useless.
    expect((await s['employee.a']!.post('/attendance/punch', { kind: 'in', idempotencyKey: key(), deviceToken: 'x'.repeat(43), pin: '2580' })).status).toBe(403);
    const ok = await s['employee.a']!.post('/attendance/punch', { kind: 'in', idempotencyKey: key(), deviceToken: token, pin: '2580' });
    expect(ok.status, ok.text).toBe(201);
    expect(ok.body.day.punches.at(-1).method).toBe('pin');
    for (let i = 0; i < 4; i++) {
      expect((await s['employee.a']!.post('/attendance/punch', { kind: 'out', idempotencyKey: key(), deviceToken: token, pin: '0000' })).body.meta.reason).toBe('pin_wrong');
    }
    const fifth = await s['employee.a']!.post('/attendance/punch', { kind: 'out', idempotencyKey: key(), deviceToken: token, pin: '0000' });
    expect(fifth.body.meta.reason).toBe('pin_disabled');
    expect((await s['employee.a']!.post('/attendance/punch', { kind: 'out', idempotencyKey: key(), deviceToken: token, pin: '2580' })).status).toBe(403);
  });

  it('device approval: pending devices cannot be used until staff approve them (not their owner)', async () => {
    await s['admin']!.put('/settings/attendance.policy', {
      companyId: A,
      value: { requireNetwork: true, verification: 'pin', deviceApproval: true, autoCheckout: false, overtimeMinMinutes: 15, earlyArrival: 'ignore', restDayWork: 'flag', correctionWindowDays: 30 },
    });
    const dev = await s['employee.a']!.post('/attendance/devices/pin', { label: 'Laptop', pin: '3691' });
    expect(dev.body.device.status).toBe('pending');
    const tryIt = () => s['employee.a']!.post('/attendance/punch', { kind: 'out', idempotencyKey: key(), deviceToken: dev.body.deviceToken, pin: '3691' });
    expect((await tryIt()).status).toBe(403);
    expect((await s['employee.a']!.post(`/attendance/devices/${dev.body.device.id}/approve`)).status).toBe(403);
    const list = await s['hr.a']!.get(`/attendance/devices?companyId=${A}`);
    expect(list.body.some((d: { id: string; status: string }) => d.id === dev.body.device.id && d.status === 'pending')).toBe(true);
    expect((await s['hr.a']!.post(`/attendance/devices/${dev.body.device.id}/approve`)).status).toBe(204);
    expect((await tryIt()).status).toBe(201);
    await s['admin']!.del(`/settings/attendance.policy?companyId=${A}`);
  });

  it('WebAuthn registration options use the platform authenticator with user verification', async () => {
    const r = await s['employee.a']!.post('/attendance/devices/webauthn/options');
    expect(r.status).toBe(201);
    expect(r.body.authenticatorSelection).toMatchObject({ authenticatorAttachment: 'platform', userVerification: 'required' });
    expect(r.body.attestation).toBe('none');
  });

  it('punching is refused when the module is disabled for the company', async () => {
    await s['admin']!.put(`/modules/attendance/companies/${A}`, { enabled: false });
    const r = await s['employee.a']!.post('/attendance/punch', { kind: 'in', idempotencyKey: key() });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('MODULE_DISABLED');
    await s['admin']!.put(`/modules/attendance/companies/${A}`, { enabled: true });
  });

  it('a correction request goes manager → HR and then rewrites the day from new punches (ATT-15)', async () => {
    const yesterday = addDays(today, -1);
    const req = await s['employee.a']!.post('/attendance/corrections', {
      workDate: yesterday,
      add: [{ kind: 'in', time: '08:00' }, { kind: 'out', time: '16:00' }],
      reason: 'Forgot to punch',
    });
    expect(req.status, req.text).toBe(201);
    expect(req.body.status).toBe('pending');
    const decide = async (who: string) => {
      const tasks = await s[who]!.get('/workflow/tasks');
      const inst = tasks.body.find((i: { subjectId: string }) => i.subjectId === req.body.id);
      const task = inst.tasks.find((t: { status: string; assigneeUserId: string }) => t.status === 'pending');
      return s[who]!.post(`/workflow/tasks/${task.id}/decision`, { decision: 'approve' });
    };
    expect((await decide('sales.manager')).status).toBe(201);
    expect((await decide('hr.a')).body.status).toBe('approved');
    const days = await s['employee.a']!.get(`/attendance/employees/${emp}/days?from=${yesterday}&to=${yesterday}`);
    expect(days.body[0]).toMatchObject({ status: 'present', firstIn: '08:00', lastOut: '16:00', lateMinutes: 0 });
    expect(days.body[0].punches.every((p: { source: string }) => p.source === 'correction')).toBe(true);
    const list = await s['employee.a']!.get(`/attendance/employees/${emp}/corrections`);
    expect(list.body[0].status).toBe('approved');
  });

  it('HR can correct directly (audited); employees cannot correct others', async () => {
    const other = env.seeded.employees['emp.fin']!;
    const d = addDays(today, -2);
    expect((await s['employee.a']!.post('/attendance/corrections', { employeeId: other, workDate: d, add: [{ kind: 'in', time: '09:00' }], reason: 'x x x' })).status).toBe(404);
    const r = await s['hr.a']!.post('/attendance/corrections', { employeeId: other, workDate: d, add: [{ kind: 'in', time: '09:00' }, { kind: 'out', time: '17:00' }], reason: 'Card reader fault' });
    expect(r.status, r.text).toBe(201);
    expect(r.body).toMatchObject({ status: 'approved', direct: true });
    const days = await s['hr.a']!.get(`/attendance/employees/${other}/days?from=${d}&to=${d}`);
    expect(days.body[0]).toMatchObject({ firstIn: '09:00', lateMinutes: 60, overtimeMinutes: 60 });
  });

  it('detects possible absences, notifies the employee, and HR confirms them (ATT-14)', async () => {
    await env.app.get(AttendanceService).dailyRecompute(3);
    const d = addDays(today, -3);
    const review = await s['hr.a']!.get(`/attendance/review?companyId=${A}&from=${d}&to=${today}`);
    expect(review.status).toBe(200);
    const absence = review.body.find((r: { employeeId: string; workDate: string; status: string }) => r.employeeId === emp && r.workDate === d);
    expect(absence?.status).toBe('absent_pending');
    const notes = await s['employee.a']!.get('/notifications');
    expect(notes.body.some((n: { eventType: string }) => n.eventType === 'attendance.absence')).toBe(true);
    expect((await s['hr.a']!.post(`/attendance/employees/${emp}/days/${d}/review`, { action: 'confirm_absence', note: 'No contact' })).status).toBe(204);
    const days = await s['hr.a']!.get(`/attendance/employees/${emp}/days?from=${d}&to=${d}`);
    expect(days.body[0]).toMatchObject({ status: 'absent_confirmed', reviewNote: 'No contact' });
    expect((await s['hr.b']!.get(`/attendance/review?companyId=${A}&from=${d}&to=${today}`)).status).toBe(404);
  });

  it('who can see attendance: self, department manager, company HR — not other companies', async () => {
    const q = `?from=${today}&to=${today}`;
    expect((await s['sales.manager']!.get(`/attendance/employees/${emp}/days${q}`)).status).toBe(200);
    expect((await s['manager.a']!.get(`/attendance/employees/${emp}/days${q}`)).status).toBe(200);
    expect((await s['hr.b']!.get(`/attendance/employees/${emp}/days${q}`)).status).toBe(404);
    expect((await s['employee.a']!.get(`/attendance/employees/${env.seeded.employees['emp.fin']}/days${q}`)).status).toBe(404);
  });

  it('punches cannot be edited or deleted, even by the owner role (append-only)', async () => {
    await expect(env.database.owner.exec(`update punch set kind = 'out'`)).rejects.toThrow(/append-only/);
    await expect(env.database.owner.exec(`delete from punch`)).rejects.toThrow(/append-only/);
  });
});

describe('client address behind Railway (DL-035)', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup({ env: { TRUST_PROXY: '2' } });
  });
  afterAll(async () => env.close());

  it('takes the client from "client, edge" and ignores anything further left', async () => {
    const who = await env.anon().get(`${API}/network/whoami`).set('X-Forwarded-For', '83.244.34.13, 152.233.13.166');
    expect(who.body.ip).toBe('83.244.34.13');
    const forged = await env.anon().get(`${API}/network/whoami`).set('X-Forwarded-For', '198.51.100.7, 83.244.34.13, 152.233.13.166');
    expect(forged.body.ip).toBe('83.244.34.13');
  });
});
