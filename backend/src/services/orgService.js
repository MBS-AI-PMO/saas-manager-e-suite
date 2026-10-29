/**
 * EMS organisation: companies, clients and projects.
 *
 * EMS (the HRMS) owns them. It sends the complete catalogue (org.synced) and,
 * on each user, references to the user's company, client and projects. Users
 * are filtered and created per project in the dashboard, and portals receive
 * the organisation with every user event (and, if they opt in, as org.updated).
 *
 * Rows are matched by ems_ref_id. Anything EMS no longer lists is marked
 * inactive, never deleted, so user links and history stay intact.
 */
import crypto from 'node:crypto';
import { query, withTransaction } from '../db/pool.js';
import { stableHash } from '../utils/crypto.js';
import { writeAudit } from './auditService.js';
import { EVENT_API_VERSION, EventType, enqueuePortalEvents } from './outboxService.js';

const ACTOR = { id: null, label: 'EMS_WEBHOOK' };

// ---------------------------------------------------------------------------
// Catalogue sync (org.synced)
// ---------------------------------------------------------------------------

/**
 * Apply the full EMS organisation catalogue.
 * @returns {Promise<{unchanged?: boolean, companies:number, clients:number, projects:number, deactivated:number, users_notified:number}>}
 */
export async function upsertOrgCatalog(data, eventId) {
  const hash = stableHash(data);

  return withTransaction(async (client) => {
    // One catalogue at a time (two concurrent syncs would race on deactivation).
    await client.query('SELECT pg_advisory_xact_lock(7243105)');

    const state = (await client.query('SELECT payload_hash FROM ems_org_state WHERE id = 1')).rows[0];
    if (state?.payload_hash === hash) {
      return { unchanged: true, companies: 0, clients: 0, projects: 0, deactivated: 0, users_notified: 0 };
    }

    const changedCompanies = new Set();
    const changedClients = new Set();
    const changedProjects = new Set();

    // Companies
    const companyIds = new Map();
    for (const c of data.companies) {
      const row = await upsertRow(client, 'companies', c.ems_id, { name: c.name, is_active: c.is_active });
      companyIds.set(c.ems_id, row.id);
      if (row.changed) changedCompanies.add(row.id);
    }

    // Clients (belong to a company)
    const clientIds = new Map();
    for (const c of data.clients) {
      const companyId = c.company_ems_id ? await idFor(client, 'companies', c.company_ems_id, companyIds) : null;
      const row = await upsertRow(client, 'clients', c.ems_id, { name: c.name, company_id: companyId, is_active: c.is_active });
      clientIds.set(c.ems_id, row.id);
      if (row.changed) changedClients.add(row.id);
    }

    // Projects (belong to a company and optionally a client)
    for (const p of data.projects) {
      const companyId = p.company_ems_id ? await idFor(client, 'companies', p.company_ems_id, companyIds) : null;
      const clientId = p.client_ems_id ? await idFor(client, 'clients', p.client_ems_id, clientIds) : null;
      const row = await upsertRow(client, 'projects', p.ems_id, {
        title: p.title,
        company_id: companyId,
        client_id: clientId,
        status: p.status ?? null,
        start_date: p.start_date ?? null,
        end_date: p.end_date ?? null,
        is_active: p.is_active,
      });
      if (row.changed) changedProjects.add(row.id);
    }

    // Whatever EMS no longer lists becomes inactive.
    let deactivated = 0;
    for (const [table, list] of [
      ['companies', data.companies],
      ['clients', data.clients],
      ['projects', data.projects],
    ]) {
      const ids = list.map((x) => x.ems_id);
      const { rows } = await client.query(
        `UPDATE ${table} SET is_active = false, updated_at = now()
          WHERE ems_ref_id IS NOT NULL AND is_active AND NOT (ems_ref_id = ANY($1::int[]))
      RETURNING id`,
        [ids],
      );
      deactivated += rows.length;
      const target = table === 'companies' ? changedCompanies : table === 'clients' ? changedClients : changedProjects;
      rows.forEach((r) => target.add(r.id));
    }

    // Users whose company / client / project details changed: portals refresh them.
    const usersNotified = await notifyAffectedUsers(client, { changedCompanies, changedClients, changedProjects });

    // Portals that subscribe to organisation events get the new catalogue.
    const anyChange = changedCompanies.size + changedClients.size + changedProjects.size > 0;
    if (anyChange) await enqueueOrgEvents(client, 'EMS_ORG_SYNCED');

    await client.query(
      `INSERT INTO ems_org_state (id, payload_hash, synced_at) VALUES (1, $1, now())
       ON CONFLICT (id) DO UPDATE SET payload_hash = EXCLUDED.payload_hash, synced_at = now()`,
      [hash],
    );

    const summary = {
      companies: changedCompanies.size,
      clients: changedClients.size,
      projects: changedProjects.size,
      deactivated,
      users_notified: usersNotified,
    };
    await writeAudit(client, { actorLabel: ACTOR.label, action: 'EMS_ORG_SYNCED', details: { event_id: eventId, ...summary } });
    return summary;
  });
}

/**
 * Insert or update one row by ems_ref_id. Reports whether anything changed.
 * @returns {Promise<{id:string, changed:boolean}>}
 */
async function upsertRow(client, table, emsId, fields) {
  const cols = Object.keys(fields);
  const existing = (await client.query(`SELECT id, ${cols.map(selectCol).join(', ')} FROM ${table} WHERE ems_ref_id = $1 FOR UPDATE`, [emsId])).rows[0];

  if (!existing) {
    const { rows } = await client.query(
      `INSERT INTO ${table} (ems_ref_id, ${cols.join(', ')}) VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')})
       ON CONFLICT (ems_ref_id) DO UPDATE SET ems_ref_id = EXCLUDED.ems_ref_id
       RETURNING id`,
      [emsId, ...cols.map((c) => fields[c])],
    );
    return { id: rows[0].id, changed: true };
  }

  const changed = cols.some((c) => norm(existing[c]) !== norm(fields[c]));
  if (changed) {
    await client.query(
      `UPDATE ${table} SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`,
      [existing.id, ...cols.map((c) => fields[c])],
    );
  }
  return { id: existing.id, changed };
}

/** Dates are compared as YYYY-MM-DD text. */
function selectCol(c) {
  return c.endsWith('_date') ? `to_char(${c}, 'YYYY-MM-DD') AS ${c}` : c;
}

function norm(v) {
  return v === undefined || v === null ? null : String(v);
}

/** uuid of a company/client by EMS id: from this batch, else the table, else null. */
async function idFor(client, table, emsId, batch) {
  if (batch.has(emsId)) return batch.get(emsId);
  const row = (await client.query(`SELECT id FROM ${table} WHERE ems_ref_id = $1`, [emsId])).rows[0];
  return row?.id ?? null;
}

async function notifyAffectedUsers(client, { changedCompanies, changedClients, changedProjects }) {
  const companies = [...changedCompanies];
  const clients = [...changedClients];
  const projects = [...changedProjects];
  if (!companies.length && !clients.length && !projects.length) return 0;

  const { rows } = await client.query(
    `SELECT DISTINCT u.id
       FROM saas_users u
      WHERE u.company_id = ANY($1::uuid[])
         OR u.client_id  = ANY($2::uuid[])
         OR EXISTS (SELECT 1 FROM user_projects up WHERE up.user_id = u.id AND up.project_id = ANY($3::uuid[]))`,
    [companies, clients, projects],
  );
  for (const r of rows) {
    await enqueuePortalEvents(client, { userId: r.id, type: EventType.USER_UPDATED, reason: 'ORG_CHANGED', actor: ACTOR });
  }
  return rows.length;
}

// ---------------------------------------------------------------------------
// References on users (company / client / projects)
// ---------------------------------------------------------------------------

/**
 * uuid for an EMS company or client reference. If the catalogue has not
 * arrived yet, a row is created from the reference (the catalogue fills the rest).
 */
export async function resolveOrgRef(client, kind, ref) {
  if (!ref) return null;
  const table = kind === 'company' ? 'companies' : 'clients';
  const found = (await client.query(`SELECT id FROM ${table} WHERE ems_ref_id = $1`, [ref.ems_id])).rows[0];
  if (found) return found.id;
  const { rows } = await client.query(
    `INSERT INTO ${table} (ems_ref_id, name) VALUES ($1, $2)
     ON CONFLICT (ems_ref_id) DO UPDATE SET ems_ref_id = EXCLUDED.ems_ref_id
     RETURNING id`,
    [ref.ems_id, ref.name],
  );
  return rows[0].id;
}

/** uuid for an EMS project reference (created from the reference if needed). */
export async function resolveProjectRef(client, ref) {
  const found = (await client.query('SELECT id FROM projects WHERE ems_ref_id = $1', [ref.ems_id])).rows[0];
  if (found) return found.id;
  const { rows } = await client.query(
    `INSERT INTO projects (ems_ref_id, title) VALUES ($1, $2)
     ON CONFLICT (ems_ref_id) DO UPDATE SET ems_ref_id = EXCLUDED.ems_ref_id
     RETURNING id`,
    [ref.ems_id, ref.title],
  );
  return rows[0].id;
}

/**
 * Replace a user's project links. Returns true when they changed.
 * @param {{project_id:string, role:'member'|'hr'|'manager'}[]} links
 */
export async function setUserProjects(client, userId, links) {
  const want = new Map(links.map((l) => [l.project_id, l.role]));
  const have = new Map(
    (await client.query('SELECT project_id, project_role FROM user_projects WHERE user_id = $1', [userId])).rows.map((r) => [
      r.project_id,
      r.project_role,
    ]),
  );

  const same = want.size === have.size && [...want].every(([id, role]) => have.get(id) === role);
  if (same) return false;

  await client.query('DELETE FROM user_projects WHERE user_id = $1', [userId]);
  for (const [projectId, role] of want) {
    await client.query('INSERT INTO user_projects (user_id, project_id, project_role) VALUES ($1, $2, $3)', [userId, projectId, role]);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** The full organisation, as portals and the dashboard see it. */
export async function getOrgCatalog(client = { query }, { activeOnly = false } = {}) {
  const active = activeOnly ? 'WHERE x.is_active' : '';
  const companies = (
    await client.query(`SELECT x.id, x.ems_ref_id AS ems_id, x.name, x.is_active FROM companies x ${active} ORDER BY lower(x.name)`)
  ).rows;
  const clients = (
    await client.query(
      `SELECT x.id, x.ems_ref_id AS ems_id, x.name, x.is_active, x.company_id, c.ems_ref_id AS company_ems_id
         FROM clients x LEFT JOIN companies c ON c.id = x.company_id ${active} ORDER BY lower(x.name)`,
    )
  ).rows;
  const projects = (
    await client.query(
      `SELECT x.id, x.ems_ref_id AS ems_id, x.title, x.status, x.is_active,
              to_char(x.start_date, 'YYYY-MM-DD') AS start_date, to_char(x.end_date, 'YYYY-MM-DD') AS end_date,
              x.company_id, c.ems_ref_id AS company_ems_id, c.name AS company_name,
              x.client_id, k.ems_ref_id AS client_ems_id, k.name AS client_name,
              (SELECT count(*)::int FROM user_projects up WHERE up.project_id = x.id) AS user_count
         FROM projects x
         LEFT JOIN companies c ON c.id = x.company_id
         LEFT JOIN clients   k ON k.id = x.client_id
         ${active}
        ORDER BY lower(x.title)`,
    )
  ).rows;
  return { companies, clients, projects };
}

// ---------------------------------------------------------------------------
// org.updated events (portals with receive_org_events)
// ---------------------------------------------------------------------------

export async function enqueueOrgEvents(client, reason, onlyPortalId = null) {
  const portals = (
    await client.query(
      `SELECT id, portal_code FROM portals
        WHERE receive_org_events AND is_enabled AND webhook_url IS NOT NULL
          AND ($1::uuid IS NULL OR id = $1::uuid)`,
      [onlyPortalId],
    )
  ).rows;
  if (!portals.length) return 0;

  const org = await getOrgCatalog(client);
  for (const portal of portals) {
    const payload = {
      id: crypto.randomUUID(),
      type: EventType.ORG_UPDATED,
      api_version: EVENT_API_VERSION,
      occurred_at: new Date().toISOString(),
      reason,
      portal: { code: portal.portal_code },
      org,
      actor: ACTOR,
    };
    await client.query(
      `INSERT INTO portal_sync_events (id, portal_id, user_id, event_type, payload) VALUES ($1, $2, NULL, $3, $4)`,
      [payload.id, portal.id, payload.type, JSON.stringify(payload)],
    );
  }
  return portals.length;
}

/** Send the current organisation to one portal now (e.g. right after it opts in). */
export async function sendOrgToPortal(portalId) {
  return withTransaction(async (client) => {
    const portal = (await client.query('SELECT id, portal_code, receive_org_events FROM portals WHERE id = $1', [portalId])).rows[0];
    if (!portal?.receive_org_events) return 0;
    return enqueueOrgEvents(client, 'PORTAL_SUBSCRIBED', portal.id);
  });
}
