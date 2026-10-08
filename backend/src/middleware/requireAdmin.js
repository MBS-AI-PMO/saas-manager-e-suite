/**
 * Protects dashboard endpoints. Expects `Authorization: Bearer <admin JWT>`
 * minted by POST /api/v1/auth/admin/login.
 *
 * The admin's row is re-read on every request, so removing someone's
 * saas_admin_role or deactivating them takes effect immediately instead of
 * after the token expires.
 */
import { query } from '../db/pool.js';
import { verifyAdminToken } from '../services/tokenService.js';
import { forbidden, unauthorized } from '../utils/errors.js';

export async function requireAdmin(req, _res, next) {
  const header = req.get('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next(unauthorized());

  let claims;
  try {
    claims = verifyAdminToken(token);
  } catch {
    return next(unauthorized('Invalid or expired session'));
  }

  const { rows } = await query(
    `SELECT id, email, full_name, saas_admin_role, status
       FROM saas_users WHERE id = $1`,
    [claims.sub],
  );
  const admin = rows[0];
  if (!admin || admin.status !== 'ACTIVE' || !admin.saas_admin_role) {
    return next(forbidden('Admin access revoked'));
  }

  req.admin = admin;
  next();
}
