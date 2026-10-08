/**
 * Per-portal access governance (the ACTIVE/INACTIVE toggle and role dropdown
 * in the dashboard), plus the lookups used to mint and introspect portal tokens.
 */
import bcrypt from 'bcryptjs';
import { query, withTransaction } from '../db/pool.js';
import { conflict, notFound, unprocessable } from '../utils/errors.js';
import { writeAudit } from './auditService.js';
import { EventType, enqueuePortalEvents } from './outboxService.js';

/**
 * Create or update one user's access to one portal.
 *
 * Event selection (one event per call, so the portal gets a single
 * consistent snapshot even when status and role change together):
 *   turned off                 -> access.revoked
 *   turned on / first grant    -> access.granted
 *   role changed while active  -> access.role_changed
 *   no effective change        -> nothing written, nothing sent
 *
 * @param {{ user_id:string, portal_code:string, is_active?:boolean, role_code?:string, expected_version?:number }} input
 * @param {{ id:string, email:string }} admin
 */
export async function setPortalAccess(input, admin) {
  return withTransaction(async (client) => {
    const portal = (
      await client.query('SELECT id, portal_code, is_enabled FROM portals WHERE portal_code = $1', [input.portal_code])
    ).rows[0];
    if (!portal) throw notFound(`Portal ${input.portal_code} not found`);

    const user = (await client.query('SELECT id, status FROM saas_users WHERE id = $1', [input.user_id])).rows[0];
    if (!user) throw notFound('User not found');

    if (input.role_code) {
      const role = await client.query('SELECT 1 FROM portal_roles WHERE portal_id = $1 AND role_code = $2', [
        portal.id,
        input.role_code,
      ]);
      if (!role.rows[0]) throw unprocessable(`Role ${input.role_code} does not exist on portal ${portal.portal_code}`);
    }

    // Lock the current row so concurrent toggles serialise.
    const current = (
      await client.query('SELECT * FROM user_portal_access WHERE user_id = $1 AND portal_id = $2 FOR UPDATE', [
        user.id,
        portal.id,
      ])
    ).rows[0];

    if (input.expected_version !== undefined && current && current.access_version !== input.expected_version) {
      throw conflict('Access was changed by someone else. Reload and try again.', {
        current_version: current.access_version,
      });
    }

    let row;
    let eventType = null;

    if (!current) {
      if (!input.role_code) throw unprocessable('role_code is required when granting access for the first time');
      const isActive = input.is_active ?? true;
      try {
        row = (
          await client.query(
            `INSERT INTO user_portal_access (user_id, portal_id, assigned_portal_role, is_active, granted_by)
             VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [user.id, portal.id, input.role_code, isActive, admin.id],
          )
        ).rows[0];
      } catch (err) {
        // Another admin inserted the same pair between our SELECT and INSERT.
        if (err.code === '23505') throw conflict('Access was just created by someone else. Reload and try again.');
        throw err;
      }
      eventType = isActive ? EventType.ACCESS_GRANTED : null;
    } else {
      const nextActive = input.is_active ?? current.is_active;
      const nextRole = input.role_code ?? current.assigned_portal_role;
      const statusChanged = nextActive !== current.is_active;
      const roleChanged = nextRole !== current.assigned_portal_role;

      if (!statusChanged && !roleChanged) {
        return { access: current, event: null, changed: false };
      }

      row = (
        await client.query(
          `UPDATE user_portal_access
              SET is_active = $3, assigned_portal_role = $4,
                  access_version = access_version + 1, granted_by = $5
            WHERE user_id = $1 AND portal_id = $2
        RETURNING *`,
          [user.id, portal.id, nextActive, nextRole, admin.id],
        )
      ).rows[0];

      if (statusChanged) eventType = nextActive ? EventType.ACCESS_GRANTED : EventType.ACCESS_REVOKED;
      // A role change on an inactive grant is recorded but not pushed: the
      // portal has nothing to apply until access is turned back on.
      else if (roleChanged && nextActive) eventType = EventType.ACCESS_ROLE_CHANGED;
    }

    // A globally INACTIVE account never gets a "granted" push.
    if (eventType === EventType.ACCESS_GRANTED && user.status !== 'ACTIVE') eventType = null;

    if (eventType) {
      await enqueuePortalEvents(client, {
        userId: user.id,
        portalIds: [portal.id],
        type: eventType,
        reason: 'ADMIN_ACTION',
        previous: current
          ? { [portal.id]: { is_active: current.is_active, role: current.assigned_portal_role } }
          : {},
        actor: { id: admin.id, label: admin.email },
      });
    }

    await writeAudit(client, {
      actorId: admin.id,
      actorLabel: admin.email,
      action: 'PORTAL_ACCESS_CHANGED',
      targetUserId: user.id,
      details: {
        portal: portal.portal_code,
        before: current ? { is_active: current.is_active, role: current.assigned_portal_role } : null,
        after: { is_active: row.is_active, role: row.assigned_portal_role },
        event: eventType,
      },
    });

    return { access: row, event: eventType, changed: true };
  });
}

// ---------------------------------------------------------------------------
// Auto-assign
// ---------------------------------------------------------------------------

/**
 * Give EMS users the default role on every portal that has auto_grant_role
 * set, where they have no access row yet. Existing rows (including ones an
 * admin deactivated) are never touched.
 *
 * @param {import('pg').PoolClient} client  Caller's transaction
 * @param {{ userId?: string|null, portalId?: string|null, actor: { id?: string|null, label: string } }} scope
 *        userId: one user (new EMS hire); portalId: one portal (setting just turned on)
 * @returns {Promise<number>} rows created
 */
export async function applyAutoGrants(client, { userId = null, portalId = null, actor }) {
  const { rows } = await client.query(
    `INSERT INTO user_portal_access (user_id, portal_id, assigned_portal_role, is_active)
     SELECT u.id, p.id,
            -- EMS-sourced portals: the user's own EMS role; otherwise the portal's default.
            COALESCE(CASE WHEN p.role_source = 'EMS'
                          THEN (SELECT r.role_code FROM portal_roles r WHERE r.portal_id = p.id AND r.ems_role_id = u.ems_role_id)
                     END, p.auto_grant_role),
            true
       FROM saas_users u
      CROSS JOIN portals p
      WHERE p.auto_grant_role IS NOT NULL
        AND u.source = 'EMS'
        AND ($1::uuid IS NULL OR u.id = $1)
        AND ($2::uuid IS NULL OR p.id = $2)
        AND NOT EXISTS (SELECT 1 FROM user_portal_access a WHERE a.user_id = u.id AND a.portal_id = p.id)
     ON CONFLICT (user_id, portal_id) DO NOTHING
     RETURNING user_id, portal_id`,
    [userId, portalId],
  );
  if (!rows.length) return 0;

  // One "granted" event per new grant so the portal learns about it right away.
  // Inactive accounts get no event: they are blocked either way, and the
  // portal's full re-sync still sees the row.
  const active = new Set(
    (
      await client.query(`SELECT id FROM saas_users WHERE id = ANY($1::uuid[]) AND status = 'ACTIVE'`, [
        [...new Set(rows.map((r) => r.user_id))],
      ])
    ).rows.map((r) => r.id),
  );
  for (const r of rows.filter((x) => active.has(x.user_id))) {
    await enqueuePortalEvents(client, {
      userId: r.user_id,
      portalIds: [r.portal_id],
      type: EventType.ACCESS_GRANTED,
      reason: 'AUTO_GRANT',
      actor,
    });
  }
  return rows.length;
}

// ---------------------------------------------------------------------------
// Token support
// ---------------------------------------------------------------------------

const GRANT_SELECT = `
  SELECT u.id AS user_id, u.email, u.full_name, u.source, u.ems_user_id, u.status, u.password_hash,
         d.dept_name, g.designation_name,
         p.portal_code, p.is_enabled,
         a.assigned_portal_role AS role_code, a.is_active, a.access_version,
         r.permissions, r.external_role_id
    FROM saas_users u
    JOIN user_portal_access a ON a.user_id = u.id
    JOIN portals p            ON p.id = a.portal_id
    JOIN portal_roles r       ON r.portal_id = a.portal_id AND r.role_code = a.assigned_portal_role
    LEFT JOIN departments  d  ON d.id = u.department_id
    LEFT JOIN designations g  ON g.id = u.designation_id`;

// Compared against when the user/grant is missing, so response time does not
// reveal whether an email exists.
const DUMMY_HASH = bcrypt.hashSync('timing-equaliser-not-a-real-password', 12);

/**
 * Verify credentials and return the user's grant for a portal, or null.
 * Returns null (never throws) for every failure reason, so callers answer
 * with one generic error and do not leak which check failed.
 */
export async function authenticateForPortal(email, password, portalCode) {
  const { rows } = await query(`${GRANT_SELECT} WHERE u.email = $1 AND p.portal_code = $2`, [email, portalCode]);
  const grant = rows[0];

  const passwordOk = await bcrypt.compare(password, grant?.password_hash ?? DUMMY_HASH);
  if (!grant || !grant.password_hash || !passwordOk) return null;
  if (grant.status !== 'ACTIVE' || !grant.is_active || !grant.is_enabled) return null;

  delete grant.password_hash;
  return grant;
}

/** Live check used by /auth/introspect. */
export async function getLiveGrant(userId, portalCode) {
  const { rows } = await query(`${GRANT_SELECT} WHERE u.id = $1 AND p.portal_code = $2`, [userId, portalCode]);
  const grant = rows[0];
  if (grant) delete grant.password_hash;
  return grant ?? null;
}
