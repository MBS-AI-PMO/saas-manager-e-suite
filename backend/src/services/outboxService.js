/**
 * Target-portal event delivery (transactional outbox).
 *
 *  1. enqueuePortalEvents() runs INSIDE the transaction that changes access,
 *     so the event exists if and only if the change committed.
 *  2. startOutboxDispatcher() polls for due events and POSTs them to each
 *     portal's webhook_url with an HMAC signature, retrying with exponential
 *     backoff. Safe to run on several API instances at once (lease-based claim).
 *
 * Ordering: only the OLDEST pending event per (portal, user) pair is eligible,
 * so a portal never sees "revoked" before the "granted" that preceded it,
 * even while a delivery is being retried.
 *
 * Event payload contract: see docs/TARGET_PORTAL_EVENTS.md.
 */
import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { query } from '../db/pool.js';
import { hmacHex } from '../utils/crypto.js';
import { logger } from '../utils/logger.js';

export const EVENT_API_VERSION = '2026-10-01';

export const EventType = Object.freeze({
  ACCESS_GRANTED: 'access.granted',
  ACCESS_REVOKED: 'access.revoked',
  ACCESS_ROLE_CHANGED: 'access.role_changed',
  USER_UPDATED: 'user.updated',
});

/**
 * Snapshot the current state of a user's access on the given portals and
 * write one outbox row per portal. Portals without a webhook_url or that are
 * disabled are skipped: they rely on short-lived tokens + /auth/introspect.
 *
 * @param {import('pg').PoolClient} client  Caller's transaction
 * @param {object} args
 * @param {string}   args.userId
 * @param {string[]} [args.portalIds]  Default: every portal the user has a row for
 * @param {string}   args.type         One of EventType
 * @param {string}   args.reason       e.g. ADMIN_ACTION, EMS_DEACTIVATED
 * @param {Record<string, {is_active:boolean, role:string}>} [args.previous]  keyed by portal_id
 * @param {{ id?: string|null, label: string }} args.actor
 * @returns {Promise<number>} rows enqueued
 */
export async function enqueuePortalEvents(client, { userId, portalIds, type, reason, previous = {}, actor }) {
  const { rows } = await client.query(
    `SELECT u.id AS user_id, u.ems_user_id, u.email, u.full_name, u.source, u.status AS account_status,
            u.staff_id, d.dept_name, g.designation_name, u.deployed_project, u.deployed_location,
            p.id AS portal_id, p.portal_code,
            a.assigned_portal_role AS role_code, a.is_active, a.access_version,
            r.role_name, r.permissions, r.ems_role_id, r.external_role_id, p.role_source
       FROM user_portal_access a
       JOIN saas_users   u ON u.id = a.user_id
       JOIN portals      p ON p.id = a.portal_id
       JOIN portal_roles r ON r.portal_id = a.portal_id AND r.role_code = a.assigned_portal_role
       LEFT JOIN departments  d ON d.id = u.department_id
       LEFT JOIN designations g ON g.id = u.designation_id
      WHERE a.user_id = $1
        AND ($2::uuid[] IS NULL OR a.portal_id = ANY($2::uuid[]))
        AND p.is_enabled AND p.webhook_url IS NOT NULL`,
    [userId, portalIds ?? null],
  );

  for (const row of rows) {
    const effectiveActive = row.account_status === 'ACTIVE' && row.is_active;
    const prev = previous[row.portal_id];
    const payload = {
      id: crypto.randomUUID(),
      type,
      api_version: EVENT_API_VERSION,
      occurred_at: new Date().toISOString(),
      reason,
      portal: { code: row.portal_code },
      user: {
        id: row.user_id,
        ems_user_id: row.ems_user_id,
        staff_id: row.staff_id,
        email: row.email,
        full_name: row.full_name,
        source: row.source,
        department: row.dept_name,
        designation: row.designation_name,
        deployed_project: row.deployed_project,
        deployed_location: row.deployed_location,
      },
      access: {
        status: effectiveActive ? 'ACTIVE' : 'INACTIVE',
        portal_flag_active: row.is_active,
        account_status: row.account_status,
        // ems_role_id is set on portals whose roles mirror EMS (EMS applies it on role changes).
        // external_id: the portal's own role id (portals whose roles are fetched from them).
        role: { code: row.role_code, name: row.role_name, permissions: row.permissions, ems_role_id: row.ems_role_id, external_id: row.external_role_id },
        version: row.access_version,
        previous: prev ? { status: prev.is_active ? 'ACTIVE' : 'INACTIVE', role: prev.role } : null,
      },
      // What the portal is expected to do on receipt.
      directives: {
        terminate_sessions: !effectiveActive,
        reject_tokens_with_version_below: row.access_version,
      },
      actor: { id: actor.id ?? null, label: actor.label },
    };

    await client.query(
      `INSERT INTO portal_sync_events (id, portal_id, user_id, event_type, payload)
       VALUES ($1, $2, $3, $4, $5)`,
      [payload.id, row.portal_id, row.user_id, type, JSON.stringify(payload)],
    );
  }
  return rows.length;
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

const LEASE_SECONDS = 120;

/** Exponential backoff: 30s, 1m, 2m, 4m ... capped at 1h. */
function backoffSeconds(attempts) {
  return Math.min(30 * 2 ** Math.max(0, attempts - 1), 3600);
}

/**
 * Atomically claim up to `limit` due events. The lease (pushing
 * next_attempt_at into the future) means a crashed worker's events become
 * due again after LEASE_SECONDS. The re-checked `next_attempt_at <= now()` in
 * the UPDATE stops two instances from claiming the same row.
 */
async function claimDueEvents(limit) {
  const { rows } = await query(
    `WITH heads AS (
         SELECT DISTINCT ON (portal_id, user_id) id, next_attempt_at
           FROM portal_sync_events
          WHERE status = 'PENDING'
          ORDER BY portal_id, user_id, created_at
     ), due AS (
         SELECT id FROM heads WHERE next_attempt_at <= now() LIMIT $1
     )
     UPDATE portal_sync_events e
        SET attempts = e.attempts + 1,
            next_attempt_at = now() + make_interval(secs => $2)
       FROM due
      WHERE e.id = due.id
        AND e.status = 'PENDING'
        AND e.next_attempt_at <= now()
  RETURNING e.id, e.portal_id, e.event_type, e.payload, e.attempts`,
    [limit, LEASE_SECONDS],
  );
  return rows;
}

async function deliver(event, portal) {
  const body = JSON.stringify(event.payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = hmacHex(portal.webhook_secret ?? '', timestamp, body);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.OUTBOX_HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(portal.webhook_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'SaaS-Identity-Center/1.0',
        'X-IAM-Event-Id': event.id,
        'X-IAM-Event-Type': event.event_type,
        'X-IAM-Timestamp': timestamp,
        'X-IAM-Signature': `v1=${signature}`,
      },
      body,
      signal: controller.signal,
      redirect: 'error',
    });
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 500);
      throw new Error(`HTTP ${res.status}${text ? `: ${text}` : ''}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

async function processEvent(event) {
  const { rows } = await query(
    'SELECT portal_code, webhook_url, webhook_secret, is_enabled FROM portals WHERE id = $1',
    [event.portal_id],
  );
  const portal = rows[0];

  if (!portal || !portal.is_enabled || !portal.webhook_url) {
    await query(
      `UPDATE portal_sync_events SET status = 'FAILED', last_error = $2 WHERE id = $1`,
      [event.id, 'Portal disabled or has no webhook_url'],
    );
    return;
  }

  try {
    await deliver(event, portal);
    await query(
      `UPDATE portal_sync_events SET status = 'DELIVERED', delivered_at = now(), last_error = NULL WHERE id = $1`,
      [event.id],
    );
    logger.info('Portal event delivered', { event_id: event.id, portal: portal.portal_code, type: event.event_type });
  } catch (err) {
    const message = err.name === 'AbortError' ? 'Timed out' : err.message;
    const exhausted = event.attempts >= env.OUTBOX_MAX_ATTEMPTS;
    await query(
      `UPDATE portal_sync_events
          SET status = $2::outbox_status,
              last_error = $3,
              next_attempt_at = now() + make_interval(secs => $4)
        WHERE id = $1`,
      [event.id, exhausted ? 'FAILED' : 'PENDING', message.slice(0, 1000), backoffSeconds(event.attempts)],
    );
    logger[exhausted ? 'error' : 'warn']('Portal event delivery failed', {
      event_id: event.id,
      portal: portal.portal_code,
      attempts: event.attempts,
      exhausted,
      error: message,
    });
  }
}

/**
 * Start polling. Returns a stop() function for graceful shutdown that waits
 * for the in-flight batch to finish.
 */
export function startOutboxDispatcher() {
  let stopped = false;
  let running = null;
  let timer = null;

  const tick = async () => {
    if (stopped) return;
    try {
      const events = await claimDueEvents(env.OUTBOX_BATCH_SIZE);
      // Different (portal,user) heads are independent, so deliver in parallel.
      await Promise.allSettled(events.map(processEvent));
    } catch (err) {
      logger.error('Outbox dispatcher tick failed', { error: err.message });
    }
    if (!stopped) timer = setTimeout(() => (running = tick()), env.OUTBOX_POLL_INTERVAL_MS);
  };

  running = tick();
  logger.info('Outbox dispatcher started', { interval_ms: env.OUTBOX_POLL_INTERVAL_MS });

  return async function stop() {
    stopped = true;
    clearTimeout(timer);
    await running;
  };
}
