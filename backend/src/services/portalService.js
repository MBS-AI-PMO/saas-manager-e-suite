/**
 * Target-portal administration: register portals, manage each portal's own
 * role catalogue, rotate its webhook secret, and bulk-manage user access.
 *
 * The webhook secret is returned in plain text ONLY by create and rotate; the
 * admin copies it into the portal's configuration. Every other read hides it.
 */
import crypto from 'node:crypto';
import { query, withTransaction } from '../db/pool.js';
import { conflict, notFound, unprocessable } from '../utils/errors.js';
import { applyAutoGrants, setPortalAccess } from './accessService.js';
import { writeAudit } from './auditService.js';
import { alignEmsPortalRoles, syncEmsRolesIntoPortal } from './emsRoleService.js';

const newSecret = () => crypto.randomBytes(32).toString('hex');

const PORTAL_SELECT = `
  SELECT p.id, p.portal_name, p.portal_code, p.base_url, p.webhook_url, p.is_enabled, p.auto_grant_role, p.role_source,
         p.roles_url, p.roles_synced_at, p.roles_sync_error,
         (p.webhook_url IS NOT NULL) AS has_webhook, p.created_at, p.updated_at,
         COALESCE((
           SELECT json_agg(json_build_object(
                    'role_code', r.role_code, 'role_name', r.role_name, 'permissions', r.permissions, 'ems_role_id', r.ems_role_id,
                    'external_role_id', r.external_role_id,
                    'user_count', (SELECT count(*) FROM user_portal_access x
                                    WHERE x.portal_id = r.portal_id AND x.assigned_portal_role = r.role_code))
                  ORDER BY r.role_name)
             FROM portal_roles r WHERE r.portal_id = p.id
         ), '[]'::json) AS roles,
         (SELECT count(*)::int FROM user_portal_access a WHERE a.portal_id = p.id) AS granted_count,
         (SELECT count(*)::int FROM user_portal_access a JOIN saas_users u ON u.id = a.user_id
           WHERE a.portal_id = p.id AND a.is_active AND u.status = 'ACTIVE') AS active_count,
         (SELECT count(*)::int FROM portal_sync_events e WHERE e.portal_id = p.id AND e.status = 'PENDING') AS pending_events,
         (SELECT count(*)::int FROM portal_sync_events e WHERE e.portal_id = p.id AND e.status = 'FAILED') AS failed_events
    FROM portals p`;

export async function listPortals() {
  const { rows } = await query(`${PORTAL_SELECT} ORDER BY p.portal_name`);
  return rows;
}

export async function getPortal(code, client = { query }) {
  const { rows } = await client.query(`${PORTAL_SELECT} WHERE p.portal_code = $1`, [code]);
  if (!rows[0]) throw notFound(`Portal ${code} not found`);
  return rows[0];
}

async function portalId(client, code) {
  const { rows } = await client.query('SELECT id FROM portals WHERE portal_code = $1 FOR UPDATE', [code]);
  if (!rows[0]) throw notFound(`Portal ${code} not found`);
  return rows[0].id;
}

const audit = (client, admin, action, details) =>
  writeAudit(client, { actorId: admin.id, actorLabel: admin.email, action, details });

// ---------------------------------------------------------------------------
// Portals
// ---------------------------------------------------------------------------

/** @returns {Promise<{ portal: object, webhook_secret: string }>} */
export async function createPortal(input, admin) {
  return withTransaction(async (client) => {
    const exists = await client.query('SELECT 1 FROM portals WHERE portal_code = $1', [input.portal_code]);
    if (exists.rows[0]) throw conflict(`Portal code ${input.portal_code} is already in use`);

    const codes = input.roles.map((r) => r.role_code);
    if (new Set(codes).size !== codes.length) throw conflict('Each role code must be unique within the portal');
    if (input.auto_grant_role && !codes.includes(input.auto_grant_role)) {
      throw unprocessable(`Auto-assign role ${input.auto_grant_role} is not one of this portal's roles`);
    }

    const secret = newSecret();
    const { rows } = await client.query(
      `INSERT INTO portals (portal_name, portal_code, base_url, webhook_url, webhook_secret, role_source, roles_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [input.portal_name, input.portal_code, input.base_url ?? null, input.webhook_url ?? null, secret, input.role_source, input.roles_url ?? null],
    );
    if (input.role_source === 'EMS') {
      await requireEmsRoles(client);
      await syncEmsRolesIntoPortal(client, rows[0].id);
      if (input.auto_grant_ems_role_id) {
        const fallback = await client.query('SELECT role_code FROM portal_roles WHERE portal_id = $1 AND ems_role_id = $2', [
          rows[0].id,
          input.auto_grant_ems_role_id,
        ]);
        if (!fallback.rows[0]) throw unprocessable('Auto-assign EMS role not found');
        input.auto_grant_role = fallback.rows[0].role_code;
        codes.push(input.auto_grant_role);
      }
    }
    for (const r of input.roles) {
      await client.query(
        'INSERT INTO portal_roles (portal_id, role_code, role_name, permissions) VALUES ($1, $2, $3, $4)',
        [rows[0].id, r.role_code, r.role_name, JSON.stringify(r.permissions)],
      );
    }
    // Auto-assign is set after the roles exist, then backfilled.
    let autoGranted = 0;
    if (input.auto_grant_role) {
      await client.query('UPDATE portals SET auto_grant_role = $2 WHERE id = $1', [rows[0].id, input.auto_grant_role]);
      autoGranted = await applyAutoGrants(client, { portalId: rows[0].id, actor: { id: admin.id, label: admin.email } });
    }
    await audit(client, admin, 'PORTAL_CREATED', { portal: input.portal_code, roles: codes, auto_granted: autoGranted });
    return { portal: await getPortal(input.portal_code, client), webhook_secret: secret };
  });
}

export async function updatePortal(code, patch, admin) {
  return withTransaction(async (client) => {
    const id = await portalId(client, code);
    const before = (await client.query('SELECT role_source, auto_grant_role FROM portals WHERE id = $1', [id])).rows[0];
    const switchingToEms = patch.role_source === 'EMS' && before.role_source !== 'EMS';
    if (switchingToEms) await requireEmsRoles(client);
    if (patch.role_source === 'PORTAL') {
      const url = 'roles_url' in patch ? patch.roles_url : (await client.query('SELECT roles_url FROM portals WHERE id = $1', [id])).rows[0].roles_url;
      if (!url) throw unprocessable('Enter the roles URL before fetching roles from the portal');
    }
    if (patch.auto_grant_role) {
      const role = await client.query('SELECT 1 FROM portal_roles WHERE portal_id = $1 AND role_code = $2', [id, patch.auto_grant_role]);
      if (!role.rows[0]) throw unprocessable(`Role ${patch.auto_grant_role} does not exist on ${code}`);
    }
    // Keys come from the zod schema (fixed allow-list), never from raw input.
    const fields = Object.keys(patch);
    const sets = fields.map((f, i) => `${f} = $${i + 2}`).join(', ');
    await client.query(`UPDATE portals SET ${sets} WHERE portal_code = $1`, [code, ...fields.map((f) => patch[f])]);

    if (switchingToEms) await switchToEmsRoles(client, id, before.auto_grant_role, { id: admin.id, label: admin.email });

    // Turning auto-assign on backfills every EMS user who has no row yet.
    let autoGranted = 0;
    if (patch.auto_grant_role) {
      autoGranted = await applyAutoGrants(client, { portalId: id, actor: { id: admin.id, label: admin.email } });
    }
    await audit(client, admin, 'PORTAL_UPDATED', { portal: code, changes: patch, auto_granted: autoGranted });
    return { ...(await getPortal(code, client)), auto_granted: autoGranted };
  });
}

export async function rotatePortalSecret(code, admin) {
  return withTransaction(async (client) => {
    await portalId(client, code);
    const secret = newSecret();
    await client.query('UPDATE portals SET webhook_secret = $2 WHERE portal_code = $1', [code, secret]);
    await audit(client, admin, 'PORTAL_SECRET_ROTATED', { portal: code });
    return { webhook_secret: secret };
  });
}

/** Only a portal nobody has access to can be deleted; otherwise disable it. */
export async function deletePortal(code, admin) {
  return withTransaction(async (client) => {
    const id = await portalId(client, code);
    const used = await client.query('SELECT count(*)::int AS n FROM user_portal_access WHERE portal_id = $1', [id]);
    if (used.rows[0].n > 0) {
      throw conflict(`${used.rows[0].n} user(s) have access to this portal. Disable it instead, or remove their access first.`);
    }
    await client.query('DELETE FROM portals WHERE id = $1', [id]);
    await audit(client, admin, 'PORTAL_DELETED', { portal: code });
  });
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

export async function addPortalRole(code, role, admin) {
  return withTransaction(async (client) => {
    const id = await portalId(client, code);
    await assertOwnRoles(client, id);
    const dup = await client.query('SELECT 1 FROM portal_roles WHERE portal_id = $1 AND role_code = $2', [id, role.role_code]);
    if (dup.rows[0]) throw conflict(`Role ${role.role_code} already exists on ${code}`);
    await client.query('INSERT INTO portal_roles (portal_id, role_code, role_name, permissions) VALUES ($1, $2, $3, $4)', [
      id,
      role.role_code,
      role.role_name,
      JSON.stringify(role.permissions),
    ]);
    await audit(client, admin, 'PORTAL_ROLE_ADDED', { portal: code, role: role.role_code });
    return getPortal(code, client);
  });
}

export async function updatePortalRole(code, roleCode, patch, admin) {
  return withTransaction(async (client) => {
    const id = await portalId(client, code);
    await assertOwnRoles(client, id);
    const { rowCount } = await client.query(
      `UPDATE portal_roles
          SET role_name = COALESCE($3, role_name), permissions = COALESCE($4::jsonb, permissions)
        WHERE portal_id = $1 AND role_code = $2`,
      [id, roleCode, patch.role_name ?? null, patch.permissions ? JSON.stringify(patch.permissions) : null],
    );
    if (!rowCount) throw notFound(`Role ${roleCode} not found on ${code}`);
    await audit(client, admin, 'PORTAL_ROLE_UPDATED', { portal: code, role: roleCode, changes: patch });
    return getPortal(code, client);
  });
}

export async function deletePortalRole(code, roleCode, admin) {
  return withTransaction(async (client) => {
    const id = await portalId(client, code);
    await assertOwnRoles(client, id);
    const used = await client.query(
      'SELECT count(*)::int AS n FROM user_portal_access WHERE portal_id = $1 AND assigned_portal_role = $2',
      [id, roleCode],
    );
    if (used.rows[0].n > 0) throw conflict(`${used.rows[0].n} user(s) have this role. Move them to another role first.`);
    const auto = await client.query('SELECT 1 FROM portals WHERE id = $1 AND auto_grant_role = $2', [id, roleCode]);
    if (auto.rows[0]) throw conflict('This role is the auto-assign role. Change the auto-assign setting first.');
    const left = await client.query('SELECT count(*)::int AS n FROM portal_roles WHERE portal_id = $1', [id]);
    if (left.rows[0].n <= 1) throw conflict('A portal needs at least one role');
    const { rowCount } = await client.query('DELETE FROM portal_roles WHERE portal_id = $1 AND role_code = $2', [id, roleCode]);
    if (!rowCount) throw notFound(`Role ${roleCode} not found on ${code}`);
    await audit(client, admin, 'PORTAL_ROLE_DELETED', { portal: code, role: roleCode });
    return getPortal(code, client);
  });
}

// ---------------------------------------------------------------------------
// Bulk access
// ---------------------------------------------------------------------------

/**
 * Apply one change to many users on one portal. Each user is its own
 * transaction (same rules and events as a single toggle), so one failure does
 * not undo the others; the response lists per-user outcomes.
 */
export async function bulkSetAccess(code, { user_ids, is_active, role_code }, admin) {
  const results = [];
  for (const userId of [...new Set(user_ids)]) {
    try {
      const r = await setPortalAccess({ user_id: userId, portal_code: code, is_active, role_code }, admin);
      results.push({ user_id: userId, outcome: r.changed ? 'changed' : 'unchanged', event: r.event });
    } catch (err) {
      results.push({ user_id: userId, outcome: 'error', error: err.message });
    }
  }
  const summary = results.reduce((acc, r) => ({ ...acc, [r.outcome]: (acc[r.outcome] ?? 0) + 1 }), {});
  return { summary, results };
}

// ---------------------------------------------------------------------------
// EMS-sourced roles
// ---------------------------------------------------------------------------

async function requireEmsRoles(client) {
  const n = (await client.query('SELECT count(*)::int AS n FROM ems_roles')).rows[0].n;
  if (!n) throw unprocessable('No EMS roles received yet. Run "php artisan sync:ems-users" in the HRMS first.');
}

async function assertOwnRoles(client, portalId) {
  const { rows } = await client.query('SELECT role_source FROM portals WHERE id = $1', [portalId]);
  if (rows[0]?.role_source === 'EMS') throw conflict('Roles of this portal come from EMS. Manage them in the HRMS.');
  if (rows[0]?.role_source === 'PORTAL') throw conflict('Roles of this portal come from the portal itself. Change them there, then fetch again.');
}

/**
 * Portal switched to EMS roles: mirror the EMS catalogue, move every user to
 * the role matching their EMS role, keep auto-assign working, and drop the
 * old hand-made roles nobody uses any more.
 */
async function switchToEmsRoles(client, portalId, oldAutoRole, actor) {
  await syncEmsRolesIntoPortal(client, portalId);
  await alignEmsPortalRoles(client, { portalId, actor, reason: 'ROLE_SOURCE_CHANGED' });

  if (oldAutoRole) {
    const isEms = (
      await client.query('SELECT ems_role_id FROM portal_roles WHERE portal_id = $1 AND role_code = $2', [portalId, oldAutoRole])
    ).rows[0]?.ems_role_id;
    if (!isEms) {
      // Fallback for users whose EMS role is unknown: the most common EMS role on this portal.
      const top = (
        await client.query(
          `SELECT r.role_code FROM portal_roles r
             LEFT JOIN user_portal_access a ON a.portal_id = r.portal_id AND a.assigned_portal_role = r.role_code
            WHERE r.portal_id = $1 AND r.ems_role_id IS NOT NULL
            GROUP BY r.role_code ORDER BY count(a.id) DESC, r.role_code LIMIT 1`,
          [portalId],
        )
      ).rows[0];
      await client.query('UPDATE portals SET auto_grant_role = $2 WHERE id = $1', [portalId, top?.role_code ?? null]);
    }
  }
  // Hand-made roles left without users are removed (sync handles the rule).
  await syncEmsRolesIntoPortal(client, portalId);
}
