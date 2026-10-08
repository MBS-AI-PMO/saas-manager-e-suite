/**
 * Append-only audit trail. Always called with the caller's transaction client
 * so the audit row commits (or rolls back) with the change it describes.
 */

/**
 * @param {import('pg').PoolClient} client
 * @param {{ actorId?: string|null, actorLabel: string, action: string, targetUserId?: string|null, details?: object }} entry
 */
export async function writeAudit(client, { actorId = null, actorLabel, action, targetUserId = null, details = {} }) {
  await client.query(
    `INSERT INTO audit_log (actor_id, actor_label, action, target_user, details)
     VALUES ($1, $2, $3, $4, $5)`,
    [actorId, actorLabel, action, targetUserId, JSON.stringify(details)],
  );
}
