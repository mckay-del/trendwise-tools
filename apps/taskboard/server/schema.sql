-- McKay's Taskboard schema.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Connected Google Workspace accounts (OAuth arrives in step 2; manual tasks need none).
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  domain TEXT,
  color TEXT NOT NULL DEFAULT '#b08d57',
  refresh_token_enc TEXT,
  gmail_history_id TEXT,
  calendar_sync TEXT,          -- JSON {calendarId: syncToken}
  last_sync_at TEXT,
  last_result TEXT,            -- JSON
  needs_reconnect INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Emails, events and Google Tasks the agent has seen (filled from step 3).
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('email','event','gtask')),
  external_id TEXT NOT NULL,
  title TEXT,
  snippet TEXT,
  link TEXT,
  content_hash TEXT,
  processed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (account_id, kind, external_id)
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  notes TEXT,
  col TEXT NOT NULL DEFAULT 'later' CHECK (col IN ('today','week','later','waiting')),
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','dismissed')),
  position REAL NOT NULL DEFAULT 0,
  origin TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual','ai','gtasks')),
  pinned INTEGER NOT NULL DEFAULT 0,  -- moved by hand: the agent won't move it again
  account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL,
  ai_reason TEXT,
  gtask_id TEXT,
  gtask_list_id TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS tasks_board ON tasks (status, col, position);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
