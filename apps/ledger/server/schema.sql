-- Trendwise Ledger schema. All money is stored as INTEGER cents.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin','accountant','standard','viewer')),
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  legal_name TEXT,
  ein TEXT,
  email TEXT,
  phone TEXT,
  address TEXT,
  fiscal_year_start_month INTEGER NOT NULL DEFAULT 1 CHECK (fiscal_year_start_month BETWEEN 1 AND 12),
  closing_date TEXT,              -- books closed through this date (inclusive)
  default_terms_days INTEGER NOT NULL DEFAULT 30,
  invoice_footer TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  number TEXT,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  detail_type TEXT,
  parent_id INTEGER REFERENCES accounts(id),
  description TEXT,
  system_key TEXT,                -- AR, AP, UNDEPOSITED, OPENING_EQUITY, RETAINED_EARNINGS, SALES_TAX
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, name),
  UNIQUE (company_id, system_key)
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  company_name TEXT,
  contact_name TEXT,
  email TEXT,
  phone TEXT,
  billing_address TEXT,
  terms_days INTEGER,
  taxable INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, display_name)
);

CREATE TABLE IF NOT EXISTS vendors (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  company_name TEXT,
  contact_name TEXT,
  email TEXT,
  phone TEXT,
  address TEXT,
  terms_days INTEGER,
  tax_id TEXT,
  is_1099 INTEGER NOT NULL DEFAULT 0,
  default_account_id INTEGER REFERENCES accounts(id),
  notes TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, display_name)
);

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sku TEXT,
  type TEXT NOT NULL DEFAULT 'service' CHECK (type IN ('service','non_inventory')),
  description TEXT,
  sales_price INTEGER NOT NULL DEFAULT 0,
  cost INTEGER NOT NULL DEFAULT 0,
  income_account_id INTEGER REFERENCES accounts(id),
  expense_account_id INTEGER REFERENCES accounts(id),
  taxable INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, name)
);

CREATE TABLE IF NOT EXISTS tax_rates (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  rate REAL NOT NULL,             -- percent, e.g. 8.375
  is_active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (company_id, name)
);

-- A business document (invoice, bill, check, journal entry, ...).
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  number TEXT,
  date TEXT NOT NULL,
  due_date TEXT,
  customer_id INTEGER REFERENCES customers(id),
  vendor_id INTEGER REFERENCES vendors(id),
  account_id INTEGER REFERENCES accounts(id),   -- deposit-to / payment / from account depending on type
  to_account_id INTEGER REFERENCES accounts(id),-- transfers
  tax_rate_id INTEGER REFERENCES tax_rates(id),
  subtotal INTEGER NOT NULL DEFAULT 0,
  tax_amount INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  memo TEXT,
  billing_address TEXT,
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','voided')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_txn_company_type ON transactions(company_id, type, date);
CREATE INDEX IF NOT EXISTS ix_txn_customer ON transactions(customer_id);
CREATE INDEX IF NOT EXISTS ix_txn_vendor ON transactions(vendor_id);

-- What the user entered on the document.
CREATE TABLE IF NOT EXISTS transaction_lines (
  id INTEGER PRIMARY KEY,
  transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  item_id INTEGER REFERENCES items(id),
  account_id INTEGER REFERENCES accounts(id),
  description TEXT,
  qty REAL,
  rate INTEGER,
  amount INTEGER NOT NULL DEFAULT 0,          -- for journal entries: debit - credit
  taxable INTEGER NOT NULL DEFAULT 0,
  customer_id INTEGER REFERENCES customers(id),
  vendor_id INTEGER REFERENCES vendors(id),
  linked_txn_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL  -- deposits: the undeposited payment being deposited
);
CREATE INDEX IF NOT EXISTS ix_lines_txn ON transaction_lines(transaction_id);
CREATE INDEX IF NOT EXISTS ix_lines_linked ON transaction_lines(linked_txn_id);

-- Payments / credits applied to open documents.
CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY,
  source_txn_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  target_txn_id INTEGER NOT NULL REFERENCES transactions(id),
  amount INTEGER NOT NULL CHECK (amount > 0)
);
CREATE INDEX IF NOT EXISTS ix_app_source ON applications(source_txn_id);
CREATE INDEX IF NOT EXISTS ix_app_target ON applications(target_txn_id);

CREATE TABLE IF NOT EXISTS reconciliations (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  statement_date TEXT NOT NULL,
  beginning_balance INTEGER NOT NULL,
  ending_balance INTEGER NOT NULL,
  cleared_count INTEGER NOT NULL DEFAULT 0,
  completed_by INTEGER REFERENCES users(id),
  completed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The general ledger. Generated from transactions; never edited directly.
CREATE TABLE IF NOT EXISTS journal_lines (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  debit INTEGER NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit INTEGER NOT NULL DEFAULT 0 CHECK (credit >= 0),
  customer_id INTEGER REFERENCES customers(id),
  vendor_id INTEGER REFERENCES vendors(id),
  memo TEXT,
  cleared TEXT NOT NULL DEFAULT '' CHECK (cleared IN ('','C','R')),
  reconciliation_id INTEGER REFERENCES reconciliations(id)
);
CREATE INDEX IF NOT EXISTS ix_jl_account_date ON journal_lines(account_id, date);
CREATE INDEX IF NOT EXISTS ix_jl_company_date ON journal_lines(company_id, date);
CREATE INDEX IF NOT EXISTS ix_jl_txn ON journal_lines(transaction_id);

-- Downloaded / imported bank and card activity awaiting review.
CREATE TABLE IF NOT EXISTS bank_feed (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  date TEXT NOT NULL,
  description TEXT NOT NULL,
  amount INTEGER NOT NULL,        -- positive = money in, negative = money out
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'review' CHECK (status IN ('review','added','matched','excluded')),
  suggested_account_id INTEGER REFERENCES accounts(id),
  suggested_vendor_id INTEGER REFERENCES vendors(id),
  suggested_customer_id INTEGER REFERENCES customers(id),
  rule_id INTEGER,
  txn_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
  import_batch TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (account_id, fingerprint)
);

CREATE TABLE IF NOT EXISTS bank_rules (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  direction TEXT NOT NULL DEFAULT 'out' CHECK (direction IN ('in','out','any')),
  match_text TEXT NOT NULL,
  bank_account_id INTEGER REFERENCES accounts(id),   -- null = all accounts
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  vendor_id INTEGER REFERENCES vendors(id),
  customer_id INTEGER REFERENCES customers(id),
  auto_add INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 100,
  is_active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id),
  at TEXT NOT NULL DEFAULT (datetime('now')),
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id INTEGER,
  summary TEXT
);
CREATE INDEX IF NOT EXISTS ix_audit_company ON audit_log(company_id, at);

CREATE TABLE IF NOT EXISTS saved_reports (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  report TEXT NOT NULL,
  params TEXT NOT NULL DEFAULT '{}',   -- JSON of report query params (uses relative periods where chosen)
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, name)
);
