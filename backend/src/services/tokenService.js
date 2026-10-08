/**
 * JWT issuance and verification (RS256).
 *
 * Why RS256: target portals (React/Vue/Node/PHP) only need the PUBLIC key,
 * fetched from GET /.well-known/jwks.json, to verify tokens. A compromised
 * portal can therefore never mint tokens for another portal.
 *
 * Two audiences share one key pair:
 *   aud = "saas-manager"  -> dashboard admin sessions
 *   aud = <PORTAL_CODE>   -> target-portal access tokens
 */
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

export const ADMIN_AUDIENCE = 'saas-manager';
const ALG = 'RS256';

/** Admin session token for the SaaS Manager dashboard. */
export function signAdminToken(admin) {
  return jwt.sign(
    { email: admin.email, name: admin.full_name, admin_role: admin.saas_admin_role },
    env.jwtPrivateKey,
    {
      algorithm: ALG,
      keyid: env.JWT_KEY_ID,
      issuer: env.JWT_ISSUER,
      audience: ADMIN_AUDIENCE,
      subject: admin.id,
      expiresIn: env.ADMIN_TOKEN_TTL_SECONDS,
      jwtid: crypto.randomUUID(),
    },
  );
}

export function verifyAdminToken(token) {
  return jwt.verify(token, env.jwtPublicKey, {
    algorithms: [ALG],
    issuer: env.JWT_ISSUER,
    audience: ADMIN_AUDIENCE,
  });
}

/**
 * Portal access token.
 *
 * @param {object} grant  Row from accessService.getActiveGrant()
 * @returns {{ token: string, expiresIn: number, claims: object }}
 */
export function signPortalToken(grant) {
  const claims = {
    email: grant.email,
    name: grant.full_name,
    src: grant.source, // 'EMS' | 'DIRECT_SAAS'
    ems_user_id: grant.ems_user_id,
    department: grant.dept_name,
    designation: grant.designation_name,
    portal: grant.portal_code,
    role: grant.role_code, // portal-specific role, never the EMS role
    role_id: grant.external_role_id ?? null, // the portal's own role id, when roles are fetched from the portal
    permissions: grant.permissions,
    // Matches user_portal_access.access_version. A portal that received an
    // access.* event with a higher version must reject this token.
    ver: grant.access_version,
  };

  const token = jwt.sign(claims, env.jwtPrivateKey, {
    algorithm: ALG,
    keyid: env.JWT_KEY_ID,
    issuer: env.JWT_ISSUER,
    audience: grant.portal_code,
    subject: grant.user_id,
    expiresIn: env.PORTAL_TOKEN_TTL_SECONDS,
    jwtid: crypto.randomUUID(),
  });

  return { token, expiresIn: env.PORTAL_TOKEN_TTL_SECONDS, claims };
}

/** Verify a portal token's signature/issuer/expiry; audience must match. */
export function verifyPortalToken(token, expectedPortalCode) {
  return jwt.verify(token, env.jwtPublicKey, {
    algorithms: [ALG],
    issuer: env.JWT_ISSUER,
    audience: expectedPortalCode,
  });
}

/** Public key set for portals (RFC 7517). Computed once. */
const jwks = (() => {
  const jwk = crypto.createPublicKey(env.jwtPublicKey).export({ format: 'jwk' });
  return { keys: [{ ...jwk, kid: env.JWT_KEY_ID, alg: ALG, use: 'sig' }] };
})();

export function getJwks() {
  return jwks;
}
