/**
 * Apply db/migrations/*.sql in filename order, once each.
 *   npm run migrate          -> migrations only
 *   npm run seed             -> migrations, then db/seeds/*.sql (seeds are idempotent)
 *
 * Uses PG* variables from .env directly (does not load the full app config,
 * so it runs before JWT keys exist).
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const withSeeds = process.argv.includes('--seed');

const client = new pg.Client({ ssl: ['1', 'true'].includes(String(process.env.PGSSL)) ? { rejectUnauthorized: true } : false });

function sqlFiles(dir) {
  const abs = path.join(root, dir);
  return fs.existsSync(abs) ? fs.readdirSync(abs).filter((f) => f.endsWith('.sql')).sort().map((f) => path.join(abs, f)) : [];
}

async function main() {
  await client.connect();
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename varchar(255) PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);

  const applied = new Set((await client.query('SELECT filename FROM schema_migrations')).rows.map((r) => r.filename));

  for (const file of sqlFiles('db/migrations')) {
    const name = path.basename(file);
    if (applied.has(name)) continue;
    process.stdout.write(`Applying ${name} ... `);
    // Migration files manage their own BEGIN/COMMIT.
    await client.query(fs.readFileSync(file, 'utf8'));
    await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [name]);
    console.log('done');
  }

  if (withSeeds) {
    for (const file of sqlFiles('db/seeds')) {
      process.stdout.write(`Seeding ${path.basename(file)} ... `);
      await client.query(fs.readFileSync(file, 'utf8'));
      console.log('done');
    }
  }
}

main()
  .then(() => console.log('Database is up to date.'))
  .catch((err) => {
    console.error(`\nMigration failed: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => client.end());
