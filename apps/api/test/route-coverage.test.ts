import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API, setup, type Session, type TestEnv } from './helpers.js';

/**
 * Hardening (P12): every route found in the controllers is called without a session, as a
 * plain employee, and with junk input. Nothing may leak, and nothing may crash (5xx).
 */

interface Route {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  path: string;
  isPublic: boolean;
}

function routes(): Route[] {
  const out: Route[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      if (f.isDirectory()) walk(join(dir, f.name));
      else if (f.name.endsWith('.controller.ts')) {
        const src = readFileSync(join(dir, f.name), 'utf8');
        const prefix = /@Controller\('([^']*)'\)/.exec(src)?.[1] ?? '';
        const re = /((?:@Public\(\)\s*)?(?:@\w+\([^)]*\)\s*)*)@(Get|Post|Put|Patch|Delete)\(('([^']*)')?\)/g;
        for (const m of src.matchAll(re)) {
          // The handler's decorators: the ones matched before the route decorator and those after it.
          const at = (m.index ?? 0) + m[0].length;
          const handlerBlock = m[0] + src.slice(at, src.indexOf('(', src.indexOf(String.fromCharCode(10), at) + 1));
          const sub = m[4] ?? '';
          out.push({
            method: m[2]!.toLowerCase() as Route['method'],
            path: `/${[prefix, sub].filter(Boolean).join('/')}`.replace(/\/+/g, '/'),
            isPublic: /@Public\(\)/.test(handlerBlock),
          });
        }
      }
    }
  };
  walk(join(__dirname, '..', 'src'));
  return out;
}

const fill = (p: string) => p.replace(/:[a-zA-Z]+/g, (k) => (k === ':date' ? '2026-01-01' : k === ':key' ? 'general.language' : '01a00000-0000-7000-8000-000000000000'));

describe('route coverage (P12 hardening)', () => {
  let env: TestEnv;
  let employee: Session;
  const all = routes();

  beforeAll(async () => {
    env = await setup();
    employee = await env.login('employee.a');
  });
  afterAll(async () => env.close());

  it('finds the routes', () => {
    expect(all.length).toBeGreaterThan(150);
  });

  it('nothing is reachable without a session except the public endpoints', async () => {
    const leaks: string[] = [];
    for (const r of all.filter((x) => !x.isPublic)) {
      const res = await env.anon()[r.method](`${API}${fill(r.path)}`).send({});
      if (res.status < 400 || res.status >= 500) leaks.push(`${r.method.toUpperCase()} ${r.path} → ${res.status}`);
    }
    expect(leaks).toEqual([]);
  });

  it('a plain employee gets data only from self-service endpoints', async () => {
    // Endpoints an employee may legitimately read (own data, reference lists, own tasks).
    const allowed = new Set([
      '/auth/session',
      '/auth/sessions',
      '/auth/mfa/status',
      '/settings/public',
      '/notifications',
      '/notifications/unread-count',
      '/notifications/push/key',
      '/push/vapid-key',
      '/workflow/tasks',
      '/workflow/requests',
      '/workflow/delegations',
      '/workflow/delegates',
      '/attendance/today',
      '/attendance/devices/mine',
      '/leave/types',
      '/contracts/to-sign',
      '/payroll/payslips/mine',
      '/recruitment/stages',
      '/dashboard',
      '/search',
      '/document-categories',
      '/lookups',
      '/companies',
      '/departments',
      '/locations',
      '/holidays',
      '/schedules',
      '/reports/saved',
      '/reports/outputs',
      '/modules',
      '/network/whoami',
      '/health',
      '/health/live',
      '/health/ready',
      '/version',
      '/group',
      '/notifications/push/public-key',
      '/workflow/requests/mine',
      // Filtered to the employee's own record (checked below).
      '/employees',
    ]);
    const exposed: string[] = [];
    for (const r of all.filter((x) => x.method === 'get' && !x.path.includes(':'))) {
      const res = await employee.get(r.path);
      const empty = Array.isArray(res.body) && res.body.length === 0;
      if (res.status >= 500) exposed.push(`${r.path} → ${res.status}`);
      else if (res.status < 300 && !empty && !allowed.has(r.path)) exposed.push(`${r.path} → ${res.status} (not a self-service endpoint)`);
    }
    expect(exposed).toEqual([]);
    const list = await employee.get('/employees');
    expect(list.body.map((e: { id: string }) => e.id)).toEqual([env.seeded.employees['employee.a']]);
  });

  it('junk input never crashes a route (no 5xx)', async () => {
    const admin = await env.login('admin');
    const crashes: string[] = [];
    for (const r of all.filter((x) => !x.isPublic)) {
      const url = fill(r.path).replace('01a00000-0000-7000-8000-000000000000', 'not-a-uuid');
      const res = await admin[r.method === 'delete' ? 'del' : r.method](url, r.method === 'get' || r.method === 'delete' ? undefined : { junk: '\u0000‮<script>', n: -1 });
      if (res.status >= 500) crashes.push(`${r.method.toUpperCase()} ${r.path} → ${res.status}`);
    }
    expect(crashes).toEqual([]);
  });
});
