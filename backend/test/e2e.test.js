/**
 * End-to-end test: real Express app + real `pg` driver against an in-memory
 * PostgreSQL (PGlite served over the wire protocol). No external services.
 *
 *   npm test
 *
 * Set HRMS_PATH=/path/to/HRMS to also push real employees through the Laravel
 * client (read-only on MySQL; nothing is written to the HRMS).
 */
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = crypto.randomBytes(32).toString('hex');
const PORTAL_SECRET = 'portal-secret-for-tests';

let db, socketServer, apiServer, portalServer, stopDispatcher, pool, base;
const portalInbox = [];
// Roles served by the mock portal at GET /iam/roles (tests mutate this).
let mockPortalRoles = [];
let mockRolesSecret = null; // when set, the mock rejects unsigned/wrongly signed fetches

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
before(async () => {
  // 1. In-memory Postgres reachable over TCP
  db = await PGlite.create();
  socketServer = new PGLiteSocketServer({ db, port: 0, host: '127.0.0.1' });
  await socketServer.start();
  const pgPort = Number(socketServer.getServerConn().split(':').pop());

  // 2. Keys + environment (before importing the app: env.js reads at import)
  const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iam-keys-'));
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  fs.writeFileSync(path.join(keyDir, 'priv.pem'), privateKey);
  fs.writeFileSync(path.join(keyDir, 'pub.pem'), publicKey);

  Object.assign(process.env, {
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    PGHOST: '127.0.0.1',
    PGPORT: String(pgPort),
    PGDATABASE: 'postgres',
    PGUSER: 'postgres',
    PGPASSWORD: 'postgres',
    PG_POOL_MAX: '1', // PGlite is single-session; the pool queues
    EMS_WEBHOOK_SECRET: SECRET,
    JWT_ISSUER: 'https://identity.test',
    JWT_PRIVATE_KEY_PATH: path.join(keyDir, 'priv.pem'),
    JWT_PUBLIC_KEY_PATH: path.join(keyDir, 'pub.pem'),
    JWT_KEY_ID: 'test-key',
    OUTBOX_POLL_INTERVAL_MS: '150',
  });

  // 3. Mock target portal that verifies signatures exactly as a real one should
  portalServer = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/iam/roles') {
      const ts = req.headers['x-iam-timestamp'];
      const expected = mockRolesSecret && crypto.createHmac('sha256', mockRolesSecret).update(`${ts}.`).digest('hex');
      if (!mockRolesSecret || req.headers['x-iam-signature'] !== `v1=${expected}`) return res.writeHead(401).end();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ roles: mockPortalRoles }));
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const ts = req.headers['x-iam-timestamp'];
      const expected = crypto.createHmac('sha256', PORTAL_SECRET).update(`${ts}.${body}`).digest('hex');
      const valid = req.headers['x-iam-signature'] === `v1=${expected}`;
      portalInbox.push({ valid, event: JSON.parse(body) });
      res.writeHead(valid ? 204 : 401).end();
    });
  });
  await new Promise((r) => portalServer.listen(0, '127.0.0.1', r));
  const portalUrl = `http://127.0.0.1:${portalServer.address().port}/iam/events`;

  // 4. Schema + seed
  ({ pool } = await import('../src/db/pool.js'));
  for (const f of fs.readdirSync(path.join(root, 'db/migrations')).sort()) {
    await pool.query(fs.readFileSync(path.join(root, 'db/migrations', f), 'utf8'));
  }
  await pool.query(fs.readFileSync(path.join(root, 'db/seeds/001_portals_example.sql'), 'utf8'));
  await pool.query(`UPDATE portals SET webhook_url = $1, webhook_secret = $2 WHERE portal_code = 'CONTENT'`, [
    portalUrl,
    PORTAL_SECRET,
  ]);
  // PROJECTS takes no push events in this test (token + introspect only).
  await pool.query(`UPDATE portals SET webhook_url = NULL WHERE portal_code = 'PROJECTS'`);
  const bcrypt = (await import('bcryptjs')).default;
  await pool.query(
    `INSERT INTO saas_users (source, full_name, email, password_hash, saas_admin_role)
     VALUES ('DIRECT_SAAS', 'Root Admin', 'admin@test.local', $1, 'SUPER_ADMIN')`,
    [await bcrypt.hash('admin-password-123', 4)],
  );

  // 5. App + dispatcher
  const { createApp } = await import('../src/app.js');
  const { startOutboxDispatcher } = await import('../src/services/outboxService.js');
  apiServer = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => apiServer.once('listening', r));
  base = `http://127.0.0.1:${apiServer.address().port}`;
  stopDispatcher = startOutboxDispatcher();
});

after(async () => {
  await stopDispatcher?.();
  await new Promise((r) => apiServer?.close(r));
  await new Promise((r) => portalServer?.close(r));
  await pool?.end();
  await socketServer?.stop();
  await db?.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function api(method, url, { body, token, headers = {} } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function emsWebhook(event, data, { occurredAt = new Date(), secret = SECRET, ts } = {}) {
  const raw = JSON.stringify({ event_id: crypto.randomUUID(), event, occurred_at: occurredAt.toISOString(), data });
  const timestamp = String(ts ?? Math.floor(Date.now() / 1000));
  const sig = crypto.createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex');
  return api('POST', '/api/v1/webhooks/ems-user', {
    body: raw,
    headers: { 'X-EMS-Timestamp': timestamp, 'X-EMS-Signature': `v1=${sig}` },
  });
}

const waitFor = async (pred, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('Timed out waiting for condition');
};

/** Wait until every queued portal event has been delivered (or failed). */
const drainOutbox = async () => {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM portal_sync_events WHERE status = 'PENDING'");
    if (rows[0].n === 0) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('Outbox did not drain');
};

// Laravel-style "$2y$" hash, produced by real PHP when available.
function laravelHash(password) {
  try {
    return execFileSync('php', ['-r', `echo password_hash(${JSON.stringify(password)}, PASSWORD_BCRYPT, ['cost'=>4]);`]).toString();
  } catch {
    return null;
  }
}

const emsUser = (over = {}) => ({
  ems_user_id: 101,
  staff_id: 'EMP101',
  full_name: 'Ayesha Khan',
  email: 'ayesha@corp.test',
  is_active: true,
  department: { ems_id: 3, name: 'Engineering' },
  designation: { ems_id: 7, name: 'Senior Developer' },
  deployed_projects: [{ ems_id: 4, title: 'Apollo', is_lead: false }],
  deployed_location: { ems_id: 2, name: 'Lahore HQ' },
  ems_role: { ems_id: 3, name: 'employee' },
  ...over,
});

let adminToken;
let ayeshaId;
const phpHash = laravelHash('ems-password-1');

// ---------------------------------------------------------------------------
// Tests (sequential; each builds on the previous state)
// ---------------------------------------------------------------------------
test('admin login and protected routes', async () => {
  assert.equal((await api('GET', '/api/v1/users')).status, 401);
  const bad = await api('POST', '/api/v1/auth/admin/login', { body: { email: 'admin@test.local', password: 'nope' } });
  assert.equal(bad.status, 401);
  const ok = await api('POST', '/api/v1/auth/admin/login', {
    body: { email: 'admin@test.local', password: 'admin-password-123' },
  });
  assert.equal(ok.status, 200);
  adminToken = ok.body.access_token;
});

test('EMS webhook rejects bad signatures, stale timestamps, and invalid bodies', async () => {
  assert.equal((await emsWebhook('user.upserted', { users: [emsUser()] }, { secret: 'x'.repeat(64) })).status, 401);
  const old = Math.floor(Date.now() / 1000) - 3600;
  assert.equal((await emsWebhook('user.upserted', { users: [emsUser()] }, { ts: old })).status, 401);
  const invalid = await emsWebhook('user.upserted', { users: [{ ems_user_id: 'abc' }] });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, 'BAD_REQUEST');
});

test('EMS upsert: create, idempotent replay, stale event, update', async () => {
  const user = emsUser(phpHash ? { password_hash: phpHash } : {});
  const created = await emsWebhook('user.upserted', { users: [user, emsUser({ ems_user_id: 102, email: 'bilal@corp.test', full_name: 'Bilal Ahmed', deployed_projects: [] })] });
  assert.equal(created.status, 200);
  assert.deepEqual(created.body.summary, { created: 2 });
  ayeshaId = created.body.results[0].user_id;

  const replay = await emsWebhook('user.upserted', { users: [user] });
  assert.equal(replay.body.results[0].outcome, 'unchanged');

  const stale = await emsWebhook('user.upserted', { users: [{ ...user, full_name: 'Old Name' }] }, {
    occurredAt: new Date(Date.now() - 86_400_000),
  });
  assert.equal(stale.body.results[0].outcome, 'stale');

  // Department rename in EMS follows the ems_id instead of duplicating.
  const renamed = await emsWebhook('user.upserted', {
    users: [{ ...user, department: { ems_id: 3, name: 'Platform Engineering' } }],
  });
  assert.equal(renamed.body.results[0].outcome, 'updated');
  const depts = await pool.query('SELECT dept_name FROM departments');
  assert.deepEqual(depts.rows.map((r) => r.dept_name), ['Platform Engineering']);
});

test('same department name from two EMS companies does not collide', async () => {
  const res = await emsWebhook('user.upserted', {
    users: [emsUser({ ems_user_id: 103, email: 'c@corp.test', department: { ems_id: 99, name: 'Platform Engineering' } })],
  });
  assert.equal(res.body.results[0].outcome, 'created');
  const { rows } = await pool.query('SELECT dept_name FROM departments ORDER BY dept_name');
  assert.deepEqual(rows.map((r) => r.dept_name), ['Platform Engineering', 'Platform Engineering (EMS #99)']);
});

test('direct user creation, duplicate email, and invalid role', async () => {
  const created = await api('POST', '/api/v1/users', {
    token: adminToken,
    body: {
      full_name: 'Contractor Zed',
      email: 'Zed@Vendor.test',
      password: 'contractor-pass-1',
      deployed_project: 'Vendor Ops',
      portal_access: [{ portal_code: 'projects', role_code: 'viewer' }],
    },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.source, 'DIRECT_SAAS');
  assert.equal(created.body.data.email, 'zed@vendor.test');
  assert.equal(created.body.data.portal_access[0].role_code, 'VIEWER');
  assert.equal(created.body.data.has_password, true);
  assert.equal(created.body.data.password_hash, undefined);

  const dup = await api('POST', '/api/v1/users', {
    token: adminToken,
    body: { full_name: 'Again', email: 'zed@vendor.test' },
  });
  assert.equal(dup.status, 409);

  const badRole = await api('POST', '/api/v1/users', {
    token: adminToken,
    body: { full_name: 'X Y', email: 'xy@vendor.test', portal_access: [{ portal_code: 'CONTENT', role_code: 'VIEWER' }] },
  });
  assert.equal(badRole.status, 422, 'VIEWER exists on PROJECTS, not CONTENT');
});

test('EMS sync adopts a matching DIRECT_SAAS user and keeps their access', async () => {
  const res = await emsWebhook('user.upserted', {
    users: [emsUser({ ems_user_id: 200, email: 'zed@vendor.test', full_name: 'Zed Contractor' })],
  });
  assert.equal(res.body.results[0].outcome, 'adopted');
  const u = (await api('GET', `/api/v1/users/${res.body.results[0].user_id}`, { token: adminToken })).body.data;
  assert.equal(u.source, 'EMS');
  assert.equal(u.ems_user_id, 200);
  assert.equal(u.portal_access.length, 1);
});

test('portal access: grant, role change, revoke -> signed events delivered in order', async () => {
  await drainOutbox();
  portalInbox.length = 0;
  const grant = await api('POST', '/api/v1/users/portal-access', {
    token: adminToken,
    body: { user_id: ayeshaId, portal_code: 'CONTENT', role_code: 'EDITOR', is_active: true },
  });
  assert.equal(grant.status, 200);
  assert.equal(grant.body.event, 'access.granted');

  const firstGrantNeedsRole = await api('POST', '/api/v1/users/portal-access', {
    token: adminToken,
    body: { user_id: ayeshaId, portal_code: 'PROJECTS', is_active: true },
  });
  assert.equal(firstGrantNeedsRole.status, 422);

  const role = await api('POST', '/api/v1/users/portal-access', {
    token: adminToken,
    body: { user_id: ayeshaId, portal_code: 'CONTENT', role_code: 'ADMIN', expected_version: 1 },
  });
  assert.equal(role.body.event, 'access.role_changed');

  const staleWrite = await api('POST', '/api/v1/users/portal-access', {
    token: adminToken,
    body: { user_id: ayeshaId, portal_code: 'CONTENT', is_active: false, expected_version: 1 },
  });
  assert.equal(staleWrite.status, 409, 'optimistic concurrency guard');

  const noop = await api('POST', '/api/v1/users/portal-access', {
    token: adminToken,
    body: { user_id: ayeshaId, portal_code: 'CONTENT', role_code: 'ADMIN' },
  });
  assert.equal(noop.body.changed, false);

  const revoke = await api('POST', '/api/v1/users/portal-access', {
    token: adminToken,
    body: { user_id: ayeshaId, portal_code: 'CONTENT', is_active: false },
  });
  assert.equal(revoke.body.event, 'access.revoked');

  await waitFor(() => portalInbox.length >= 3);
  assert.ok(portalInbox.every((m) => m.valid), 'all signatures valid');
  assert.deepEqual(portalInbox.map((m) => m.event.type), ['access.granted', 'access.role_changed', 'access.revoked']);
  const last = portalInbox[2].event;
  assert.equal(last.access.status, 'INACTIVE');
  assert.equal(last.access.previous.status, 'ACTIVE');
  assert.equal(last.directives.terminate_sessions, true);
  assert.equal(last.access.version, 3);
  // The adopt test re-sent ems_id 3 as "Engineering": renames follow EMS.
  assert.equal(last.user.department, 'Engineering');
});

test('portal JWT: issue (with Laravel $2y$ hash), introspect, revoke invalidates', async () => {
  // Re-enable CONTENT for Ayesha
  await api('POST', '/api/v1/users/portal-access', {
    token: adminToken,
    body: { user_id: ayeshaId, portal_code: 'CONTENT', is_active: true },
  });

  if (!phpHash) {
    // Without PHP we cannot produce a $2y$ hash; set one via bcryptjs instead.
    const bcrypt = (await import('bcryptjs')).default;
    await pool.query('UPDATE saas_users SET password_hash = $2 WHERE id = $1', [ayeshaId, await bcrypt.hash('ems-password-1', 4)]);
  }

  const denied = await api('POST', '/api/v1/auth/token', {
    body: { email: 'ayesha@corp.test', password: 'ems-password-1', portal_code: 'PROJECTS' },
  });
  assert.equal(denied.status, 401, 'no PROJECTS grant');

  const issued = await api('POST', '/api/v1/auth/token', {
    body: { email: 'ayesha@corp.test', password: 'ems-password-1', portal_code: 'CONTENT' },
  });
  assert.equal(issued.status, 200);
  assert.equal(issued.body.role, 'ADMIN');
  assert.ok(issued.body.permissions.includes('content.publish'));

  // Verify like a portal would: with the JWKS public key only.
  const jwks = (await api('GET', '/.well-known/jwks.json')).body;
  const pub = crypto.createPublicKey({ key: jwks.keys[0], format: 'jwk' });
  const [h, p, s] = issued.body.access_token.split('.');
  assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), pub, Buffer.from(s, 'base64url')));
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
  assert.equal(claims.aud, 'CONTENT');
  assert.equal(claims.role, 'ADMIN');
  assert.equal(claims.src, 'EMS');

  const basic = `Basic ${Buffer.from(`CONTENT:${PORTAL_SECRET}`).toString('base64')}`;
  const intro = (t) => api('POST', '/api/v1/auth/introspect', { body: { token: t }, headers: { Authorization: basic } });

  assert.equal((await intro(issued.body.access_token)).body.active, true);
  const wrongPortal = await api('POST', '/api/v1/auth/introspect', {
    body: { token: issued.body.access_token },
    headers: { Authorization: `Basic ${Buffer.from('CONTENT:wrong').toString('base64')}` },
  });
  assert.equal(wrongPortal.status, 401);

  await api('POST', '/api/v1/users/portal-access', {
    token: adminToken,
    body: { user_id: ayeshaId, portal_code: 'CONTENT', is_active: false },
  });
  const afterRevoke = await intro(issued.body.access_token);
  assert.equal(afterRevoke.body.active, false);
  assert.equal(afterRevoke.body.reason, 'PORTAL_ACCESS_INACTIVE');
});

test('EMS deactivation revokes every portal; reactivation restores previous setup', async () => {
  await api('POST', '/api/v1/users/portal-access', {
    token: adminToken,
    body: { user_id: ayeshaId, portal_code: 'CONTENT', is_active: true },
  });
  await drainOutbox();
  portalInbox.length = 0;

  const off = await emsWebhook('user.upserted', { users: [emsUser({ is_active: false, password_hash: phpHash ?? undefined })] });
  assert.equal(off.body.results[0].outcome, 'updated');
  await waitFor(() => portalInbox.length >= 1);
  assert.equal(portalInbox[0].event.type, 'access.revoked');
  assert.equal(portalInbox[0].event.reason, 'EMS_DEACTIVATED');
  assert.equal(portalInbox[0].event.access.portal_flag_active, true, 'per-portal flag preserved');

  const tokenWhileInactive = await api('POST', '/api/v1/auth/token', {
    body: { email: 'ayesha@corp.test', password: 'ems-password-1', portal_code: 'CONTENT' },
  });
  assert.equal(tokenWhileInactive.status, 401);

  await emsWebhook('user.upserted', { users: [emsUser({ password_hash: phpHash ?? undefined })] });
  await waitFor(() => portalInbox.length >= 2);
  assert.equal(portalInbox[1].event.type, 'access.granted');
  assert.equal(portalInbox[1].event.reason, 'EMS_REACTIVATED');

  const del = await emsWebhook('user.deleted', { ems_user_ids: [101, 999] });
  assert.deepEqual(del.body.summary, { deactivated: 1, unchanged: 1 });
});

test('list users: search, filters, pagination, no secrets leaked', async () => {
  const all = await api('GET', '/api/v1/users?page_size=2', { token: adminToken });
  assert.equal(all.status, 200);
  assert.equal(all.body.data.length, 2);
  assert.equal(all.body.meta.total, 4); // dashboard-only admin is hidden
  assert.ok(all.body.data.every((u) => !('password_hash' in u)));

  const search = await api('GET', '/api/v1/users?search=bil', { token: adminToken });
  assert.deepEqual(search.body.data.map((u) => u.email), ['bilal@corp.test']);

  const wildcard = await api('GET', `/api/v1/users?search=${encodeURIComponent('%')}`, { token: adminToken });
  assert.equal(wildcard.body.data.length, 0, 'LIKE wildcards are escaped');

  const portals = await api('GET', '/api/v1/portals', { token: adminToken });
  assert.equal(portals.body.data.length, 2);
  assert.ok(portals.body.data.every((p) => !('webhook_secret' in p)));
});

test('portal administration: create, roles, secret, disable, delete guards', async () => {
  const created = await api('POST', '/api/v1/portals', {
    token: adminToken,
    body: {
      portal_name: 'HR Portal',
      portal_code: 'hr_portal',
      base_url: 'https://hr.example.com',
      roles: [
        { role_code: 'HR_ADMIN', role_name: 'HR Admin', permissions: ['hr.all'] },
        { role_code: 'STAFF', role_name: 'Staff', permissions: ['hr.self'] },
      ],
    },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.portal_code, 'HR_PORTAL');
  assert.match(created.body.webhook_secret, /^[0-9a-f]{64}$/);
  assert.equal(created.body.data.webhook_secret, undefined, 'secret only returned once, top-level');

  const dup = await api('POST', '/api/v1/portals', {
    token: adminToken,
    body: { portal_name: 'Again', portal_code: 'HR_PORTAL', roles: [{ role_code: 'X1', role_name: 'X' }] },
  });
  assert.equal(dup.status, 409);

  const noRoles = await api('POST', '/api/v1/portals', {
    token: adminToken,
    body: { portal_name: 'Empty', portal_code: 'EMPTY', roles: [] },
  });
  assert.equal(noRoles.status, 400);

  const addRole = await api('POST', '/api/v1/portals/HR_PORTAL/roles', {
    token: adminToken,
    body: { role_code: 'AUDITOR', role_name: 'Auditor', permissions: ['hr.read'] },
  });
  assert.equal(addRole.status, 201);
  assert.equal(addRole.body.data.roles.length, 3);

  const renamed = await api('PATCH', '/api/v1/portals/HR_PORTAL/roles/AUDITOR', {
    token: adminToken,
    body: { role_name: 'External Auditor' },
  });
  assert.ok(renamed.body.data.roles.some((r) => r.role_name === 'External Auditor'));

  // Bulk: grant STAFF to two users, then deactivate one
  const users = (await api('GET', '/api/v1/users?source=EMS', { token: adminToken })).body.data;
  // Two ACTIVE accounts, picked by email (several test users share a name).
  const ids = ['bilal@corp.test', 'c@corp.test'].map((e) => users.find((u) => u.email === e).id);
  const bulkNoRole = await api('POST', '/api/v1/portals/HR_PORTAL/access/bulk', {
    token: adminToken,
    body: { user_ids: ids, is_active: true },
  });
  assert.equal(bulkNoRole.body.summary.error, 2, 'first grant needs a role');
  const bulk = await api('POST', '/api/v1/portals/HR_PORTAL/access/bulk', {
    token: adminToken,
    body: { user_ids: ids, is_active: true, role_code: 'STAFF' },
  });
  assert.deepEqual(bulk.body.summary, { changed: 2 });
  await api('POST', '/api/v1/portals/HR_PORTAL/access/bulk', {
    token: adminToken,
    body: { user_ids: [ids[0]], is_active: false },
  });

  const q = (access) => api('GET', `/api/v1/users?portal_code=HR_PORTAL&access=${access}`, { token: adminToken });
  assert.equal((await q('granted')).body.meta.total, 2);
  assert.equal((await q('active')).body.meta.total, 1);
  assert.equal((await q('inactive')).body.meta.total, 1);
  assert.equal((await q('none')).body.meta.total, 2);

  const delUsedRole = await api('DELETE', '/api/v1/portals/HR_PORTAL/roles/STAFF', { token: adminToken });
  assert.equal(delUsedRole.status, 409);
  const delRole = await api('DELETE', '/api/v1/portals/HR_PORTAL/roles/AUDITOR', { token: adminToken });
  assert.equal(delRole.status, 200);

  const list = await api('GET', '/api/v1/portals', { token: adminToken });
  const hr = list.body.data.find((p) => p.portal_code === 'HR_PORTAL');
  assert.equal(hr.granted_count, 2);
  assert.equal(hr.active_count, 1);
  assert.ok(list.body.data.every((p) => !('webhook_secret' in p)));

  const rotated = await api('POST', '/api/v1/portals/HR_PORTAL/rotate-secret', { token: adminToken });
  assert.notEqual(rotated.body.webhook_secret, created.body.webhook_secret);

  const disabled = await api('PATCH', '/api/v1/portals/HR_PORTAL', { token: adminToken, body: { is_enabled: false } });
  assert.equal(disabled.body.data.is_enabled, false);

  assert.equal((await api('DELETE', '/api/v1/portals/HR_PORTAL', { token: adminToken })).status, 409, 'in use');
  await api('POST', '/api/v1/portals', {
    token: adminToken,
    body: { portal_name: 'Temp', portal_code: 'TEMP', roles: [{ role_code: 'USER', role_name: 'User' }] },
  });
  assert.equal((await api('DELETE', '/api/v1/portals/TEMP', { token: adminToken })).status, 204);
});

test('auto-assign portal (HRMS governance) + portal full re-sync', async () => {
  const created = await api('POST', '/api/v1/portals', {
    token: adminToken,
    body: {
      portal_name: 'EMS HRMS',
      portal_code: 'EMS_HRMS',
      auto_grant_role: 'EMPLOYEE',
      roles: [{ role_code: 'EMPLOYEE', role_name: 'Employee' }],
    },
  });
  assert.equal(created.status, 201);
  const secret = created.body.webhook_secret;
  // Every EMS user (4) got access automatically; nobody is locked out.
  assert.equal(created.body.data.granted_count, 4);
  assert.equal(created.body.data.auto_grant_role, 'EMPLOYEE');

  // A new EMS hire is auto-assigned too.
  const hire = await emsWebhook('user.upserted', {
    users: [emsUser({ ems_user_id: 300, email: 'newhire@corp.test', full_name: 'New Hire' })],
  });
  const hireId = hire.body.results[0].user_id;
  const hireUser = (await api('GET', `/api/v1/users/${hireId}`, { token: adminToken })).body.data;
  assert.ok(hireUser.portal_access.some((a) => a.portal_code === 'EMS_HRMS' && a.is_active));

  // Admin deactivates one person; a later EMS sync must NOT re-enable them.
  await api('POST', '/api/v1/users/portal-access', {
    token: adminToken,
    body: { user_id: hireId, portal_code: 'EMS_HRMS', is_active: false },
  });
  await emsWebhook('user.upserted', { users: [emsUser({ ems_user_id: 300, email: 'newhire@corp.test', full_name: 'New Hire Renamed' })] });

  // Portal pulls its full list with its own credentials.
  const basic = `Basic ${Buffer.from(`EMS_HRMS:${secret}`).toString('base64')}`;
  const pull = await api('GET', '/api/v1/portal-sync/access', { headers: { Authorization: basic } });
  assert.equal(pull.status, 200);
  assert.equal(pull.body.data.length, 5);
  const row = pull.body.data.find((r) => r.ems_user_id === 300);
  assert.equal(row.status, 'INACTIVE', 'admin deactivation survives EMS re-sync');
  assert.equal((await api('GET', '/api/v1/portal-sync/access', { headers: { Authorization: 'Basic eDp5' } })).status, 401);

  // The auto-assign role cannot be deleted out from under the setting.
  await api('POST', '/api/v1/portals/EMS_HRMS/roles', { token: adminToken, body: { role_code: 'HR', role_name: 'HR' } });
  assert.equal((await api('DELETE', '/api/v1/portals/EMS_HRMS/roles/EMPLOYEE', { token: adminToken })).status, 409);
  // Turning auto-assign off is allowed.
  const off = await api('PATCH', '/api/v1/portals/EMS_HRMS', { token: adminToken, body: { auto_grant_role: null } });
  assert.equal(off.body.data.auto_grant_role, null);
});

test('EMS-sourced roles: HRMS role catalogue, per-user EMS role, write-back event', async () => {
  // EMS sends its role catalogue.
  const synced = await emsWebhook('roles.synced', {
    roles: [
      { ems_id: 1, name: 'admin' },
      { ems_id: 3, name: 'employee' },
      { ems_id: 23, name: 'Project Lead - Employee' },
    ],
  });
  assert.equal(synced.status, 200);
  const emsRoles = (await api('GET', '/api/v1/ems-roles', { token: adminToken })).body.data;
  assert.equal(emsRoles.length, 3);

  // Switch the HRMS portal (created in the previous test) to EMS roles, with auto-assign back on.
  await api('PATCH', '/api/v1/portals/EMS_HRMS', { token: adminToken, body: { auto_grant_role: 'EMPLOYEE' } });
  const switched = await api('PATCH', '/api/v1/portals/EMS_HRMS', { token: adminToken, body: { role_source: 'EMS' } });
  assert.equal(switched.status, 200);
  const portal = switched.body.data;
  assert.equal(portal.role_source, 'EMS');
  assert.equal(portal.roles.length, 3);
  assert.ok(portal.roles.every((r) => r.ems_role_id), 'only EMS roles remain');
  assert.ok(portal.roles.find((r) => r.role_name === 'Project Lead - Employee'));

  // Users were moved to the role matching their EMS role (test users have EMS role id 3 = "employee").
  const pull = await api('GET', '/api/v1/portal-sync/access', {
    headers: { Authorization: `Basic ${Buffer.from(`EMS_HRMS:${(await api('POST', '/api/v1/portals/EMS_HRMS/rotate-secret', { token: adminToken })).body.webhook_secret}`).toString('base64')}` },
  });
  const employeeRole = portal.roles.find((r) => r.ems_role_id === 3).role_code;
  assert.ok(pull.body.data.every((r) => r.role_code === employeeRole), 'everyone has their EMS role');

  // Manual role editing is blocked on EMS-sourced portals.
  assert.equal((await api('POST', '/api/v1/portals/EMS_HRMS/roles', { token: adminToken, body: { role_code: 'X1', role_name: 'X' } })).status, 409);

  // EMS changes someone's role -> portal role follows.
  const bilal = (await api('GET', '/api/v1/users?search=bilal', { token: adminToken })).body.data[0];
  await emsWebhook('user.upserted', {
    users: [emsUser({ ems_user_id: 102, email: 'bilal@corp.test', full_name: 'Bilal Ahmed', deployed_projects: [], ems_role: { ems_id: 23, name: 'Project Lead - Employee' } })],
  });
  const after = (await api('GET', `/api/v1/users/${bilal.id}`, { token: adminToken })).body.data;
  assert.equal(after.portal_access.find((a) => a.portal_code === 'EMS_HRMS').role_code, 'PROJECT_LEAD_EMPLOYEE');

  // Admin changes the role in SaaS -> event carries the EMS role id for write-back.
  await pool.query(`UPDATE portals SET webhook_url = (SELECT webhook_url FROM portals WHERE portal_code = 'CONTENT') WHERE portal_code = 'EMS_HRMS'`);
  const change = await api('POST', '/api/v1/users/portal-access', {
    token: adminToken,
    body: { user_id: bilal.id, portal_code: 'EMS_HRMS', role_code: 'ADMIN' },
  });
  assert.equal(change.body.event, 'access.role_changed');
  const ev = await pool.query(
    `SELECT payload FROM portal_sync_events WHERE user_id = $1 AND event_type = 'access.role_changed' ORDER BY created_at DESC LIMIT 1`,
    [bilal.id],
  );
  assert.equal(ev.rows[0].payload.access.role.ems_role_id, 1);
  assert.equal(ev.rows[0].payload.reason, 'ADMIN_ACTION');

  // A new EMS hire on an EMS-sourced auto-assign portal gets their own EMS role.
  const hire = await emsWebhook('user.upserted', {
    users: [emsUser({ ems_user_id: 301, email: 'lead@corp.test', full_name: 'Lead Hire', ems_role: { ems_id: 23, name: 'Project Lead - Employee' } })],
  });
  const hireUser = (await api('GET', `/api/v1/users/${hire.body.results[0].user_id}`, { token: adminToken })).body.data;
  assert.equal(hireUser.portal_access.find((a) => a.portal_code === 'EMS_HRMS').role_code, 'PROJECT_LEAD_EMPLOYEE');
});

test('roles fetched from the portal: connect, refresh, push, guards, token role_id', async () => {
  const rolesUrl = `http://127.0.0.1:${portalServer.address().port}/iam/roles`;
  mockPortalRoles = [
    { id: 'r-admin', name: 'Portal Admin', permissions: ['all'] },
    { id: 'r-editor', name: 'Editor', permissions: ['post.edit', { name: 'post.publish' }] },
  ];

  // 1) Connect: the portal does not have its secret yet -> fetch fails, portal is still created.
  mockRolesSecret = null;
  const created = await api('POST', '/api/v1/portals', {
    token: adminToken,
    body: { portal_name: 'Blog', portal_code: 'BLOG', role_source: 'PORTAL', roles_url: rolesUrl },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.roles_fetch.ok, false);
  assert.match(created.body.roles_fetch.error, /401/);
  assert.equal(created.body.data.roles.length, 0);
  assert.match(created.body.data.roles_sync_error, /401/);

  // 2) Portal team installs the secret -> "Fetch roles now" works.
  mockRolesSecret = created.body.webhook_secret;
  const refreshed = await api('POST', '/api/v1/portals/BLOG/refresh-roles', { token: adminToken });
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.body.stats.added, 2);
  const roles = refreshed.body.data.roles;
  assert.deepEqual(roles.map((r) => r.role_code).sort(), ['EDITOR', 'PORTAL_ADMIN']);
  assert.deepEqual(roles.find((r) => r.role_code === 'EDITOR').permissions, ['post.edit', 'post.publish']);
  assert.equal(refreshed.body.data.roles_sync_error, null);

  // 3) Assign a user, then the portal renames that role and drops the other.
  const bilal = (await api('GET', '/api/v1/users?search=bilal', { token: adminToken })).body.data[0];
  await api('POST', '/api/v1/users/portal-access', { token: adminToken, body: { user_id: bilal.id, portal_code: 'BLOG', role_code: 'EDITOR' } });
  mockPortalRoles = [{ id: 'r-editor', name: 'Content Editor', permissions: ['post.edit'] }];
  const again = await api('POST', '/api/v1/portals/BLOG/refresh-roles', { token: adminToken });
  const after = again.body.data.roles;
  assert.equal(after.length, 1, 'unused PORTAL_ADMIN removed');
  assert.equal(after[0].role_name, 'Content Editor');
  assert.equal(after[0].external_role_id, 'r-editor');
  // The user follows the renamed role (code changes, ON UPDATE CASCADE).
  const u = (await api('GET', `/api/v1/users/${bilal.id}`, { token: adminToken })).body.data;
  assert.equal(u.portal_access.find((a) => a.portal_code === 'BLOG').role_code, after[0].role_code);

  // 4) Portal pushes its catalogue itself (Basic auth with its credentials).
  const basic = `Basic ${Buffer.from(`BLOG:${mockRolesSecret}`).toString('base64')}`;
  const pushed = await api('POST', '/api/v1/portal-sync/roles', {
    headers: { Authorization: basic },
    body: [{ code: 'r-editor', label: 'Content Editor' }, { slug: 'r-viewer', title: 'Reader' }],
  });
  assert.equal(pushed.status, 200);
  assert.equal(pushed.body.added, 1);
  const bad = await api('POST', '/api/v1/portal-sync/roles', { headers: { Authorization: basic }, body: { nope: true } });
  assert.equal(bad.status, 422);

  // 5) Hand editing is blocked; the full access list carries the portal's own role id.
  assert.equal((await api('POST', '/api/v1/portals/BLOG/roles', { token: adminToken, body: { role_code: 'X1', role_name: 'X' } })).status, 409);
  const pull = await api('GET', '/api/v1/portal-sync/access', { headers: { Authorization: basic } });
  assert.equal(pull.body.data[0].role_id, 'r-editor');

  // 6) Token issued for this portal carries role_id = the portal's own id.
  await pool.query(`UPDATE saas_users SET password_hash = $2 WHERE id = $1`, [bilal.id, await (await import('bcryptjs')).default.hash('blog-pass-123', 4)]);
  const tok = await api('POST', '/api/v1/auth/token', { body: { email: 'bilal@corp.test', password: 'blog-pass-123', portal_code: 'BLOG' } });
  assert.equal(tok.status, 200);
  assert.equal(tok.body.role_id, 'r-editor');

  // 7) Switching a hand-made portal to portal roles links same-name roles (users keep them).
  mockPortalRoles = [{ id: 'mgr-1', name: 'Manager' }];
  await api('POST', '/api/v1/portals', { token: adminToken, body: { portal_name: 'Ops', portal_code: 'OPS', roles: [{ role_code: 'MANAGER', role_name: 'Manager' }] } });
  await api('POST', '/api/v1/users/portal-access', { token: adminToken, body: { user_id: bilal.id, portal_code: 'OPS', role_code: 'MANAGER' } });
  // OPS has its own secret; serve roles for it too.
  mockRolesSecret = (await api('POST', '/api/v1/portals/OPS/rotate-secret', { token: adminToken })).body.webhook_secret;
  const sw = await api('PATCH', '/api/v1/portals/OPS', { token: adminToken, body: { role_source: 'PORTAL', roles_url: rolesUrl } });
  assert.equal(sw.body.roles_fetch.ok, true);
  assert.deepEqual(sw.body.data.roles.map((r) => [r.role_code, r.external_role_id]), [['MANAGER', 'mgr-1']]);
});

test('overview and activity', async () => {
  const o = (await api('GET', '/api/v1/overview', { token: adminToken })).body.data;
  assert.equal(o.users.total, 6);
  assert.equal(o.users.ems, 6);
  assert.ok(o.last_ems_sync_at);
  const a = (await api('GET', '/api/v1/activity?limit=5', { token: adminToken })).body.data;
  assert.equal(a.length, 5);
  assert.ok(a.every((x) => x.actor_label !== 'EMS_WEBHOOK'));
});

test('real HRMS payloads via the Laravel client (optional)', { skip: !process.env.HRMS_PATH }, async () => {
  // Builds real employee payloads with App\Services\Saas\EmsUserPayloadBuilder
  // and signs them in PHP exactly like SaasWebhookClient (hash_hmac over
  // "<ts>.<body>"). Sent with PHP streams so it also works when the HRMS
  // vendor/ lacks Guzzle. Read-only on MySQL.
  // String.raw keeps PHP backslashes (namespaces, "\r\n") intact.
  const script = String.raw`
    config(['saas.sync_password_hash' => true]);
    $b = app(App\Services\Saas\EmsUserPayloadBuilder::class);
    $built = $b->forIds($b->allIds());
    $out = [];
    foreach (array_chunk($built['users'], 100) as $chunk) {
      $body = json_encode(['event_id' => (string) Illuminate\Support\Str::uuid(), 'event' => 'user.upserted',
        'occurred_at' => now()->toIso8601String(), 'data' => ['users' => $chunk]], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
      $ts = (string) time();
      $sig = hash_hmac('sha256', $ts.'.'.$body, '${SECRET}');
      $ctx = stream_context_create(['http' => ['method' => 'POST', 'ignore_errors' => true, 'timeout' => 30,
        'header' => "Content-Type: application/json\r\nX-EMS-Timestamp: $ts\r\nX-EMS-Signature: v1=$sig\r\n", 'content' => $body]]);
      $res = json_decode(file_get_contents('${base}/api/v1/webhooks/ems-user', false, $ctx), true);
      foreach (($res['results'] ?? [['outcome' => 'http_error:'.json_encode($res)]]) as $r) { $out[$r['outcome']] = ($out[$r['outcome']] ?? 0) + 1; }
    }
    echo json_encode(['sent' => count($built['users']), 'skipped' => count($built['skipped']), 'outcomes' => $out]);`;
  // Async on purpose: a sync exec would block this process's event loop, and
  // the API server could not answer PHP's HTTP calls.
  // One line: Windows mangles multi-line CLI arguments.
  const oneLine = script.replace(/\s*\n\s*/g, ' ');
  const { stdout, stderr } = await promisify(execFile)('php', ['artisan', 'tinker', '--execute', oneLine], {
    cwd: process.env.HRMS_PATH,
    timeout: 120_000,
  });
  const start = stdout.indexOf('{"sent"');
  assert.ok(start > -1, `Unexpected PHP output:\n${stdout}\n${stderr}`);
  const result = JSON.parse(stdout.slice(start));
  console.log('HRMS live push:', result);
  assert.ok(result.sent > 0);
  assert.equal(result.outcomes.error ?? 0, 0, 'no record-level rejections');
});
