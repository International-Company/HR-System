import { MODULE_KEYS, PERMISSIONS, SYSTEM_ROLES } from '@hrms/shared';
import type { SqlRunner } from '../db/database.js';
import { uuidv7 } from '../common/ids.js';

/**
 * Sync the permission catalogue, system roles and module registry from code into the
 * database (owner privileges). Idempotent; runs after migrations.
 */
export async function syncCatalog(owner: SqlRunner): Promise<{ changes: number }> {
  return owner.session(async (db) => {
    let changes = 0;
    await db.exec('begin');
    try {
      const keys = PERMISSIONS.map((p) => p.key);
      for (const p of PERMISSIONS) {
        const r = await db.query<{ changed: boolean }>(
          `insert into permission (key, module, sensitivity, group_only, label_ar, label_en)
           values ($1, $2, $3, $4, $5, $6)
           on conflict (key) do update set module = excluded.module,
             sensitivity = excluded.sensitivity, group_only = excluded.group_only,
             label_ar = excluded.label_ar, label_en = excluded.label_en
           where (permission.module, permission.sensitivity, permission.group_only,
                  permission.label_ar, permission.label_en)
             is distinct from (excluded.module, excluded.sensitivity, excluded.group_only,
                  excluded.label_ar, excluded.label_en)
           returning true as changed`,
          [p.key, p.module, p.sensitivity, p.groupOnly, p.label.ar, p.label.en],
        );
        changes += r.length;
      }
      const removed = await db.query(
        `with gone as (select key from permission where not (key = any($1::text[])))
         , rp as (delete from role_permission where permission_key in (select key from gone))
         delete from permission where key in (select key from gone) returning key`,
        [keys],
      );
      changes += removed.length;

      for (const def of SYSTEM_ROLES) {
        const existing = await db.query<{ id: string }>('select id from role where key = $1', [
          def.key,
        ]);
        let roleId = existing[0]?.id;
        if (!roleId) {
          roleId = uuidv7();
          await db.query(
            `insert into role (id, key, name_ar, name_en, is_system) values ($1, $2, $3, $4, true)`,
            [roleId, def.key, def.name.ar, def.name.en],
          );
          changes += 1;
        } else {
          await db.query(
            `update role set name_ar = $2, name_en = $3, is_system = true
             where id = $1 and (name_ar, name_en, is_system) is distinct from ($2, $3, true)`,
            [roleId, def.name.ar, def.name.en],
          );
        }
        const del = await db.query(
          `delete from role_permission where role_id = $1 and not (permission_key = any($2::text[]))
           returning permission_key`,
          [roleId, [...def.permissions]],
        );
        const ins = await db.query(
          `insert into role_permission (role_id, permission_key)
           select $1, unnest($2::text[]) on conflict do nothing returning permission_key`,
          [roleId, [...def.permissions]],
        );
        changes += del.length + ins.length;
      }

      const mod = await db.query(
        `insert into module (key) select unnest($1::text[]) on conflict do nothing returning key`,
        [[...MODULE_KEYS]],
      );
      changes += mod.length;

      if (changes > 0) {
        await db.query(
          `insert into audit_event (id, action, outcome, details, hash)
           values (0, 'system.catalog.synced', 'success', $1::jsonb, '\\x')`,
          [JSON.stringify({ changes })],
        );
      }
      await db.exec('commit');
      return { changes };
    } catch (err) {
      await db.exec('rollback');
      throw err;
    }
  });
}
