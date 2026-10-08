/**
 * POST /api/v1/webhooks/ems-user
 *
 * Receives user changes from the EMS (Laravel HRMS). Both real-time observer
 * pushes and `php artisan sync:ems-users` batches use this endpoint.
 *
 * Response is always 200 when the request is authentic and well-formed, with
 * a per-record outcome. EMS retries the whole request only on non-2xx (auth,
 * validation, or server failure); record-level errors are reported, not retried.
 */
import { Router } from 'express';
import { verifyEmsSignature } from '../middleware/verifyEmsSignature.js';
import { validateBody } from '../middleware/validate.js';
import { upsertEmsRoles } from '../services/emsRoleService.js';
import { deactivateEmsUsers, upsertEmsUser } from '../services/userService.js';
import { logger } from '../utils/logger.js';
import { emsWebhookSchema } from '../validation/schemas.js';

export const webhooksRouter = Router();

webhooksRouter.post('/ems-user', verifyEmsSignature, validateBody(emsWebhookSchema), async (req, res) => {
  const { event_id, event, occurred_at, data } = req.valid.body;
  const occurredAt = new Date(occurred_at);

  if (event === 'roles.synced') {
    const summary = await upsertEmsRoles(data.roles, event_id);
    logger.info('EMS roles synced', { event_id, ...summary });
    return res.json({ event_id, processed: data.roles.length, summary, results: [] });
  }

  let results;
  if (event === 'user.upserted') {
    // Sequential on purpose: keeps DB load predictable for 200-record batches
    // and preserves order if the same user appears twice in one batch.
    results = [];
    for (const user of data.users) results.push(await upsertEmsUser(user, occurredAt, event_id));
  } else {
    results = await deactivateEmsUsers(data.ems_user_ids, occurredAt, event_id);
  }

  const summary = results.reduce((acc, r) => ({ ...acc, [r.outcome]: (acc[r.outcome] ?? 0) + 1 }), {});
  const errors = results.filter((r) => r.outcome === 'error');
  if (errors.length) logger.warn('EMS webhook had record errors', { event_id, errors });
  logger.info('EMS webhook processed', { event_id, event, summary });

  res.json({ event_id, processed: results.length, summary, results });
});
