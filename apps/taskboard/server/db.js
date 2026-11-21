import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Thin wrapper around node:sqlite with statement caching and nested transactions (same as Trendwise Ledger). */
export class Db {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.path = path;
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.cache = new Map();
    this.depth = 0;
    this.raw.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));
    this.addMissingColumns();
  }
  /** Bring databases made by older versions up to date (CREATE TABLE IF NOT EXISTS never adds columns). */
  addMissingColumns() {
    for (const [table, col, type] of UPGRADES) {
      if (!this.raw.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)) this.raw.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
    }
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

// Columns added after v0.1, as [table, column, type].
const UPGRADES = [
  ['accounts', 'scopes', 'TEXT'],
  ['accounts', 'gtasks_list_id', 'TEXT'],
  ['accounts', 'gtasks_synced_at', 'TEXT'],
  ['tasks', 'gtask_updated', 'TEXT'],
  ['tasks', 'gtask_dirty', 'INTEGER NOT NULL DEFAULT 0'],
  // v0.3
  ['sources', 'meta', 'TEXT'],
  ['sources', 'excerpt', 'TEXT'],
  ['sources', 'occurred_at', 'TEXT'],
  ['sources', 'attempts', 'INTEGER NOT NULL DEFAULT 0'],
  ['sources', 'last_error', 'TEXT'],
  ['sources', 'dismissed', 'INTEGER NOT NULL DEFAULT 0'],
];

function norm(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

/**
 * Where the board lives: a folder in the home directory (e.g. C:\Users\name\McKaysTaskboard), outside the app folder
 * so email-derived data and Google tokens never sync to OneDrive or end up in git. Override with TASKBOARD_DATA_DIR.
 */
export const dataDir = () => process.env.TASKBOARD_DATA_DIR || join(homedir(), 'McKaysTaskboard');
export const defaultDbPath = () => process.env.TASKBOARD_DB || join(dataDir(), 'taskboard.db');
export const openDb = (path = defaultDbPath()) => new Db(path);
