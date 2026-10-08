/**
 * Endpoints a target portal calls with its own credentials (requirePortal).
 *
 *   GET /api/v1/portal-sync/access
 *
 * Returns the complete current access list for the calling portal. Portals
 * use it for the initial load and as a periodic safety net, in case a webhook
 * event was missed. Same fields as the access.* webhook events.
 */
import { Router } from 'express';
import { query } from '../db/pool.js';
import { requirePortal } from '../middleware/requirePortal.js';
import { applyPortalRoles, parseRolesPayload } from '../services/portalRoleService.js';

export const portalSyncRouter = Router();

/**
 * POST /api/v1/portal-sync/roles
 * The portal pushes its full role catalogue (same format as its roles URL),
 * e.g. right after an admin there adds or renames a role.
 */
portalSyncRouter.post('/roles', requirePortal, async (req, res) => {
  const roles = parseRolesPayload(req.body);
  const stats = await applyPortalRoles(req.portal.id, roles, `PORTAL:${req.portal.portal_code}`);
  res.json({ portal: req.portal.portal_code, ...stats });
});

portalSyncRouter.get('/access', requirePortal, async (req, res) => {
  const { rows } = await query(
    `SELECT u.id AS user_id, u.ems_user_id, u.email, u.full_name, u.source, u.status AS account_status,
            a.is_active AS portal_flag_active, a.assigned_portal_role AS role_code, a.access_version,
            r.role_name, r.permissions, r.external_role_id AS role_id, a.updated_at
       FROM user_portal_access a
       JOIN saas_users u   ON u.id = a.user_id
       JOIN portal_roles r ON r.portal_id = a.portal_id AND r.role_code = a.assigned_portal_role
      WHERE a.portal_id = $1
      ORDER BY u.ems_user_id NULLS LAST, u.email`,
    [req.portal.id],
  );

  res.set('Cache-Control', 'no-store').json({
    portal: req.portal.portal_code,
    generated_at: new Date().toISOString(),
    data: rows.map((r) => ({
      ...r,
      // Same rule as the webhook payload: ACTIVE only if account and portal flag are both on.
      status: r.account_status === 'ACTIVE' && r.portal_flag_active ? 'ACTIVE' : 'INACTIVE',
    })),
  });
});
