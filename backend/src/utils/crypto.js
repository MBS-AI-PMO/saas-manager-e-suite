/**
 * HMAC signing helpers shared by the inbound EMS webhook and the outbound
 * target-portal webhooks. Both use the same scheme:
 *
 *   signature = hex( HMAC_SHA256( secret, `${unixTimestamp}.${rawBody}` ) )
 *
 * Including the timestamp in the signed string stops an attacker from replaying
 * an old body with a fresh timestamp header.
 */
import crypto from 'node:crypto';

export function hmacHex(secret, timestamp, rawBody) {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

/** Constant-time comparison of two hex strings. */
export function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

/** Constant-time comparison of two arbitrary strings. */
export function safeEqualString(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Stable SHA-256 of a JSON value (keys sorted recursively). */
export function stableHash(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}
