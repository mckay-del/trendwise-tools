import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Thin wrapper around node:sqlite with statement caching and nested transactions.
 */
export class Db {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.cache = new Map();
    this.depth = 0;
    this.raw.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));
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

export function openDb(path = process.env.LEDGER_DB || join(here, '..', 'data', 'ledger.db')) {
  return new Db(path);
}
