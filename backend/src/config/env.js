/**
 * Environment loading and validation.
 *
 * The process refuses to start with a missing or malformed setting, so a bad
 * deploy fails loudly at boot instead of at the first webhook.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const bool = z
  .string()
  .optional()
  .transform((v) => ['1', 'true', 'yes'].includes(String(v ?? '').toLowerCase()));

const int = (fallback) => z.coerce.number().int().positive().default(fallback);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: int(4000),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),

  PGHOST: z.string().min(1),
  PGPORT: int(5432),
  PGDATABASE: z.string().min(1),
  PGUSER: z.string().min(1),
  PGPASSWORD: z.string().default(''),
  PGSSL: bool,
  PG_POOL_MAX: int(20),

  EMS_WEBHOOK_SECRET: z.string().min(32, 'EMS_WEBHOOK_SECRET must be at least 32 characters'),
  EMS_WEBHOOK_TOLERANCE_SECONDS: int(300),

  JWT_ISSUER: z.string().url(),
  // Keys as files (local) or as PEM text in the environment (containers):
  // JWT_PRIVATE_KEY / JWT_PUBLIC_KEY win over the *_PATH settings. "\n" escapes are accepted.
  JWT_PRIVATE_KEY_PATH: z.string().default('./keys/jwt-private.pem'),
  JWT_PUBLIC_KEY_PATH: z.string().default('./keys/jwt-public.pem'),
  JWT_PRIVATE_KEY: z.string().optional(),
  JWT_PUBLIC_KEY: z.string().optional(),
  JWT_KEY_ID: z.string().min(1),
  PORTAL_TOKEN_TTL_SECONDS: int(900),
  ADMIN_TOKEN_TTL_SECONDS: int(28800),

  OUTBOX_POLL_INTERVAL_MS: int(3000),
  OUTBOX_BATCH_SIZE: int(25),
  OUTBOX_MAX_ATTEMPTS: int(12),
  OUTBOX_HTTP_TIMEOUT_MS: int(10000),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  // eslint-disable-next-line no-console
  console.error(`Invalid environment configuration:\n${issues}`);
  process.exit(1);
}

const raw = parsed.data;

/** PEM pasted into an env var (single line with \n escapes, or real newlines). */
function pemFromEnv(value) {
  if (!value?.trim()) return undefined;
  return `${value.replace(/\\n/g, '\n').trim()}\n`;
}

/** Read a PEM file relative to the project root, with a clear error. */
function readKey(p, label) {
  const abs = path.resolve(process.cwd(), p);
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch {
    // eslint-disable-next-line no-console
    console.error(`Cannot read ${label} at ${abs}. Run "npm run keys:generate" first.`);
    process.exit(1);
  }
}

export const env = Object.freeze({
  ...raw,
  isProduction: raw.NODE_ENV === 'production',
  corsOrigins: raw.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
  jwtPrivateKey: pemFromEnv(raw.JWT_PRIVATE_KEY) ?? readKey(raw.JWT_PRIVATE_KEY_PATH, 'JWT private key'),
  jwtPublicKey: pemFromEnv(raw.JWT_PUBLIC_KEY) ?? readKey(raw.JWT_PUBLIC_KEY_PATH, 'JWT public key'),
});
