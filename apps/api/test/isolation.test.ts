import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asAppRole, setup, type TestEnv } from './helpers.js';

/**
 * Database-level company isolation (D-03 second layer): even raw SQL executed as the
 * runtime role cannot read or write another company's rows.
 */
describe('row-level security', () => {
  let env: TestEnv;
  let A: string, B: string;

  beforeAll(async () => {
    env = await setup();
    A = env.seeded.companies['DEMO-A']!;
    B = env.seeded.companies['DEMO-B']!;
    const admin = await env.login('admin');
    await admin.put('/settings/general.defaultCurrency', { value: 'USD', companyId: B });
  });
  afterAll(async () => env.close());

  it('every table with a company_id column has RLS enabled and forced (except audit)', async () => {
    const rows = await env.database.owner.query<{ table_name: string; rls: boolean; forced: boolean }>(`
      select c.relname as table_name, c.relrowsecurity as rls, c.relforcerowsecurity as forced
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
        and exists (select 1 from information_schema.columns col
                    where col.table_schema = 'public' and col.table_name = c.relname
                      and col.column_name = 'company_id')`);
    expect(rows.length).toBeGreaterThan(3);
    for (const r of rows) {
      expect(r.rls, `${r.table_name} must have RLS`).toBe(true);
      if (r.table_name !== 'audit_event') expect(r.forced, `${r.table_name} must FORCE RLS`).toBe(true);
    }
    const companyTable = await env.database.owner.query<{ rls: boolean }>(
      `select relrowsecurity as rls from pg_class where relname = 'company'`,
    );
    expect(companyTable[0]!.rls).toBe(true);
  });

  it('the runtime role is not a superuser and cannot bypass RLS', async () => {
    const rows = await env.database.owner.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      `select rolsuper, rolbypassrls from pg_roles where rolname = 'hrms_app'`,
    );
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it('scoped to company A, raw queries return no rows of company B', async () => {
    const result = await asAppRole(env.database, { group: false, companyIds: [A] }, async (q) => ({
      companies: await q('select id from company'),
      depts: await q('select company_id from department'),
      locations: await q('select company_id from work_location'),
      overrides: await q('select company_id from setting_value where company_id is not null'),
      user: await q('select current_user as u'),
    }));
    expect(result.user[0]!.u).toBe('hrms_app');
    expect(result.companies.map((r) => r.id)).toEqual([A]);
    expect(result.depts.every((r) => r.company_id === A)).toBe(true);
    expect(result.locations.every((r) => r.company_id === A)).toBe(true);
    expect(result.overrides).toEqual([]);
  });

  it('with no scope at all, nothing company-scoped is visible', async () => {
    const rows = await asAppRole(env.database, { group: false, companyIds: [] }, (q) =>
      q('select id from company'),
    );
    expect(rows).toEqual([]);
  });

  it('cannot insert rows into another company', async () => {
    await expect(
      asAppRole(env.database, { group: false, companyIds: [A] }, (q) =>
        q(`insert into department (id, company_id, code, name_ar, name_en)
           values (gen_random_uuid(), $1, 'X', 'س', 'X')`, [B]),
      ),
    ).rejects.toThrow();
  });

  it('cannot move a row into another company by update', async () => {
    await expect(
      asAppRole(env.database, { group: false, companyIds: [A] }, (q) =>
        q(`update work_location set company_id = $1 where company_id = $2`, [B, A]),
      ),
    ).rejects.toThrow();
  });

  it('the runtime role cannot delete core records', async () => {
    for (const table of ['company', 'user_account', 'role_assignment', 'department']) {
      const err = await asAppRole(env.database, { group: true, companyIds: [] }, (q) =>
        q(`delete from ${table}`),
      ).then(
        () => null,
        (e: Error & { cause?: Error }) => e,
      );
      expect(err, table).not.toBeNull();
      expect(`${err!.message} ${err!.cause?.message ?? ''}`, table).toMatch(/permission denied/i);
    }
  });
});
