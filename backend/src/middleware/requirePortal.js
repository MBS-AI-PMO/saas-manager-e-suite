/**
 * Authenticates a target portal calling the Identity Center
 * (introspection, full access re-sync).
 *
 *   Authorization: Basic base64("<PORTAL_CODE>:<webhook_secret>")
 *
 * Sets req.portal = { id, portal_code }.
 */
import { query } from '../db/pool.js';
import { safeEqualString } from '../utils/crypto.js';
import { unauthorized } from '../utils/errors.js';

export async function requirePortal(req, _res, next) {
  const header = req.get('Authorization') ?? '';
  if (!header.startsWith('Basic ')) return next(unauthorized('Portal credentials required'));

  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const sep = decoded.indexOf(':');
  const code = decoded.slice(0, sep).toUpperCase();
  const secret = decoded.slice(sep + 1);

  const { rows } = await query('SELECT id, portal_code, webhook_secret, is_enabled FROM portals WHERE portal_code = $1', [code]);
  const portal = rows[0];
  if (sep < 1 || !portal?.webhook_secret || !portal.is_enabled || !safeEqualString(portal.webhook_secret, secret)) {
    return next(unauthorized('Invalid portal credentials'));
  }

  req.portal = { id: portal.id, portal_code: portal.portal_code };
  next();
}
