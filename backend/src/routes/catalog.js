/**
 * Dashboard administration API (admin JWT required; mounted behind requireAdmin).
 *
 *   GET    /api/v1/overview                          KPIs + delivery health
 *   GET    /api/v1/activity                          recent admin actions
 *   GET    /api/v1/departments | /designations
 *
 *   GET    /api/v1/portals                           portals + roles + counts
 *   POST   /api/v1/portals                           register a portal (returns webhook secret once)
 *   GET    /api/v1/portals/:code
 *   PATCH  /api/v1/portals/:code                     name, URLs, enable/disable
 *   DELETE /api/v1/portals/:code                     only when nobody has access
 *   POST   /api/v1/portals/:code/rotate-secret       new webhook secret (returned once)
 *   POST   /api/v1/portals/:code/roles               add role
 *   PATCH  /api/v1/portals/:code/roles/:role         rename / change permissions
 *   DELETE /api/v1/portals/:code/roles/:role         only when unused
 *   POST   /api/v1/portals/:code/access/bulk         activate / deactivate / set role for many users
 */
import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { validateBody } from '../middleware/validate.js';
import { listDepartments, listDesignations } from '../services/lookupService.js';
import { getOverview, getRecentActivity } from '../services/overviewService.js';
import {
  addPortalRole,
  bulkSetAccess,
  createPortal,
  deletePortal,
  deletePortalRole,
  getPortal,
  listPortals,
  rotatePortalSecret,
  updatePortal,
  updatePortalRole,
} from '../services/portalService.js';
import { refreshPortalRoles } from '../services/portalRoleService.js';
import { badRequest } from '../utils/errors.js';
import {
  bulkAccessSchema,
  createPortalSchema,
  portalRoleSchema,
  updatePortalRoleSchema,
  updatePortalSchema,
} from '../validation/schemas.js';

export const catalogRouter = Router();

const CODE = /^[A-Z0-9_]{2,50}$/;
/** Normalise and validate :code / :role path params. */
function param(req, name) {
  const v = String(req.params[name] ?? '').toUpperCase();
  if (!CODE.test(v)) throw badRequest(`Invalid ${name}`);
  return v;
}

// --- overview ---------------------------------------------------------------
catalogRouter.get('/overview', async (_req, res) => {
  res.json({ data: await getOverview() });
});

catalogRouter.get('/activity', async (req, res) => {
  const limit = z.coerce.number().int().min(1).max(100).catch(15).parse(req.query.limit);
  res.json({ data: await getRecentActivity(limit) });
});

catalogRouter.get('/departments', async (_req, res) => {
  res.json({ data: await listDepartments({ query }) });
});

catalogRouter.get('/designations', async (_req, res) => {
  res.json({ data: await listDesignations({ query }) });
});

// EMS role catalogue with how many EMS users hold each role.
catalogRouter.get('/ems-roles', async (_req, res) => {
  const { rows } = await query(
    `SELECT e.ems_id, e.role_name,
            (SELECT count(*)::int FROM saas_users u WHERE u.source = 'EMS' AND u.ems_role_id = e.ems_id) AS user_count
       FROM ems_roles e ORDER BY e.role_name`,
  );
  res.json({ data: rows });
});

// --- portals ----------------------------------------------------------------
catalogRouter.get('/portals', async (_req, res) => {
  res.json({ data: await listPortals() });
});

/**
 * Try to fetch roles from a PORTAL-sourced portal; never fails the caller.
 * A brand-new portal usually rejects the first fetch (it does not have the
 * secret yet); the error is shown in the dashboard with a "Fetch roles" button.
 */
async function tryFetchRoles(portalId, actorLabel) {
  try {
    return { ok: true, ...(await refreshPortalRoles(portalId, actorLabel)) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

catalogRouter.post('/portals', validateBody(createPortalSchema), async (req, res) => {
  const result = await createPortal(req.valid.body, req.admin);
  const rolesFetch = req.valid.body.role_source === 'PORTAL' ? await tryFetchRoles(result.portal.id, req.admin.email) : undefined;
  const portal = rolesFetch ? await getPortal(result.portal.portal_code) : result.portal;
  res.status(201).set('Cache-Control', 'no-store').json({ data: portal, webhook_secret: result.webhook_secret, roles_fetch: rolesFetch });
});

catalogRouter.get('/portals/:code', async (req, res) => {
  res.json({ data: await getPortal(param(req, 'code')) });
});

catalogRouter.patch('/portals/:code', validateBody(updatePortalSchema), async (req, res) => {
  const updated = await updatePortal(param(req, 'code'), req.valid.body, req.admin);
  // Switched to portal roles, or pointed at a new roles URL: fetch right away.
  const b = req.valid.body;
  const rolesFetch =
    updated.role_source === 'PORTAL' && (b.role_source === 'PORTAL' || 'roles_url' in b) ? await tryFetchRoles(updated.id, req.admin.email) : undefined;
  res.json({ data: rolesFetch ? { ...(await getPortal(updated.portal_code)), auto_granted: updated.auto_granted } : updated, roles_fetch: rolesFetch });
});

catalogRouter.post('/portals/:code/refresh-roles', async (req, res) => {
  const portal = await getPortal(param(req, 'code'));
  const stats = await refreshPortalRoles(portal.id, req.admin.email);
  res.json({ data: await getPortal(portal.portal_code), stats });
});

catalogRouter.delete('/portals/:code', async (req, res) => {
  await deletePortal(param(req, 'code'), req.admin);
  res.status(204).end();
});

catalogRouter.post('/portals/:code/rotate-secret', async (req, res) => {
  res.set('Cache-Control', 'no-store').json(await rotatePortalSecret(param(req, 'code'), req.admin));
});

catalogRouter.post('/portals/:code/roles', validateBody(portalRoleSchema), async (req, res) => {
  res.status(201).json({ data: await addPortalRole(param(req, 'code'), req.valid.body, req.admin) });
});

catalogRouter.patch('/portals/:code/roles/:role', validateBody(updatePortalRoleSchema), async (req, res) => {
  res.json({ data: await updatePortalRole(param(req, 'code'), param(req, 'role'), req.valid.body, req.admin) });
});

catalogRouter.delete('/portals/:code/roles/:role', async (req, res) => {
  res.json({ data: await deletePortalRole(param(req, 'code'), param(req, 'role'), req.admin) });
});

catalogRouter.post('/portals/:code/access/bulk', validateBody(bulkAccessSchema), async (req, res) => {
  res.json(await bulkSetAccess(param(req, 'code'), req.valid.body, req.admin));
});
