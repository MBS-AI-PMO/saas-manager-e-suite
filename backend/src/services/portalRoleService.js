/**
 * Roles fetched from the portal itself (role_source = 'PORTAL').
 *
 * Pull: GET <portals.roles_url>, signed like our webhooks:
 *   X-IAM-Timestamp: <unix seconds>
 *   X-IAM-Signature: v1=hex(HMAC_SHA256(webhook_secret, "<timestamp>."))   (empty body)
 *
 * Push: the portal POSTs the same payload to /api/v1/portal-sync/roles.
 *
 * Accepted payloads (lenient, to fit any stack):
 *   { "roles": [ { "id": "editor", "name": "Editor", "permissions": ["post.edit"] } ] }
 *   { "data":  [ ... ] }   or a bare array   [ ... ]
 *   id    <- id | code | key | slug | value
 *   name  <- name | label | title | display_name   (falls back to id)
 *   permissions <- permissions | abilities | scopes   (array of strings, or objects with name)
 */
import { env } from '../config/env.js';
import { query, withTransaction } from '../db/pool.js';
import { hmacHex } from '../utils/crypto.js';
import { HttpError, unprocessable } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { writeAudit } from './auditService.js';
import { mirrorRoles } from './roleMirror.js';

const MAX_BYTES = 1_000_000;
const MAX_ROLES = 500;

/**
 * Normalise any accepted payload into [{ ref, name, permissions }].
 * Throws HttpError(422) with a readable message on bad shape.
 */
export function parseRolesPayload(payload) {
  const list = Array.isArray(payload) ? payload : (payload?.roles ?? payload?.data);
  if (!Array.isArray(list)) throw unprocessable('Roles response must be an array, or an object with a "roles" array');
  if (list.length > MAX_ROLES) throw unprocessable(`Too many roles (max ${MAX_ROLES})`);

  const seen = new Set();
  const roles = [];
  for (const [i, raw] of list.entries()) {
    const item = typeof raw === 'string' ? { id: raw } : raw ?? {};
    const ref = item.id ?? item.code ?? item.key ?? item.slug ?? item.value;
    if (ref === undefined || ref === null || String(ref).trim() === '') throw unprocessable(`Role #${i + 1} has no id`);
    const refStr = String(ref).trim().slice(0, 100);
    if (seen.has(refStr)) throw unprocessable(`Duplicate role id "${refStr}"`);
    seen.add(refStr);

    const name = String(item.name ?? item.label ?? item.title ?? item.display_name ?? refStr).trim().slice(0, 100);
    const rawPerms = item.permissions ?? item.abilities ?? item.scopes ?? [];
    const permissions = (Array.isArray(rawPerms) ? rawPerms : [])
      .map((p) => (typeof p === 'string' ? p : (p?.name ?? p?.code ?? p?.slug)))
      .filter((p) => typeof p === 'string' && p.trim())
      .map((p) => p.trim().slice(0, 100))
      .slice(0, 200);

    roles.push({ ref: refStr, name: name || refStr, permissions });
  }
  return roles;
}

/** GET the portal's roles endpoint. Returns parsed roles or throws HttpError. */
async function fetchRoles(portal) {
  if (!portal.roles_url) throw unprocessable('This portal has no roles URL');
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = hmacHex(portal.webhook_secret ?? '', timestamp, '');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.OUTBOX_HTTP_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(portal.roles_url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'SaaS-Identity-Center/1.0',
        'X-IAM-Portal': portal.portal_code,
        'X-IAM-Timestamp': timestamp,
        'X-IAM-Signature': `v1=${signature}`,
      },
      signal: controller.signal,
      redirect: 'error',
    });
  } catch (err) {
    throw new HttpError(502, 'PORTAL_UNREACHABLE', err.name === 'AbortError' ? 'The portal did not answer in time' : `Cannot reach the portal: ${err.cause?.code ?? err.message}`);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  if (text.length > MAX_BYTES) throw new HttpError(502, 'PORTAL_BAD_RESPONSE', 'Roles response is too large');
  if (!res.ok) {
    const hint = res.status === 401 || res.status === 403 ? ' (has the portal been given the webhook secret?)' : '';
    throw new HttpError(502, 'PORTAL_BAD_RESPONSE', `The portal answered HTTP ${res.status}${hint}`);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new HttpError(502, 'PORTAL_BAD_RESPONSE', 'The portal did not return JSON');
  }
  return parseRolesPayload(json);
}

/**
 * Store a role catalogue for a PORTAL-sourced portal and record the sync result.
 * @returns {Promise<{ roles: number, added: number, renamed: number, removed: number, kept_in_use: number }>}
 */
export async function applyPortalRoles(portalId, roles, actorLabel) {
  return withTransaction(async (client) => {
    const p = (await client.query('SELECT portal_code, role_source FROM portals WHERE id = $1 FOR UPDATE', [portalId])).rows[0];
    if (p?.role_source !== 'PORTAL') throw new HttpError(409, 'CONFLICT', 'This portal does not take its roles from the portal');
    const stats = await mirrorRoles(client, portalId, roles, 'external_role_id');
    await client.query('UPDATE portals SET roles_synced_at = now(), roles_sync_error = NULL WHERE id = $1', [portalId]);
    await writeAudit(client, { actorLabel, action: 'PORTAL_ROLES_SYNCED', details: { portal: p.portal_code, roles: roles.length, ...stats } });
    return { roles: roles.length, ...stats };
  });
}

/**
 * Pull roles from the portal now. On failure the error is stored on the
 * portal (shown in the dashboard) and re-thrown.
 */
export async function refreshPortalRoles(portalId, actorLabel = 'SYSTEM') {
  const portal = (
    await query('SELECT id, portal_code, roles_url, webhook_secret, role_source FROM portals WHERE id = $1', [portalId])
  ).rows[0];
  if (!portal) throw new HttpError(404, 'NOT_FOUND', 'Portal not found');
  if (portal.role_source !== 'PORTAL') throw new HttpError(409, 'CONFLICT', 'This portal does not take its roles from the portal');

  try {
    const roles = await fetchRoles(portal);
    return await applyPortalRoles(portal.id, roles, actorLabel);
  } catch (err) {
    await query('UPDATE portals SET roles_sync_error = $2 WHERE id = $1', [portal.id, String(err.message).slice(0, 500)]);
    throw err;
  }
}

/** Background refresh of every enabled PORTAL-sourced portal. Never throws. */
export async function refreshAllPortalRoles() {
  const { rows } = await query(`SELECT id, portal_code FROM portals WHERE role_source = 'PORTAL' AND is_enabled AND roles_url IS NOT NULL`);
  for (const p of rows) {
    try {
      await refreshPortalRoles(p.id, 'SCHEDULED_ROLE_SYNC');
    } catch (err) {
      logger.warn('Scheduled role refresh failed', { portal: p.portal_code, error: err.message });
    }
  }
}

export function startPortalRoleRefresher(intervalMs = Number(process.env.ROLES_REFRESH_INTERVAL_MS ?? 15 * 60_000)) {
  const timer = setInterval(() => void refreshAllPortalRoles(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
