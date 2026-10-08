/**
 * Authenticates inbound EMS webhooks.
 *
 * Headers sent by the HRMS (App\Services\Saas\SaasWebhookClient):
 *   X-EMS-Timestamp: <unix seconds>
 *   X-EMS-Signature: v1=<hex hmac-sha256 of "<timestamp>.<raw body>">
 *
 * Requires req.rawBody, captured by express.json({ verify }) in app.js.
 * The signature is computed over the exact bytes received, never over a
 * re-serialised object.
 */
import { env } from '../config/env.js';
import { hmacHex, safeEqualHex } from '../utils/crypto.js';
import { HttpError } from '../utils/errors.js';

export function verifyEmsSignature(req, _res, next) {
  const timestamp = req.get('X-EMS-Timestamp');
  const header = req.get('X-EMS-Signature') ?? '';
  const provided = header.startsWith('v1=') ? header.slice(3) : '';

  if (!timestamp || !provided || !req.rawBody) {
    return next(new HttpError(401, 'SIGNATURE_MISSING', 'Missing webhook signature headers'));
  }

  const ts = Number(timestamp);
  const skew = Math.abs(Math.floor(Date.now() / 1000) - ts);
  if (!Number.isInteger(ts) || skew > env.EMS_WEBHOOK_TOLERANCE_SECONDS) {
    return next(new HttpError(401, 'SIGNATURE_EXPIRED', 'Webhook timestamp outside the allowed window'));
  }

  const expected = hmacHex(env.EMS_WEBHOOK_SECRET, timestamp, req.rawBody);
  if (!safeEqualHex(expected, provided)) {
    return next(new HttpError(401, 'SIGNATURE_INVALID', 'Webhook signature does not match'));
  }

  next();
}
