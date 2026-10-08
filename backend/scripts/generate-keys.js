/**
 * Generate the RS256 key pair used to sign admin and portal JWTs.
 *   npm run keys:generate            -> writes keys/ (refuses to overwrite)
 *   npm run keys:generate -- --force -> rotate (invalidates every issued token)
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(process.cwd(), 'keys');
const privPath = path.join(dir, 'jwt-private.pem');
const pubPath = path.join(dir, 'jwt-public.pem');

if (fs.existsSync(privPath) && !process.argv.includes('--force')) {
  console.error(`${privPath} already exists. Pass --force to rotate keys.`);
  process.exit(1);
}

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 3072,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(privPath, privateKey, { mode: 0o600 });
fs.writeFileSync(pubPath, publicKey);
console.log(`Wrote ${privPath}\nWrote ${pubPath}\nKeep the private key out of version control.`);
