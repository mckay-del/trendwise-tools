// Command-line backup & restore.
//   npm run backup  -- [--out <dir>]              (passphrase from LEDGER_BACKUP_PASSPHRASE or prompt)
//   npm run restore -- <file.twlbak> --to <path.db> [--force]
// Restore writes a NEW database file; point LEDGER_DB at it (or replace the old file while the app is stopped).
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { openDb, dataDir, migrateLegacyDb } from './db.js';
import { createBackup, decryptBackup } from './backup.js';

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const cmd = args[0];

async function passphrase(confirm) {
  if (process.env.LEDGER_BACKUP_PASSPHRASE) return process.env.LEDGER_BACKUP_PASSPHRASE;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((r) => rl.question(q, r));
  const a = await ask('Backup passphrase: ');
  if (confirm && (await ask('Confirm passphrase: ')) !== a) { rl.close(); throw new Error('Passphrases do not match'); }
  rl.close();
  return a;
}

try {
  if (cmd === 'backup') {
    const out = resolve(flag('--out') ?? join(dataDir(), 'backups'));
    mkdirSync(out, { recursive: true });
    migrateLegacyDb();
    const db = openDb();
    const bytes = createBackup(db, await passphrase(true));
    db.close();
    const file = join(out, `ledger-backup-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.twlbak`);
    writeFileSync(file, bytes, { mode: 0o600 });
    console.log(`Encrypted backup written to ${file} (${(bytes.length / 1024).toFixed(0)} KB)`);
  } else if (cmd === 'restore') {
    const src = args[1];
    const to = flag('--to');
    if (!src || !to) throw new Error('Usage: npm run restore -- <file.twlbak> --to <new.db> [--force]');
    if (existsSync(to) && !args.includes('--force')) throw new Error(`${to} already exists. Use --force to overwrite (stop the app first).`);
    const image = decryptBackup(readFileSync(src), await passphrase(false));
    writeFileSync(to, image, { mode: 0o600 });
    const check = new DatabaseSync(to);
    const ok = check.prepare('PRAGMA integrity_check').get();
    const companies = check.prepare('SELECT COUNT(*) AS n FROM companies').get().n;
    check.close();
    console.log(`Restored to ${to} — integrity: ${Object.values(ok)[0]}, companies: ${companies}`);
    console.log(`Start the app with LEDGER_DB=${resolve(to)} npm start`);
  } else {
    console.log('Usage:\n  npm run backup -- [--out <dir>]\n  npm run restore -- <file.twlbak> --to <path.db> [--force]');
  }
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
