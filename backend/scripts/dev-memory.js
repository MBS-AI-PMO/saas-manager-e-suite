/**
 * Run the full API with NO PostgreSQL install: an embedded PostgreSQL (PGlite)
 * served over the wire protocol, migrated and seeded, plus dev JWT keys.
 * Data is kept in ./.dev-db between restarts (delete the folder to reset).
 * Set DEV_MEMORY_EPHEMERAL=true for a throwaway in-memory database.
 * For local development and demos only.
 *
 *   npm run dev:memory
 *   -> API on http://localhost:4000, admin: admin@local.test / admin-password-123
 *
 * EMS_WEBHOOK_SECRET is taken from .env if set (so a local HRMS can push to it),
 * otherwise a random one is generated and printed.
 */
import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import bcrypt from 'bcryptjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PG_PORT = Number(process.env.DEV_MEMORY_PG_PORT ?? 54329);

const dataDir = process.env.DEV_MEMORY_EPHEMERAL === 'true' ? undefined : path.join(root, '.dev-db');
const db = await PGlite.create(dataDir);
// Example portals are opt-in: real portals are added from the dashboard.
const dirs = process.env.DEV_MEMORY_SEED_EXAMPLES === 'true' ? ['db/migrations', 'db/seeds'] : ['db/migrations'];
for (const dir of dirs) {
  for (const f of fs.readdirSync(path.join(root, dir)).filter((x) => x.endsWith('.sql')).sort()) {
    await db.exec(fs.readFileSync(path.join(root, dir, f), 'utf8'));
  }
}
await db.query(
  `INSERT INTO saas_users (source, full_name, email, password_hash, saas_admin_role)
   VALUES ('DIRECT_SAAS', 'Local Admin', 'admin@local.test', $1, 'SUPER_ADMIN')
   ON CONFLICT (email) DO NOTHING`,
  [await bcrypt.hash('admin-password-123', 10)],
);
// Example portals point at example.com; drop their webhooks so the outbox does
// not retry forever against hosts that do not exist.
await db.query(`UPDATE portals SET webhook_url = NULL WHERE webhook_url LIKE '%.example.com%'`);

const server = new PGLiteSocketServer({ db, port: PG_PORT, host: '127.0.0.1' });
await server.start();

const keyDir = dataDir ? path.join(root, '.dev-keys') : fs.mkdtempSync(path.join(os.tmpdir(), 'iam-dev-keys-'));
fs.mkdirSync(keyDir, { recursive: true });
if (!fs.existsSync(path.join(keyDir, 'private.pem'))) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  fs.writeFileSync(path.join(keyDir, 'private.pem'), privateKey);
  fs.writeFileSync(path.join(keyDir, 'public.pem'), publicKey);
}

const webhookSecret =
  process.env.EMS_WEBHOOK_SECRET?.length >= 32 ? process.env.EMS_WEBHOOK_SECRET : crypto.randomBytes(32).toString('hex');

Object.assign(process.env, {
  PGHOST: '127.0.0.1',
  PGPORT: String(PG_PORT),
  PGDATABASE: 'postgres',
  PGUSER: 'postgres',
  PGPASSWORD: 'postgres',
  PGSSL: 'false',
  PG_POOL_MAX: '1', // PGlite is a single session; the pool queues requests
  EMS_WEBHOOK_SECRET: webhookSecret,
  JWT_ISSUER: process.env.JWT_ISSUER ?? 'http://localhost:4100',
  JWT_PRIVATE_KEY_PATH: path.join(keyDir, 'private.pem'),
  JWT_PUBLIC_KEY_PATH: path.join(keyDir, 'public.pem'),
  JWT_KEY_ID: 'dev-memory',
});

console.log(`Embedded PostgreSQL on 127.0.0.1:${PG_PORT} (${dataDir ? `data: ${dataDir}` : 'in-memory, not saved'})`);
console.log('Dashboard admin: admin@local.test / admin-password-123');
if (webhookSecret !== process.env.EMS_WEBHOOK_SECRET) console.log(`EMS_WEBHOOK_SECRET=${webhookSecret}`);

await import('../src/server.js');
