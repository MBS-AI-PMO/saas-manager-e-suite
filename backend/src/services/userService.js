/**
 * saas_users business logic.
 *
 * Ownership rules
 *   - For source = 'EMS' rows, EMS owns identity fields (name, email, department,
 *     designation, deployment, EMS role, global ACTIVE/INACTIVE). Each sync
 *     overwrites them.
 *   - The SaaS owns portal access (user_portal_access) for every user. EMS
 *     syncs never change per-portal flags or roles.
 *   - Global INACTIVE overrides every portal flag without erasing it. When EMS
 *     re-activates someone, their previous per-portal setup comes back as it was.
 */
import bcrypt from 'bcryptjs';
import { query, withTransaction } from '../db/pool.js';
import { stableHash } from '../utils/crypto.js';
import { conflict, notFound, unprocessable } from '../utils/errors.js';
import { applyAutoGrants } from './accessService.js';
import { alignEmsPortalRoles } from './emsRoleService.js';
import { writeAudit } from './auditService.js';
import { resolveEmsLookup } from './lookupService.js';
import { EventType, USER_ORG_JOINS, USER_ORG_SQL, enqueuePortalEvents } from './outboxService.js';
import { resolveOrgRef, resolveProjectRef, setUserProjects } from './orgService.js';

/** When a user appears on a project more than once, the strongest role wins. */
const PROJECT_ROLE_RANK = { member: 1, manager: 2, hr: 3 };

const BCRYPT_ROUNDS = 12;

/**
 * Laravel writes "$2y$" bcrypt hashes. The algorithm is identical to "$2b$";
 * only the prefix differs. Normalise so every bcrypt library accepts it.
 */
function normaliseBcrypt(hash) {
  return hash ? hash.replace(/^\$2y\$/, '$2b$') : hash;
}

// ---------------------------------------------------------------------------
// EMS ingestion
// ---------------------------------------------------------------------------

/**
 * Apply one EMS user record in its own transaction. Never throws for data
 * problems; returns an outcome so a bulk sync reports per-record results.
 *
 * @returns {Promise<{ ems_user_id:number, outcome:'created'|'updated'|'adopted'|'unchanged'|'stale'|'error', user_id?:string, error?:string }>}
 */
export async function upsertEmsUser(emsUser, occurredAt, eventId) {
  const hash = stableHash(emsUser);
  const actor = { id: null, label: 'EMS_WEBHOOK' };

  try {
    return await withTransaction(async (client) => {
      // Lock the row (if any) so two concurrent webhooks for the same person serialise.
      let existing = (
        await client.query('SELECT * FROM saas_users WHERE ems_user_id = $1 FOR UPDATE', [emsUser.ems_user_id])
      ).rows[0];
      let adopting = false;

      if (!existing) {
        const byEmail = (
          await client.query('SELECT * FROM saas_users WHERE email = $1 FOR UPDATE', [emsUser.email])
        ).rows[0];
        if (byEmail?.source === 'DIRECT_SAAS') {
          // The admin created this person by hand before EMS knew about them.
          // Link instead of duplicating; their portal access is kept.
          existing = byEmail;
          adopting = true;
        } else if (byEmail) {
          return {
            ems_user_id: emsUser.ems_user_id,
            outcome: 'error',
            error: `Email ${emsUser.email} already belongs to EMS user #${byEmail.ems_user_id}`,
          };
        }
      }

      if (existing && !adopting) {
        if (existing.ems_source_ts && existing.ems_source_ts > occurredAt) {
          return { ems_user_id: emsUser.ems_user_id, outcome: 'stale', user_id: existing.id };
        }
        if (existing.ems_payload_hash === hash) {
          return { ems_user_id: emsUser.ems_user_id, outcome: 'unchanged', user_id: existing.id };
        }
      }

      const departmentId = await resolveEmsLookup(client, 'department', emsUser.department);
      const designationId = await resolveEmsLookup(client, 'designation', emsUser.designation);
      const companyId = await resolveOrgRef(client, 'company', emsUser.company);
      const clientId = await resolveOrgRef(client, 'client', emsUser.client);
      const projectLinks = new Map();
      for (const p of emsUser.deployed_projects) {
        const projectId = await resolveProjectRef(client, p);
        const role = p.role ?? (p.is_lead ? 'manager' : 'member');
        const current = projectLinks.get(projectId);
        if (!current || PROJECT_ROLE_RANK[role] > PROJECT_ROLE_RANK[current]) projectLinks.set(projectId, role);
      }
      const deployedProject =
        emsUser.deployed_projects.map((p) => p.title).join(', ').slice(0, 500) || null;
      const status = emsUser.is_active ? 'ACTIVE' : 'INACTIVE';

      const values = [
        emsUser.ems_user_id,
        emsUser.full_name,
        emsUser.email,
        normaliseBcrypt(emsUser.password_hash) ?? null,
        departmentId,
        designationId,
        deployedProject,
        emsUser.deployed_location?.name ?? null,
        emsUser.ems_role?.name ?? null,
        emsUser.staff_id ?? null,
        status,
        occurredAt,
        hash,
        emsUser.ems_role?.ems_id ?? null,
        companyId,
        clientId,
        emsUser.joining_date ?? null,
        emsUser.exit_date ?? null,
        emsUser.phone ?? null,
      ];

      let row;
      if (!existing) {
        row = (
          await client.query(
            `INSERT INTO saas_users
               (source, ems_user_id, full_name, email, password_hash, department_id, designation_id,
                deployed_project, deployed_location, ems_role_name, staff_id, status, ems_source_ts, ems_payload_hash, ems_role_id,
                company_id, client_id, joining_date, exit_date, phone)
             VALUES ('EMS', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
             RETURNING *`,
            values,
          )
        ).rows[0];
      } else {
        row = (
          await client.query(
            `UPDATE saas_users SET
                 source = 'EMS', ems_user_id = $1, full_name = $2, email = $3,
                 -- Keep the current hash when EMS does not send one.
                 password_hash = COALESCE($4, password_hash),
                 department_id = $5, designation_id = $6, deployed_project = $7, deployed_location = $8,
                 ems_role_name = $9, staff_id = $10, status = $11, ems_source_ts = $12, ems_payload_hash = $13,
                 ems_role_id = $14, company_id = $15, client_id = $16, joining_date = $17, exit_date = $18, phone = $19
               WHERE id = $20
           RETURNING *`,
            [...values, existing.id],
          )
        ).rows[0];
      }

      const outcome = !existing ? 'created' : adopting ? 'adopted' : 'updated';
      const projectsChanged = await setUserProjects(
        client,
        row.id,
        [...projectLinks].map(([project_id, role]) => ({ project_id, role })),
      );
      await afterAccountChange(client, existing, row, actor, status === 'ACTIVE' ? 'EMS_REACTIVATED' : 'EMS_DEACTIVATED', {
        projectsChanged,
      });
      // New EMS identities get the default role on auto-assign portals.
      if (outcome !== 'updated') await applyAutoGrants(client, { userId: row.id, actor });
      // EMS role changed: portals whose roles come from EMS follow it.
      if (!existing || existing.ems_role_id !== row.ems_role_id) await alignEmsPortalRoles(client, { userId: row.id, actor });

      await writeAudit(client, {
        actorLabel: actor.label,
        action: `EMS_USER_${outcome.toUpperCase()}`,
        targetUserId: row.id,
        details: { ems_user_id: emsUser.ems_user_id, event_id: eventId },
      });

      return { ems_user_id: emsUser.ems_user_id, outcome, user_id: row.id };
    });
  } catch (err) {
    // Constraint problems for one record must not fail the whole batch.
    return { ems_user_id: emsUser.ems_user_id, outcome: 'error', error: describeDbError(err) };
  }
}

/**
 * EMS deleted users. We never hard-delete: identity history and the audit trail
 * are kept, the account goes INACTIVE, and every portal is told to revoke access.
 */
export async function deactivateEmsUsers(emsUserIds, occurredAt, eventId) {
  const results = [];
  for (const emsUserId of emsUserIds) {
    try {
      results.push(
        await withTransaction(async (client) => {
          const existing = (
            await client.query('SELECT * FROM saas_users WHERE ems_user_id = $1 FOR UPDATE', [emsUserId])
          ).rows[0];
          if (!existing) return { ems_user_id: emsUserId, outcome: 'unchanged' };
          if (existing.status === 'INACTIVE') return { ems_user_id: emsUserId, outcome: 'unchanged', user_id: existing.id };

          const row = (
            await client.query(
              `UPDATE saas_users SET status = 'INACTIVE', ems_source_ts = $2, ems_payload_hash = NULL
                WHERE id = $1 RETURNING *`,
              [existing.id, occurredAt],
            )
          ).rows[0];
          await afterAccountChange(client, existing, row, { id: null, label: 'EMS_WEBHOOK' }, 'EMS_DELETED');
          await writeAudit(client, {
            actorLabel: 'EMS_WEBHOOK',
            action: 'EMS_USER_DELETED',
            targetUserId: row.id,
            details: { ems_user_id: emsUserId, event_id: eventId },
          });
          return { ems_user_id: emsUserId, outcome: 'deactivated', user_id: row.id };
        }),
      );
    } catch (err) {
      results.push({ ems_user_id: emsUserId, outcome: 'error', error: describeDbError(err) });
    }
  }
  return results;
}

/**
 * Fan out the consequences of an account-level change to target portals.
 *   - ACTIVE <-> INACTIVE: bump every access_version (invalidates issued
 *     tokens) and send access.revoked / access.granted to portals where the
 *     per-portal flag is on.
 *   - Profile change only: send user.updated so portals refresh display data.
 */
async function afterAccountChange(client, before, after, actor, reason, { projectsChanged = false } = {}) {
  if (!before) return; // brand-new user has no portal access yet

  if (before.status !== after.status) {
    const { rows } = await client.query(
      `UPDATE user_portal_access SET access_version = access_version + 1
        WHERE user_id = $1 AND is_active
    RETURNING portal_id`,
      [after.id],
    );
    if (rows.length) {
      await enqueuePortalEvents(client, {
        userId: after.id,
        portalIds: rows.map((r) => r.portal_id),
        type: after.status === 'ACTIVE' ? EventType.ACCESS_GRANTED : EventType.ACCESS_REVOKED,
        reason,
        actor,
      });
    }
    return;
  }

  const profileChanged =
    projectsChanged ||
    ['full_name', 'email', 'department_id', 'designation_id', 'deployed_project', 'deployed_location', 'staff_id',
      'company_id', 'client_id', 'joining_date', 'exit_date', 'phone']
      .some((k) => comparable(before[k]) !== comparable(after[k]));
  if (profileChanged) {
    await enqueuePortalEvents(client, { userId: after.id, type: EventType.USER_UPDATED, reason: 'PROFILE_CHANGED', actor });
  }
}

/** Dates come back from pg as Date objects; compare everything as text. */
function comparable(v) {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

// ---------------------------------------------------------------------------
// Direct (dashboard) creation
// ---------------------------------------------------------------------------

/**
 * Create a DIRECT_SAAS user, optionally with initial portal access, atomically.
 */
export async function createDirectUser(input, admin) {
  const actor = { id: admin.id, label: admin.email };

  return withTransaction(async (client) => {
    const dup = await client.query('SELECT id, source FROM saas_users WHERE email = $1', [input.email]);
    if (dup.rows[0]) {
      throw conflict('A user with this email already exists', { user_id: dup.rows[0].id, source: dup.rows[0].source });
    }

    // Resolve and validate every requested portal/role before writing anything.
    const grants = [];
    for (const access of input.portal_access) {
      const { rows } = await client.query(
        `SELECT p.id AS portal_id, r.role_code
           FROM portals p JOIN portal_roles r ON r.portal_id = p.id
          WHERE p.portal_code = $1 AND r.role_code = $2`,
        [access.portal_code, access.role_code],
      );
      if (!rows[0]) throw unprocessable(`Role ${access.role_code} does not exist on portal ${access.portal_code}`);
      grants.push({ ...rows[0], is_active: access.is_active });
    }

    // Project-based: the user is created on the chosen (active) EMS projects.
    const projects = (
      await client.query('SELECT id, title FROM projects WHERE id = ANY($1::uuid[]) AND is_active ORDER BY lower(title)', [
        input.project_ids,
      ])
    ).rows;
    if (projects.length !== new Set(input.project_ids).size) {
      throw unprocessable('One or more selected projects do not exist or are no longer active');
    }

    const passwordHash = input.password ? await bcrypt.hash(input.password, BCRYPT_ROUNDS) : null;

    const user = (
      await client.query(
        `INSERT INTO saas_users
           (source, full_name, email, password_hash, department_id, designation_id, deployed_project, deployed_location)
         VALUES ('DIRECT_SAAS', $1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          input.full_name,
          input.email,
          passwordHash,
          input.department_id ?? null,
          input.designation_id ?? null,
          projects.map((p) => p.title).join(', ').slice(0, 500) || null,
          input.deployed_location ?? null,
        ],
      )
    ).rows[0];

    for (const p of projects) {
      await client.query('INSERT INTO user_projects (user_id, project_id, project_role) VALUES ($1, $2, $3)', [user.id, p.id, 'member']);
    }

    for (const g of grants) {
      await client.query(
        `INSERT INTO user_portal_access (user_id, portal_id, assigned_portal_role, is_active, granted_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [user.id, g.portal_id, g.role_code, g.is_active, admin.id],
      );
    }
    const activePortalIds = grants.filter((g) => g.is_active).map((g) => g.portal_id);
    if (activePortalIds.length) {
      await enqueuePortalEvents(client, {
        userId: user.id,
        portalIds: activePortalIds,
        type: EventType.ACCESS_GRANTED,
        reason: 'USER_CREATED',
        actor,
      });
    }

    await writeAudit(client, {
      actorId: admin.id,
      actorLabel: admin.email,
      action: 'DIRECT_USER_CREATED',
      targetUserId: user.id,
      details: { email: input.email, portals: input.portal_access, projects: projects.map((p) => p.title) },
    });

    return getUserById(user.id, client);
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

// Shape returned to the dashboard. Never includes password_hash.
const USER_SELECT = `
  SELECT u.id, u.ems_user_id, u.source, u.full_name, u.email, u.staff_id, u.status,
         u.department_id, d.dept_name, u.designation_id, g.designation_name,
         u.deployed_project, u.deployed_location, u.ems_role_name,
         (u.password_hash IS NOT NULL) AS has_password,
         u.created_at, u.updated_at,
         ${USER_ORG_SQL},
         COALESCE((
           SELECT json_agg(json_build_object(
                    'portal_id', p.id, 'portal_code', p.portal_code, 'portal_name', p.portal_name,
                    'role_code', a.assigned_portal_role, 'is_active', a.is_active,
                    'access_version', a.access_version, 'updated_at', a.updated_at)
                  ORDER BY p.portal_name)
             FROM user_portal_access a JOIN portals p ON p.id = a.portal_id
            WHERE a.user_id = u.id
         ), '[]'::json) AS portal_access
    FROM saas_users u
    LEFT JOIN departments  d ON d.id = u.department_id
    LEFT JOIN designations g ON g.id = u.designation_id
    ${USER_ORG_JOINS}`;

export async function getUserById(id, client = { query }) {
  const { rows } = await client.query(`${USER_SELECT} WHERE u.id = $1`, [id]);
  if (!rows[0]) throw notFound('User not found');
  return rows[0];
}

export async function listUsers({ search, source, status, department_id, project_id, company_id, portal_code, access, page, page_size }) {
  // Dashboard-only admin accounts are not managed identities: hide them.
  // (An EMS employee who is also an admin still appears.)
  const where = [`NOT (u.saas_admin_role IS NOT NULL AND u.source = 'DIRECT_SAAS')`];
  const params = [];
  const add = (sql, value) => {
    params.push(value);
    where.push(sql.replace('?', `$${params.length}`));
  };

  if (search) {
    // Escape LIKE wildcards so user input is matched literally.
    const like = `%${search.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    params.push(like);
    const p = `$${params.length}`;
    where.push(`(lower(u.full_name) LIKE ${p} OR u.email LIKE ${p} OR lower(COALESCE(u.staff_id, '')) LIKE ${p})`);
  }
  if (source) add('u.source = ?', source);
  if (status) add('u.status = ?', status);
  if (department_id) add('u.department_id = ?', department_id);
  if (company_id) add('u.company_id = ?', company_id);
  if (project_id) add('EXISTS (SELECT 1 FROM user_projects up WHERE up.user_id = u.id AND up.project_id = ?)', project_id);

  // Per-portal view: filter on this user's access row for one portal.
  if (portal_code && access && access !== 'any') {
    params.push(portal_code);
    const p = `$${params.length}`;
    const row = `SELECT 1 FROM user_portal_access a JOIN portals pp ON pp.id = a.portal_id WHERE a.user_id = u.id AND pp.portal_code = ${p}`;
    if (access === 'none') where.push(`NOT EXISTS (${row})`);
    if (access === 'granted') where.push(`EXISTS (${row})`);
    if (access === 'active') where.push(`EXISTS (${row} AND a.is_active) AND u.status = 'ACTIVE'`);
    if (access === 'inactive') where.push(`(EXISTS (${row} AND NOT a.is_active) OR (EXISTS (${row}) AND u.status <> 'ACTIVE'))`);
  }

  const whereSql = `WHERE ${where.join(' AND ')}`;
  const total = Number((await query(`SELECT count(*) FROM saas_users u ${whereSql}`, params)).rows[0].count);

  params.push(page_size, (page - 1) * page_size);
  const { rows } = await query(
    `${USER_SELECT} ${whereSql} ORDER BY lower(u.full_name), u.id LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  return { data: rows, meta: { page, page_size, total, total_pages: Math.ceil(total / page_size) } };
}

function describeDbError(err) {
  if (err?.code === '23505') return `Duplicate value violates ${err.constraint}`;
  if (err?.code === '23503') return `Invalid reference (${err.constraint})`;
  return err?.message ?? 'Unknown error';
}
