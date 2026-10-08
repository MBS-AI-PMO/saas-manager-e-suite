/**
 * Authentication endpoints.
 *
 *   POST /api/v1/auth/admin/login   dashboard login -> admin JWT
 *   GET  /api/v1/auth/me            current admin (requires admin JWT)
 *   POST /api/v1/auth/token         user credentials + portal_code -> portal JWT
 *   POST /api/v1/auth/introspect    portal asks "is this token still valid right now?"
 *
 * The JWKS document is mounted separately at GET /.well-known/jwks.json.
 */
import bcrypt from 'bcryptjs';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { query } from '../db/pool.js';
import { requireAdmin } from '../middleware/requireAdmin.js';
import { requirePortal } from '../middleware/requirePortal.js';
import { validateBody } from '../middleware/validate.js';
import { authenticateForPortal, getLiveGrant } from '../services/accessService.js';
import { signAdminToken, signPortalToken, verifyPortalToken } from '../services/tokenService.js';
import { HttpError } from '../utils/errors.js';
import { adminLoginSchema, introspectSchema, portalTokenSchema } from '../validation/schemas.js';

export const authRouter = Router();

// Credential endpoints. Portal backends (e.g. IMS) call /auth/token for all
// their users from ONE server IP, so the tight limit is per account (email),
// with a generous per-IP ceiling against spraying many accounts.
const tooMany = (_req, _res, next) => next(new HttpError(429, 'TOO_MANY_ATTEMPTS', 'Too many attempts, try again later'));
const perAccountLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => `acct:${String(req.body?.email ?? '').trim().toLowerCase()}`,
  handler: tooMany,
});
const perIpLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: 'draft-7', legacyHeaders: false, handler: tooMany });
const credentialLimiter = [perIpLimiter, perAccountLimiter];

const INVALID_CREDENTIALS = () => new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid email, password, or portal access');

// ---------------------------------------------------------------------------
// Dashboard admin login
// ---------------------------------------------------------------------------
authRouter.post('/admin/login', credentialLimiter, validateBody(adminLoginSchema), async (req, res) => {
  const { email, password } = req.valid.body;
  const { rows } = await query(
    `SELECT id, email, full_name, password_hash, saas_admin_role, status
       FROM saas_users WHERE email = $1`,
    [email],
  );
  const admin = rows[0];
  const ok = admin?.password_hash ? await bcrypt.compare(password, admin.password_hash) : false;
  if (!ok || admin.status !== 'ACTIVE' || !admin.saas_admin_role) throw INVALID_CREDENTIALS();

  res.json({
    access_token: signAdminToken(admin),
    token_type: 'Bearer',
    admin: { id: admin.id, email: admin.email, full_name: admin.full_name, role: admin.saas_admin_role },
  });
});

authRouter.get('/me', requireAdmin, (req, res) => {
  res.json({ admin: req.admin });
});

// ---------------------------------------------------------------------------
// Portal token issuance
// ---------------------------------------------------------------------------
authRouter.post('/token', credentialLimiter, validateBody(portalTokenSchema), async (req, res) => {
  const { email, password, portal_code } = req.valid.body;
  const grant = await authenticateForPortal(email, password, portal_code);
  if (!grant) throw INVALID_CREDENTIALS();

  const { token, expiresIn, claims } = signPortalToken(grant);
  res.set('Cache-Control', 'no-store').json({
    access_token: token,
    token_type: 'Bearer',
    expires_in: expiresIn,
    portal: portal_code,
    role: claims.role,
    role_id: claims.role_id,
    permissions: claims.permissions,
  });
});

// ---------------------------------------------------------------------------
// Token introspection (RFC 7662 style) for portals that want a live check.
// The portal authenticates with HTTP Basic: portal_code:webhook_secret.
// ---------------------------------------------------------------------------
authRouter.post('/introspect', requirePortal, validateBody(introspectSchema), async (req, res) => {
  const { portal } = req;

  let claims;
  try {
    claims = verifyPortalToken(req.valid.body.token, portal.portal_code);
  } catch {
    return res.json({ active: false, reason: 'INVALID_OR_EXPIRED' });
  }

  const grant = await getLiveGrant(claims.sub, portal.portal_code);
  if (!grant) return res.json({ active: false, reason: 'NO_ACCESS' });
  if (grant.status !== 'ACTIVE') return res.json({ active: false, reason: 'ACCOUNT_INACTIVE' });
  if (!grant.is_active) return res.json({ active: false, reason: 'PORTAL_ACCESS_INACTIVE' });
  if (grant.access_version !== claims.ver) return res.json({ active: false, reason: 'ACCESS_CHANGED' });

  res.json({
    active: true,
    sub: claims.sub,
    exp: claims.exp,
    portal: portal.portal_code,
    role: grant.role_code,
    permissions: grant.permissions,
    ver: grant.access_version,
  });
});
