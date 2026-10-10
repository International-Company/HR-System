import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { setup, type Session, type TestEnv } from './helpers.js';
import { PolicyService } from '../src/access/policy.service.js';
import { WorkflowService } from '../src/workflow/workflow.service.js';
import { userAccount, workflowDefinition } from '../src/db/schema.js';
import type { Principal } from '../src/access/principal.js';

/** Build the server-side principal of a seeded user (to start workflows like a module would). */
async function principalOf(env: TestEnv, username: string): Promise<Principal> {
  const [u] = await env.database.system((tx) => tx.select().from(userAccount).where(eq(userAccount.username, username)));
  return env.app.get(PolicyService).loadPrincipal(u!, randomUUID(), () => 'active');
}

describe('workflow engine (D-17, LEV-03 route, NOT-04)', () => {
  let env: TestEnv;
  let wf: WorkflowService;
  const s: Record<string, Session> = {};
  const completed: { id: string; outcome: string }[] = [];
  let A: string;

  const start = async (requester: string, subjectEmployee: string) => {
    const p = await principalOf(env, requester);
    return env.database.tx(p.rls(), (tx) =>
      wf.start(tx, p, {
        definitionKey: 'leave.standard',
        companyId: A,
        subjectType: 'test_subject',
        subjectId: randomUUID(),
        subjectEmployeeId: subjectEmployee,
        summary: { days: 2 },
      }),
    );
  };

  beforeAll(async () => {
    env = await setup();
    A = env.seeded.companies['DEMO-A']!;
    wf = env.app.get(WorkflowService);
    wf.registerHandler('test_subject', {
      onCompleted: async (_tx, inst, outcome) => {
        completed.push({ id: inst.id, outcome });
      },
      link: (inst) => `/test/${inst.subjectId}`,
    });
    for (const u of ['admin', 'hr.a', 'hr.b', 'sales.manager', 'employee.a', 'manager.a']) s[u] = await env.login(u);
  });
  afterAll(async () => env.close());

  it('routes Employee → Direct manager → HR, notifying each approver and the requester', async () => {
    const inst = await start('employee.a', env.seeded.employees['employee.a']!);
    expect(inst.status).toBe('pending');
    expect(inst.currentSeq).toBe(1);

    // Only the direct manager has a task now.
    const mgrTasks = await s['sales.manager']!.get('/workflow/tasks');
    const task = mgrTasks.body.find((i: { id: string }) => i.id === inst.id).tasks.find((t: { status: string }) => t.status === 'pending');
    expect(task.assigneeUserId).toBe(env.seeded.users['sales.manager']);
    expect((await s['hr.a']!.get('/workflow/tasks')).body.map((i: { id: string }) => i.id)).not.toContain(inst.id);

    // The requester cannot decide someone else's task.
    expect((await s['employee.a']!.post(`/workflow/tasks/${task.id}/decision`, { decision: 'approve' })).status).toBe(404);

    const step1 = await s['sales.manager']!.post(`/workflow/tasks/${task.id}/decision`, { decision: 'approve', comment: 'OK' });
    expect(step1.status, step1.text).toBe(201);
    expect(step1.body.currentSeq).toBe(2);

    const hrTasks = await s['hr.a']!.get('/workflow/tasks');
    const hrTask = hrTasks.body.find((i: { id: string }) => i.id === inst.id).tasks.find((t: { status: string }) => t.status === 'pending');
    const done = await s['hr.a']!.post(`/workflow/tasks/${hrTask.id}/decision`, { decision: 'approve' });
    expect(done.body.status).toBe('approved');
    expect(completed).toContainEqual({ id: inst.id, outcome: 'approved' });

    const notes = await s['employee.a']!.get('/notifications');
    expect(notes.body.some((n: { eventType: string; link: string }) => n.eventType === 'workflow.approved' && n.link.startsWith('/test/'))).toBe(true);
    const mgrNotes = await s['sales.manager']!.get('/notifications');
    expect(mgrNotes.body.some((n: { eventType: string }) => n.eventType === 'workflow.task_assigned')).toBe(true);
  });

  it('rejection needs a reason and ends the request', async () => {
    const inst = await start('employee.a', env.seeded.employees['employee.a']!);
    const t = (await s['sales.manager']!.get(`/workflow/instances/${inst.id}`)).body.tasks.find((x: { status: string }) => x.status === 'pending');
    expect((await s['sales.manager']!.post(`/workflow/tasks/${t.id}/decision`, { decision: 'reject' })).status).toBe(400);
    const r = await s['sales.manager']!.post(`/workflow/tasks/${t.id}/decision`, { decision: 'reject', comment: 'Busy period' });
    expect(r.body.status).toBe('rejected');
    expect(completed).toContainEqual({ id: inst.id, outcome: 'rejected' });
    expect((await s['sales.manager']!.post(`/workflow/tasks/${t.id}/decision`, { decision: 'approve' })).status).toBe(409);
  });

  it('the requester can cancel a pending request', async () => {
    const inst = await start('employee.a', env.seeded.employees['employee.a']!);
    expect((await s['hr.a']!.post(`/workflow/instances/${inst.id}/cancel`)).status).toBe(404);
    const r = await s['employee.a']!.post(`/workflow/instances/${inst.id}/cancel`);
    expect(r.body.status).toBe('cancelled');
    expect(r.body.tasks.every((t: { status: string }) => t.status !== 'pending')).toBe(true);
  });

  it('skips the manager step when there is no manager, and never lets anyone approve their own request', async () => {
    // emp.fin has no manager; hr.a files on their behalf → HR step must exclude hr.a → nobody left.
    const p = await principalOf(env, 'hr.a');
    await expect(
      env.database.tx(p.rls(), (tx) =>
        wf.start(tx, p, {
          definitionKey: 'leave.standard',
          companyId: A,
          subjectType: 'test_subject',
          subjectId: randomUUID(),
          subjectEmployeeId: env.seeded.employees['emp.fin']!,
        }),
      ),
    ).rejects.toThrow(/No approver/);

    // Filed by the employee themself: manager step skipped, goes straight to HR.
    const inst = await start('employee.a', env.seeded.employees['emp.fin']!);
    const full = await s['hr.a']!.get(`/workflow/instances/${inst.id}`);
    expect(full.body.tasks.find((t: { seq: number }) => t.seq === 1).status).toBe('skipped');
    expect(full.body.currentSeq).toBe(2);
  });

  it('honours delegation while the approver is away', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const d = await s['sales.manager']!.post('/workflow/delegations', {
      toUserId: env.seeded.users['manager.a'],
      validFrom: today,
      validTo: today,
    });
    expect(d.status).toBe(204);
    const inst = await start('employee.a', env.seeded.employees['employee.a']!);
    const t = (await s['manager.a']!.get('/workflow/tasks')).body.find((i: { id: string }) => i.id === inst.id).tasks.find((x: { status: string }) => x.status === 'pending');
    expect(t.assigneeUserId).toBe(env.seeded.users['manager.a']);
    expect(t.delegatedFromUserId).toBe(env.seeded.users['sales.manager']);
    const dels = await s['sales.manager']!.get('/workflow/delegations');
    expect((await s['sales.manager']!.post(`/workflow/delegations/${dels.body[0].id}/revoke`)).status).toBe(204);
  });

  it('other companies cannot see the requests', async () => {
    const inst = await start('employee.a', env.seeded.employees['employee.a']!);
    expect((await s['hr.b']!.get(`/workflow/instances/${inst.id}`)).status).toBe(404);
    const list = await s['hr.b']!.get('/workflow/instances');
    expect(list.body.map((i: { id: string }) => i.id)).not.toContain(inst.id);
    const hrA = await s['hr.a']!.get('/workflow/instances?status=pending');
    expect(hrA.body.map((i: { id: string }) => i.id)).toContain(inst.id);
  });

  it('the leave route is locked; other routes must keep at least one mandatory step', async () => {
    const defs = await s['admin']!.get('/workflow/definitions');
    const leave = defs.body.find((x: { key: string }) => x.key === 'leave.standard');
    expect(leave.locked).toBe(true);
    const r = await s['admin']!.put(`/workflow/definitions/${leave.id}/steps`, {
      version: leave.version,
      steps: [{ approverRule: 'direct_manager', skipIfUnresolved: true, nameAr: 'م', nameEn: 'M' }],
    });
    expect(r.status).toBe(409);
    await env.database.owner.exec(
      `insert into workflow_definition (id, key, subject_type, name_ar, name_en) values (gen_random_uuid(), 'test.custom', 'test_subject', 'اختبار', 'Test')`,
    );
    const [custom] = await env.database.system((tx) => tx.select().from(workflowDefinition).where(eq(workflowDefinition.key, 'test.custom')));
    const bad = await s['admin']!.put(`/workflow/definitions/${custom!.id}/steps`, {
      version: 1,
      steps: [{ approverRule: 'direct_manager', skipIfUnresolved: true, nameAr: 'م', nameEn: 'M' }],
    });
    expect(bad.status).toBe(400);
    const ok = await s['admin']!.put(`/workflow/definitions/${custom!.id}/steps`, {
      version: 1,
      steps: [{ approverRule: 'role_in_company', roleKey: 'hr', skipIfUnresolved: false, nameAr: 'م', nameEn: 'HR' }],
    });
    expect(ok.status).toBe(204);
    expect((await s['hr.a']!.get('/workflow/definitions')).status).toBe(403);
  });
});
