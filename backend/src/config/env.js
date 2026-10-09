/**
 * Environment loading and validation.
 *
 * The process refuses to start with a missing or malformed setting, so a bad
 * deploy fails loudly at boot instead of at the first webhook.
 */
import 'dotenv/config';
import crypto from 'node:crypto';
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

/**
 * PEM pasted into an env var. Hosting panels mangle it in different ways (real
 * newlines, "\n" or "\\n" escapes, surrounding quotes, newlines turned into
 * spaces), so rebuild a clean PEM from the BEGIN/END labels and the base64 body.
 */
function pemFromEnv(value) {
  if (!value?.trim()) return undefined;
  const text = value
    .trim()
    .replace(/^(['"])([\s\S]*)\1$/, '$2') // surrounding quotes
    .replace(/\\+r/g, '')
    .replace(/\\+n/g, '\n');
  const m = text.match(/-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/);
  if (!m) return text.endsWith('\n') ? text : `${text}\n`; // let the key check below report it
  const body = m[2].replace(/[^A-Za-z0-9+/=]/g, '');
  return `-----BEGIN ${m[1]}-----\n${body.match(/.{1,64}/g).join('\n')}\n-----END ${m[1]}-----\n`;
}

/** Fail at boot with the variable name instead of a crypto stack trace later. */
function checkKey(pem, kind, source) {
  try {
    (kind === 'private' ? crypto.createPrivateKey : crypto.createPublicKey)(pem);
    return pem;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(
      `${source} is not a valid PEM ${kind} key (${e.code || e.message}). ` +
        'Paste the whole key including the -----BEGIN/END----- lines, as one line with \\n or with real newlines.',
    );
    process.exit(1);
  }
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
  jwtPrivateKey: raw.JWT_PRIVATE_KEY?.trim()
    ? checkKey(pemFromEnv(raw.JWT_PRIVATE_KEY), 'private', 'JWT_PRIVATE_KEY')
    : checkKey(readKey(raw.JWT_PRIVATE_KEY_PATH, 'JWT private key'), 'private', raw.JWT_PRIVATE_KEY_PATH),
  jwtPublicKey: raw.JWT_PUBLIC_KEY?.trim()
    ? checkKey(pemFromEnv(raw.JWT_PUBLIC_KEY), 'public', 'JWT_PUBLIC_KEY')
    : checkKey(readKey(raw.JWT_PUBLIC_KEY_PATH, 'JWT public key'), 'public', raw.JWT_PUBLIC_KEY_PATH),
});
