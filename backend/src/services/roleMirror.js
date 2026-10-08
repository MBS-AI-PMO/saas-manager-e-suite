/**
 * Mirror an external role catalogue into one portal's portal_roles.
 * Shared by EMS-sourced portals (key: ems_role_id) and portal-sourced
 * portals (key: external_role_id).
 *
 *   - Linked by the external key, so a rename follows instead of duplicating.
 *   - New roles get a readable code from their name (free within the portal).
 *   - Roles that disappeared are removed, unless users still hold them or
 *     they are the auto-assign role (those are kept until moved).
 *   - Suffixed codes (EMPLOYEE_2) take their clean code back once it is free.
 */

/** "Project Lead - Employee" -> "PROJECT_LEAD_EMPLOYEE" (2–44 chars, A–Z 0–9 _). */
export function toRoleCode(name) {
  const base = String(name).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 44);
  return base.length >= 2 ? base : `ROLE_${base}`.slice(0, 44);
}

// Column names are interpolated, so only these two are accepted.
const KEYS = new Set(['ems_role_id', 'external_role_id']);

/**
 * @param {import('pg').PoolClient} client
 * @param {string} portalId
 * @param {{ ref: string|number, name: string, permissions?: string[] }[]} roles  full catalogue
 * @param {'ems_role_id'|'external_role_id'} key
 * @returns {Promise<{ added: number, renamed: number, removed: number, kept_in_use: number }>}
 */
export async function mirrorRoles(client, portalId, roles, key) {
  if (!KEYS.has(key)) throw new Error(`Invalid role key ${key}`);
  const stats = { added: 0, renamed: 0, removed: 0, kept_in_use: 0 };

  for (const r of roles) {
    const linked = (
      await client.query(`SELECT role_code, role_name, permissions FROM portal_roles WHERE portal_id = $1 AND ${key} = $2`, [portalId, r.ref])
    ).rows[0];

    if (linked) {
      const permsChanged = r.permissions !== undefined && JSON.stringify(linked.permissions) !== JSON.stringify(r.permissions);
      if (linked.role_name !== r.name || permsChanged) {
        await client.query(
          `UPDATE portal_roles SET role_name = $3, permissions = COALESCE($4::jsonb, permissions) WHERE portal_id = $1 AND ${key} = $2`,
          [portalId, r.ref, r.name, r.permissions !== undefined ? JSON.stringify(r.permissions) : null],
        );
        stats.renamed++;
      }
      continue;
    }

    // A hand-made role with the same name/code (e.g. from before switching
    // the role source) is linked rather than duplicated, so its users keep it.
    const adopt = (
      await client.query(
        `SELECT role_code FROM portal_roles
          WHERE portal_id = $1 AND ${key} IS NULL AND (role_code = $2 OR lower(role_name) = lower($3))
          ORDER BY (role_code = $2) DESC LIMIT 1`,
        [portalId, toRoleCode(r.name), r.name],
      )
    ).rows[0];
    if (adopt) {
      await client.query(
        `UPDATE portal_roles SET ${key} = $3, role_name = $4, permissions = COALESCE($5::jsonb, permissions) WHERE portal_id = $1 AND role_code = $2`,
        [portalId, adopt.role_code, r.ref, r.name, r.permissions !== undefined ? JSON.stringify(r.permissions) : null],
      );
      stats.renamed++;
      continue;
    }

    const base = toRoleCode(r.name);
    let code = base;
    for (let n = 2; (await client.query('SELECT 1 FROM portal_roles WHERE portal_id = $1 AND role_code = $2', [portalId, code])).rows[0]; n++) {
      code = `${base}_${n}`;
    }
    await client.query(
      `INSERT INTO portal_roles (portal_id, role_code, role_name, permissions, ${key}) VALUES ($1, $2, $3, $4::jsonb, $5)`,
      [portalId, code, r.name, JSON.stringify(r.permissions ?? []), r.ref],
    );
    stats.added++;
  }

  // Everything not in the catalogue (including hand-made roles left over from
  // before the switch) goes, unless still in use.
  const refs = roles.map((r) => String(r.ref));
  const stale = (
    await client.query(
      `SELECT r.role_code,
              EXISTS (SELECT 1 FROM user_portal_access a WHERE a.portal_id = r.portal_id AND a.assigned_portal_role = r.role_code)
           OR EXISTS (SELECT 1 FROM portals p WHERE p.id = r.portal_id AND p.auto_grant_role = r.role_code) AS in_use
         FROM portal_roles r
        WHERE r.portal_id = $1 AND (r.${key} IS NULL OR NOT (r.${key}::text = ANY($2::text[])))`,
      [portalId, refs],
    )
  ).rows;
  for (const s of stale) {
    if (s.in_use) {
      stats.kept_in_use++;
      continue;
    }
    await client.query('DELETE FROM portal_roles WHERE portal_id = $1 AND role_code = $2', [portalId, s.role_code]);
    stats.removed++;
  }

  // Suffixed codes take their clean code back once free (access rows follow via ON UPDATE CASCADE).
  const mirrored = (await client.query(`SELECT role_code, role_name FROM portal_roles WHERE portal_id = $1 AND ${key} IS NOT NULL`, [portalId])).rows;
  for (const r of mirrored) {
    const clean = toRoleCode(r.role_name);
    if (r.role_code === clean) continue;
    if ((await client.query('SELECT 1 FROM portal_roles WHERE portal_id = $1 AND role_code = $2', [portalId, clean])).rows[0]) continue;
    await client.query('UPDATE portal_roles SET role_code = $3 WHERE portal_id = $1 AND role_code = $2', [portalId, r.role_code, clean]);
    await client.query('UPDATE portals SET auto_grant_role = $3 WHERE id = $1 AND auto_grant_role = $2', [portalId, r.role_code, clean]);
  }

  return stats;
}
