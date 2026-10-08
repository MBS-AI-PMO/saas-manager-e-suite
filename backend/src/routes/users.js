/**
 * Dashboard user-management API (admin JWT required; mounted behind requireAdmin).
 *
 *   GET  /api/v1/users                 list + search, with each user's portal access
 *   GET  /api/v1/users/:id             one user
 *   POST /api/v1/users                 create a DIRECT_SAAS user
 *   POST /api/v1/users/portal-access   toggle ACTIVE/INACTIVE and/or assign a portal role
 */
import { Router } from 'express';
import { z } from 'zod';
import { validateBody, validateQuery } from '../middleware/validate.js';
import { setPortalAccess } from '../services/accessService.js';
import { createDirectUser, getUserById, listUsers } from '../services/userService.js';
import { badRequest } from '../utils/errors.js';
import { createUserSchema, listUsersQuerySchema, portalAccessSchema } from '../validation/schemas.js';

export const usersRouter = Router();

usersRouter.get('/', validateQuery(listUsersQuerySchema), async (req, res) => {
  res.json(await listUsers(req.valid.query));
});

// Declared before "/:id" so "portal-access" is never treated as an id.
usersRouter.post('/portal-access', validateBody(portalAccessSchema), async (req, res) => {
  const result = await setPortalAccess(req.valid.body, req.admin);
  const user = await getUserById(req.valid.body.user_id);
  res.json({ changed: result.changed, event: result.event, user });
});

usersRouter.get('/:id', async (req, res) => {
  if (!z.string().uuid().safeParse(req.params.id).success) throw badRequest('id must be a UUID');
  res.json({ data: await getUserById(req.params.id) });
});

usersRouter.post('/', validateBody(createUserSchema), async (req, res) => {
  const user = await createDirectUser(req.valid.body, req.admin);
  res.status(201).location(`/api/v1/users/${user.id}`).json({ data: user });
});
