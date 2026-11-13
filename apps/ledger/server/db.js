import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Thin wrapper around node:sqlite with statement caching and nested transactions.
 */
export class Db {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.path = path;
    this.open();
  }
  open() {
    this.raw = new DatabaseSync(this.path);
    this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.cache = new Map();
    this.depth = 0;
    this.raw.exec(readFileSync(join(here, 'schema.sql'), 'utf8')); // also brings older backups up to the current schema
  }
  /** Replace the whole database with a SQLite image (used by restore-from-backup). */
  replaceWith(image) {
    if (this.path === ':memory:') throw new Error('Cannot replace an in-memory database');
    this.raw.close();
    for (const ext of ['-wal', '-shm']) rmSync(this.path + ext, { force: true });
    writeFileSync(this.path, image, { mode: 0o600 });
    this.open();
  }
  stmt(sql) {
    let s = this.cache.get(sql);
    if (!s) { s = this.raw.prepare(sql); this.cache.set(sql, s); }
    return s;
  }
  all(sql, ...p) { return this.stmt(sql).all(...p.map(norm)); }
  get(sql, ...p) { return this.stmt(sql).get(...p.map(norm)); }
  run(sql, ...p) { return this.stmt(sql).run(...p.map(norm)); }
  insert(sql, ...p) { return Number(this.run(sql, ...p).lastInsertRowid); }
  /** Run fn atomically. Nested calls use savepoints. */
  tx(fn) {
    const sp = `sp${this.depth}`;
    this.raw.exec(this.depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
    this.depth++;
    try {
      const r = fn();
      this.depth--;
      this.raw.exec(this.depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
      return r;
    } catch (e) {
      this.depth--;
      this.raw.exec(this.depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
      throw e;
    }
  }
  close() { this.raw.close(); }
}

function norm(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

/**
 * Where the books live. Default is a folder in the user's home directory (e.g. C:\Users\name\TrendwiseLedger),
 * deliberately outside the app folder so client data never ends up in OneDrive/Dropbox/git with the code.
 * Override with LEDGER_DATA_DIR (folder) or LEDGER_DB (exact file).
 */
export const dataDir = () => process.env.LEDGER_DATA_DIR || join(homedir(), 'TrendwiseLedger');
export const defaultDbPath = () => process.env.LEDGER_DB || join(dataDir(), 'ledger.db');
const LEGACY_DB = join(here, '..', 'data', 'ledger.db');

/**
 * One-time move from the old location inside the app folder. Uses VACUUM INTO for a consistent copy
 * (including anything still in the write-ahead log). The old file is left in place, untouched.
 */
export function migrateLegacyDb(target = defaultDbPath()) {
  if (process.env.LEDGER_DB || existsSync(target) || !existsSync(LEGACY_DB)) return null;
  mkdirSync(dirname(target), { recursive: true });
  const old = new DatabaseSync(LEGACY_DB);
  try { old.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`); } finally { old.close(); }
  writeFileSync(join(dirname(LEGACY_DB), 'MOVED - READ ME.txt'),
    `Your Trendwise Ledger books were moved to:\r\n${target}\r\n\r\nThe ledger.db file in this folder is an old copy and is no longer used.\r\nAfter confirming everything looks right in the app, you can delete this "data" folder.\r\n`);
  return { from: LEGACY_DB, to: target };
}

export function openDb(path = defaultDbPath()) {
  return new Db(path);
}
