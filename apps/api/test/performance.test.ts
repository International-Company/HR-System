import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, type Session, type TestEnv } from './helpers.js';
import { uuidv7 } from '../src/common/ids.js';
import { attendanceDay, compensation, employee, employmentAssignment } from '../src/db/schema.js';

/**
 * Hardening (P12): performance baselines on the in-process database (slower than a real
 * PostgreSQL server). Targets: punch p95 < 1 s (P4), payroll for a large company in minutes.
 */
const allWeek = [1, 2, 3, 4, 5, 6, 7].map((d) => ({ isoWeekday: d, isWorkday: true, startTime: '08:00', endTime: '16:00', breaks: [] }));
const N = 200;
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]!;

describe('performance baselines (P12)', () => {
  let env: TestEnv;
  const s: Record<string, Session> = {};
  let A: string;
  const now = new Date();
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const period = first.toISOString().slice(0, 7);
  const days = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();

  beforeAll(async () => {
    env = await setup();
    A = env.seeded.companies['DEMO-A']!;
    for (const u of ['hr.a', 'employee.a', 'finance.a']) s[u] = await env.login(u);
    const sched = await s['hr.a']!.post('/schedules', { companyId: A, code: 'ALL', nameAr: 'كل الأيام', nameEn: 'All days', graceInMinutes: 10, graceOutMinutes: 5, days: allWeek });
    await s['hr.a']!.post('/schedule-assignments', { scheduleId: sched.body.id, targetType: 'company', companyId: A, validFrom: '2020-01-01' });
    await s['hr.a']!.post('/attendance/networks', { companyId: A, cidr: '127.0.0.0/8', label: 'Office' });
    await s['hr.a']!.post('/attendance/networks', { companyId: A, cidr: '::1', label: 'Office v6' });
    // A large company: N employees with salaries and a month of attendance.
    await env.database.system(async (tx) => {
      for (let i = 0; i < N; i++) {
        const id = uuidv7();
        await tx.insert(employee).values({ id, employeeNo: `PERF-${String(i).padStart(4, '0')}`, fullNameAr: `موظف ${i}`, fullNameEn: `Employee ${i}`, hireDate: '2024-01-01', status: 'active' });
        await tx.insert(employmentAssignment).values({ id: uuidv7(), employeeId: id, companyId: A, validFrom: '2024-01-01', changeReason: 'hire' });
        await tx.insert(compensation).values({ id: uuidv7(), employeeId: id, companyId: A, baseSalary: String(2500 + i), currency: 'EUR', paymentMethod: 'bank_transfer', validFrom: '2024-01-01' });
        await tx.insert(attendanceDay).values(
          Array.from({ length: days }, (_, d) => ({
            id: uuidv7(),
            employeeId: id,
            companyId: A,
            workDate: `${period}-${String(d + 1).padStart(2, '0')}`,
            dayClass: 'workday' as const,
            status: d % 11 === 0 ? ('absent_confirmed' as const) : ('present' as const),
            workedMinutes: 480,
            lateMinutes: d % 7 === 0 ? 15 : 0,
            overtimeMinutes: d % 5 === 0 ? 30 : 0,
            flags: [],
          })),
        );
      }
    });
  }, 300_000);
  afterAll(async () => env.close());

  it(`payroll for ${N} employees with a month of attendance`, async () => {
    const t0 = performance.now();
    const r = await s['finance.a']!.post('/payroll/runs', { companyId: A, period });
    const ms = performance.now() - t0;
    expect(r.status, r.text).toBe(201);
    expect(r.body.lines.length).toBeGreaterThanOrEqual(N);
    console.log(`[perf] payroll ${r.body.lines.length} employees: ${Math.round(ms)} ms`);
    expect(ms).toBeLessThan(180_000);
  }, 300_000);

  it('a burst of punches keeps p95 under 1 s', async () => {
    const times: number[] = [];
    const kinds = ['in', 'break_start', 'break_end', 'out'] as const;
    for (let i = 0; i < 100; i++) {
      const t0 = performance.now();
      const r = await s['employee.a']!.post('/attendance/punch', { kind: kinds[i % 4], idempotencyKey: randomUUID() });
      times.push(performance.now() - t0);
      expect(r.status, r.text).toBe(201);
    }
    console.log(`[perf] punch p50 ${Math.round(pct(times, 50))} ms, p95 ${Math.round(pct(times, 95))} ms`);
    expect(pct(times, 95)).toBeLessThan(1000);
  }, 300_000);
});
