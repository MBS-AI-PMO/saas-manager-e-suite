/**
 * Copy everything from the `npm run dev:memory` database (.dev-db, PGlite)
 * into the PostgreSQL configured in .env. IDs, secrets, versions and audit
 * history are kept as they are, so connected systems (HRMS, IMS) keep working.
 *
 *   npm run migrate              # schema first
 *   npm run import:dev-memory    # then this (stop dev:memory before: it locks .dev-db)
 *
 * Refuses to run if the target already has users, so it can never overwrite
 * real data.
 */
import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Parents before children (foreign keys).
const TABLES = [
  'departments',
  'designations',
  'ems_roles',
  'portals',
  'portal_roles',
  'saas_users',
  'user_portal_access',
  'portal_sync_events',
  'audit_log',
];

// DEV_DB_PATH overrides the location (e.g. a copy of .dev-db).
const source = await PGlite.create(process.env.DEV_DB_PATH ?? path.join(root, '.dev-db'));
const target = new pg.Client({ ssl: ['1', 'true'].includes(String(process.env.PGSSL)) ? { rejectUnauthorized: true } : false });
await target.connect();

try {
  const existing = (await target.query('SELECT count(*)::int AS n FROM saas_users')).rows[0].n;
  if (existing > 0) throw new Error(`Target already has ${existing} users; refusing to import over real data.`);

  await target.query('BEGIN');
  for (const table of TABLES) {
    const { rows } = await source.query(`SELECT * FROM ${table}`);
    if (!rows.length) {
      console.log(`${table.padEnd(20)} 0`);
      continue;
    }
    const cols = Object.keys(rows[0]);
    const sql = `INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`;
    for (const row of rows) {
      // jsonb comes back as objects/arrays; send it back as JSON text.
      const values = cols.map((c) => {
        const v = row[c];
        return v !== null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v;
      });
      await target.query(sql, values);
    }
    console.log(`${table.padEnd(20)} ${rows.length}`);
  }
  // audit_log.id is a bigserial: continue after the imported ids.
  await target.query(`SELECT setval(pg_get_serial_sequence('audit_log', 'id'), GREATEST((SELECT max(id) FROM audit_log), 1))`);
  await target.query('COMMIT');
  console.log('Import complete.');
} catch (err) {
  await target.query('ROLLBACK').catch(() => {});
  console.error(`Import failed, nothing was written: ${err.message}`);
  process.exitCode = 1;
} finally {
  await target.end();
  await source.close();
}
