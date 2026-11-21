// Encryption for secrets kept in the database (Google refresh tokens, the OAuth client secret).
// AES-256-GCM with a random key stored next to the database, readable only by this user.
// Copying the database alone (without secret.key) does not expose the tokens.
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './db.js';

let cached = null;
export const keyPath = () => process.env.TASKBOARD_KEY_FILE || join(dataDir(), 'secret.key');

function key() {
  if (cached) return cached;
  const p = keyPath();
  if (!existsSync(p)) {
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, randomBytes(32).toString('base64'), { mode: 0o600, flag: 'wx' });
  }
  const k = Buffer.from(readFileSync(p, 'utf8').trim(), 'base64');
  if (k.length !== 32) throw new Error(`The key file ${p} is damaged. Restore it from a backup, or delete it and reconnect your Google accounts.`);
  return (cached = k);
}

/** "v1.<iv>.<tag>.<ciphertext>" (base64url parts). */
export function encrypt(text) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return ['v1', iv, c.getAuthTag(), data].map((x) => (typeof x === 'string' ? x : x.toString('base64url'))).join('.');
}

export function decrypt(blob) {
  const [v, iv, tag, data] = String(blob).split('.');
  if (v !== 'v1') throw new Error('Unknown secret format');
  const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
}

/** For tests: forget the cached key so a different key file can be used. */
export const resetKeyCache = () => { cached = null; };
