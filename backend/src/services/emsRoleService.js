/**
 * EMS role mirroring for portals with role_source = 'EMS' (e.g. the HRMS).
 *
 *   - upsertEmsRoles(): EMS sent its role catalogue -> store it and refresh
 *     every EMS-sourced portal's role list.
 *   - syncEmsRolesIntoPortal(): make one portal's roles match ems_roles.
 *   - alignEmsPortalRoles(): set users' role on EMS-sourced portals to the
 *     role that matches their EMS role (after an EMS change).
 *
 * Writing an admin's change back to EMS happens on the EMS side: the
 * access.role_changed event carries role.ems_role_id.
 */
import { withTransaction } from '../db/pool.js';
import { writeAudit } from './auditService.js';
import { EventType, enqueuePortalEvents } from './outboxService.js';
import { mirrorRoles } from './roleMirror.js';

export { toRoleCode } from './roleMirror.js';

/**
 * @param {{ ems_id: number, name: string }[]} roles  full EMS catalogue
 */
export async function upsertEmsRoles(roles, eventId) {
  return withTransaction(async (client) => {
    for (const r of roles) {
      await client.query(
        `INSERT INTO ems_roles (ems_id, role_name) VALUES ($1, $2)
         ON CONFLICT (ems_id) DO UPDATE SET role_name = EXCLUDED.role_name, updated_at = now()
           WHERE ems_roles.role_name <> EXCLUDED.role_name`,
        [r.ems_id, r.name],
      );
    }
    const ids = roles.map((r) => r.ems_id);
    await client.query('DELETE FROM ems_roles WHERE NOT (ems_id = ANY($1::int[]))', [ids]);

    const portals = (await client.query(`SELECT id FROM portals WHERE role_source = 'EMS'`)).rows;
    for (const p of portals) await syncEmsRolesIntoPortal(client, p.id);

    await writeAudit(client, { actorLabel: 'EMS_WEBHOOK', action: 'EMS_ROLES_SYNCED', details: { count: roles.length, event_id: eventId } });
    return { roles: roles.length, portals: portals.length };
  });
}

/** Make one portal's role catalogue mirror ems_roles. Roles still in use are kept. */
export async function syncEmsRolesIntoPortal(client, portalId) {
  const ems = (await client.query('SELECT ems_id, role_name FROM ems_roles ORDER BY ems_id')).rows;
  // EMS sends no permissions, so existing permission lists are left alone.
  return mirrorRoles(client, portalId, ems.map((r) => ({ ref: r.ems_id, name: r.role_name })), 'ems_role_id');
}

/**
 * Set the role on EMS-sourced portals to the one matching each user's EMS role.
 * Scope with userId (one person changed in EMS) or portalId (portal just switched).
 * Users whose EMS role has no matching portal role keep their current role.
 */
export async function alignEmsPortalRoles(client, { userId = null, portalId = null, actor, reason = 'EMS_ROLE_CHANGED' }) {
  const { rows } = await client.query(
    `UPDATE user_portal_access a
        SET assigned_portal_role = r.role_code, access_version = a.access_version + 1
       FROM saas_users u, portals p, portal_roles r
      WHERE a.user_id = u.id AND a.portal_id = p.id
        AND p.role_source = 'EMS'
        AND r.portal_id = p.id AND r.ems_role_id = u.ems_role_id
        AND a.assigned_portal_role <> r.role_code
        AND ($1::uuid IS NULL OR a.user_id = $1)
        AND ($2::uuid IS NULL OR a.portal_id = $2)
    RETURNING a.user_id, a.portal_id, a.is_active`,
    [userId, portalId],
  );
  for (const r of rows.filter((x) => x.is_active)) {
    await enqueuePortalEvents(client, { userId: r.user_id, portalIds: [r.portal_id], type: EventType.ACCESS_ROLE_CHANGED, reason, actor });
  }
  return rows.length;
}
