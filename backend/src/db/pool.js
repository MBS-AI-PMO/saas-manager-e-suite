/**
 * PostgreSQL connection pool and transaction helper.
 */
import pg from 'pg';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

// Return BIGINT/NUMERIC as strings (pg default) but parse timestamptz to Date.
export const pool = new pg.Pool({
  host: env.PGHOST,
  port: env.PGPORT,
  database: env.PGDATABASE,
  user: env.PGUSER,
  password: env.PGPASSWORD,
  max: env.PG_POOL_MAX,
  ssl: env.PGSSL ? { rejectUnauthorized: true } : false,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  // Kill runaway statements instead of letting them hold connections forever.
  statement_timeout: 15_000,
  application_name: 'saas-identity-api',
});

// An idle client erroring (e.g. DB restart) must not crash the process.
pool.on('error', (err) => logger.error('Idle PostgreSQL client error', { error: err.message }));

/** Run a single statement on the pool. */
export function query(text, params) {
  return pool.query(text, params);
}

/**
 * Run `fn(client)` inside BEGIN/COMMIT. Any thrown error rolls back and is
 * re-thrown. The client is always released.
 *
 * @template T
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      logger.error('ROLLBACK failed', { error: rollbackErr.message });
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Verify connectivity at boot. */
export async function assertDatabaseReachable() {
  const { rows } = await pool.query('SELECT 1 AS ok');
  return rows[0]?.ok === 1;
}
