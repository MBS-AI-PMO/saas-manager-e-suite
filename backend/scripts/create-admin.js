/**
 * Bootstrap or promote a dashboard administrator.
 *
 *   npm run admin:create -- --email admin@company.com --name "Jane Admin" [--role SUPER_ADMIN]
 *
 * The password is read from the SAAS_ADMIN_PASSWORD env var so it never ends
 * up in shell history. If the email already exists (e.g. synced from EMS), the
 * user is promoted and keeps their source; the password is only set when given.
 */
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import pg from 'pg';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

const email = arg('email')?.trim().toLowerCase();
const name = arg('name') ?? 'SaaS Administrator';
const role = (arg('role') ?? 'SUPER_ADMIN').toUpperCase();
const password = process.env.SAAS_ADMIN_PASSWORD;

if (!email || !['SUPER_ADMIN', 'ADMIN'].includes(role)) {
  console.error('Usage: SAAS_ADMIN_PASSWORD=... npm run admin:create -- --email you@company.com [--name "..."] [--role SUPER_ADMIN|ADMIN]');
  process.exit(1);
}
if (password && password.length < 12) {
  console.error('SAAS_ADMIN_PASSWORD must be at least 12 characters.');
  process.exit(1);
}

const client = new pg.Client({ ssl: ['1', 'true'].includes(String(process.env.PGSSL)) ? { rejectUnauthorized: true } : false });

try {
  await client.connect();
  const hash = password ? await bcrypt.hash(password, 12) : null;
  const existing = (await client.query('SELECT id FROM saas_users WHERE email = $1', [email])).rows[0];

  if (existing) {
    await client.query(
      `UPDATE saas_users SET saas_admin_role = $2, password_hash = COALESCE($3, password_hash) WHERE id = $1`,
      [existing.id, role, hash],
    );
    console.log(`Promoted existing user ${email} to ${role}.`);
  } else {
    if (!hash) throw new Error('SAAS_ADMIN_PASSWORD is required when creating a new admin.');
    await client.query(
      `INSERT INTO saas_users (source, full_name, email, password_hash, saas_admin_role)
       VALUES ('DIRECT_SAAS', $1, $2, $3, $4)`,
      [name, email, hash, role],
    );
    console.log(`Created ${role} ${email}.`);
  }
} catch (err) {
  console.error(`Failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
