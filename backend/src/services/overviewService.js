/**
 * Read models for the dashboard Overview page.
 */
import { query } from '../db/pool.js';

// Same rule as the user directory: dashboard-only admins are not identities.
const IDENTITY = `NOT (saas_admin_role IS NOT NULL AND source = 'DIRECT_SAAS')`;

export async function getOverview() {
  const [users, events, lastSync] = await Promise.all([
    query(`SELECT count(*)::int AS total,
                  count(*) FILTER (WHERE source = 'EMS')::int AS ems,
                  count(*) FILTER (WHERE source = 'DIRECT_SAAS')::int AS direct,
                  count(*) FILTER (WHERE status = 'INACTIVE')::int AS inactive,
                  count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM user_portal_access a WHERE a.user_id = saas_users.id))::int AS without_access
             FROM saas_users WHERE ${IDENTITY}`),
    query(`SELECT count(*) FILTER (WHERE status = 'PENDING')::int AS pending,
                  count(*) FILTER (WHERE status = 'FAILED')::int AS failed,
                  count(*) FILTER (WHERE status = 'DELIVERED' AND delivered_at > now() - interval '24 hours')::int AS delivered_24h
             FROM portal_sync_events`),
    query(`SELECT max(created_at) AS at FROM audit_log WHERE actor_label = 'EMS_WEBHOOK'`),
  ]);

  return {
    users: users.rows[0],
    events: events.rows[0],
    last_ems_sync_at: lastSync.rows[0].at,
  };
}

export async function getRecentActivity(limit = 15) {
  const { rows } = await query(
    `SELECT l.id, l.actor_label, l.action, l.details, l.created_at,
            u.full_name AS target_name, u.email AS target_email
       FROM audit_log l
       LEFT JOIN saas_users u ON u.id = l.target_user
      -- Bulk EMS syncs would drown out admin actions; show admin actions only.
      WHERE l.actor_label <> 'EMS_WEBHOOK'
      ORDER BY l.created_at DESC, l.id DESC
      LIMIT $1`,
    [limit],
  );
  return rows;
}
