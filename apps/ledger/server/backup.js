// Encrypted backups of the whole ledger database.
// Format: "TWLBAK1\n" | salt(16) | iv(12) | authTag(16) | AES-256-GCM(gzip(sqlite file))
// Key = scrypt(passphrase, salt). Without the passphrase the file is unreadable — there is no recovery.
import { scryptSync, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { readFileSync, rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bad } from './util.js';

const MAGIC = Buffer.from('TWLBAK1\n');
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function validatePassphrase(p) {
  if (typeof p !== 'string' || p.length < 12) throw bad('Backup passphrase must be at least 12 characters');
}

/** Snapshot the live database (consistent, even while in use) and return encrypted bytes. */
export function createBackup(db, passphrase) {
  validatePassphrase(passphrase);
  const dir = mkdtempSync(join(tmpdir(), 'ledger-bak-'));
  const snap = join(dir, 'snapshot.db');
  try {
    db.raw.exec(`VACUUM INTO '${snap.replace(/'/g, "''")}'`);
    const plain = gzipSync(readFileSync(snap));
    const salt = randomBytes(16), iv = randomBytes(12);
    const key = scryptSync(passphrase, salt, 32, SCRYPT);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
    const out = Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), enc]);
    db.run("INSERT INTO schema_meta (key, value) VALUES ('last_backup', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", new Date().toISOString());
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Decrypt a backup file's bytes back into a SQLite database image. */
export function decryptBackup(buf, passphrase) {
  if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) throw bad('Not a Trendwise Ledger backup file');
  let o = MAGIC.length;
  const salt = buf.subarray(o, (o += 16)), iv = buf.subarray(o, (o += 12)), tag = buf.subarray(o, (o += 16));
  const key = scryptSync(passphrase, salt, 32, SCRYPT);
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  try {
    return gunzipSync(Buffer.concat([d.update(buf.subarray(o)), d.final()]));
  } catch {
    throw bad('Wrong passphrase, or the backup file is damaged');
  }
}

export function lastBackup(db) {
  return db.get("SELECT value FROM schema_meta WHERE key = 'last_backup'")?.value ?? null;
}

/**
 * Check that decrypted bytes are a healthy Trendwise Ledger database. Returns counts for the confirmation message.
 */
export function inspectImage(image) {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-restore-'));
  const file = join(dir, 'check.db');
  try {
    writeFileSync(file, image);
    const c = new DatabaseSync(file);
    try {
      const ok = Object.values(c.prepare('PRAGMA integrity_check').get())[0];
      if (ok !== 'ok') throw bad('The backup file is damaged (integrity check failed)');
      const has = (t) => c.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
      if (!has('users') || !has('companies')) throw bad('That file is not a Trendwise Ledger backup');
      return { users: c.prepare('SELECT COUNT(*) AS n FROM users').get().n, companies: c.prepare('SELECT COUNT(*) AS n FROM companies').get().n };
    } finally { c.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
