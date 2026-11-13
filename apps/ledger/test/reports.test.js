import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../server/db.js';
import { createCompany, saveParty, saveItem } from '../server/services/names.js';
import { createTransaction } from '../server/services/transactions.js';
import { listAccounts } from '../server/services/accounts.js';
import { runReport, resolvePeriod, comparisonRange } from '../server/services/reports.js';
import { saveReport, listSaved } from '../server/services/saved.js';
import { saveFirm, getFirm } from '../server/services/firm.js';
import { createBackup, decryptBackup } from '../server/backup.js';

let db, co, A, acme, beta, vend;
const company = () => db.get('SELECT * FROM companies WHERE id = ?', co.id);
const row = (rep, label) => rep.rows.find((r) => r.cells[0] === label || String(r.cells[0]).endsWith(' ' + label));
const col = (rep, label) => rep.columns.findIndex((c) => c.label === label);

beforeEach(() => {
  db = new Db(':memory:');
  co = createCompany(db, { name: 'Test Co' });
  A = Object.fromEntries(listAccounts(db, co.id).map((a) => [a.name, a.id]));
  acme = saveParty(db, co.id, 'customers', { display_name: 'Acme' }).id;
  beta = saveParty(db, co.id, 'customers', { display_name: 'Beta' }).id;
  vend = saveParty(db, co.id, 'vendors', { display_name: 'Supplier' }).id;
  const item = saveItem(db, co.id, { name: 'Work', income_account_id: A['Services Revenue'] }).id;
  const T = (b) => createTransaction(db, co.id, b);
  // 2025: Acme $1,000; 2026: Acme $1,500 (Q1) + Beta $500 (Q2); expenses 2025 $400, 2026 $600
  T({ type: 'sales_receipt', date: '2025-03-10', customer_id: acme, account_id: A['Business Checking'], lines: [{ item_id: item, qty: 1, rate: 1000 }] });
  T({ type: 'sales_receipt', date: '2026-03-10', customer_id: acme, account_id: A['Business Checking'], lines: [{ item_id: item, qty: 1, rate: 1500 }] });
  T({ type: 'sales_receipt', date: '2026-05-10', customer_id: beta, account_id: A['Business Checking'], lines: [{ item_id: item, qty: 1, rate: 500 }] });
  T({ type: 'expense', date: '2025-03-15', vendor_id: vend, account_id: A['Business Checking'], lines: [{ account_id: A['Rent & Lease'], amount: 400 }] });
  T({ type: 'expense', date: '2026-03-15', vendor_id: vend, account_id: A['Business Checking'], lines: [{ account_id: A['Rent & Lease'], amount: 600 }] });
});

describe('periods', () => {
  test('relative periods resolve against a reference date and fiscal year', () => {
    const c = company();
    assert.deepEqual(resolvePeriod(c, 'last_month', '2026-03-15'), { from: '2026-02-01', to: '2026-02-28' });
    assert.deepEqual(resolvePeriod(c, 'last_month', '2026-01-05'), { from: '2025-12-01', to: '2025-12-31' });
    assert.deepEqual(resolvePeriod(c, 'last_quarter', '2026-05-01'), { from: '2026-01-01', to: '2026-03-31' });
    assert.deepEqual(resolvePeriod(c, 'ytd', '2026-05-01'), { from: '2026-01-01', to: '2026-05-01' });
    assert.deepEqual(resolvePeriod({ ...c, fiscal_year_start_month: 7 }, 'last_year', '2026-05-01'), { from: '2024-07-01', to: '2025-06-30' });
  });
  test('comparison ranges', () => {
    assert.deepEqual(comparisonRange('2026-01-01', '2026-03-31', 'prior_period'), { from: '2025-10-01', to: '2025-12-31', label: 'PP' });
    assert.deepEqual(comparisonRange('2024-02-01', '2024-02-29', 'prior_year'), { from: '2023-02-01', to: '2023-02-28', label: 'PY' });
    assert.deepEqual(comparisonRange('2026-03-10', '2026-03-19', 'prior_period'), { from: '2026-02-28', to: '2026-03-09', label: 'PP' });
  });
});

describe('profit and loss customization', () => {
  test('prior-year comparison with $ and % change', () => {
    const r = runReport(db, company(), 'profit_and_loss', { from: '2026-01-01', to: '2026-12-31', compare: 'prior_year' });
    assert.equal(r.columns.length, 5);
    assert.deepEqual(row(r, 'Total Income').cells.slice(1), [200000, 100000, 100000, 100]);
    assert.deepEqual(row(r, 'Net Income').cells.slice(1), [140000, 60000, 80000, 133.3]);
  });
  test('% of income and quarterly columns', () => {
    const r = runReport(db, company(), 'profit_and_loss', { from: '2026-01-01', to: '2026-06-30', columns: 'quarters', pct_income: '1' });
    assert.deepEqual(r.columns.map((c) => c.label), ['', 'Q1 2026', '% of Income (Q1 2026)', 'Q2 2026', '% of Income (Q2 2026)', 'Total', '% of Income (Total)']);
    assert.deepEqual(row(r, 'Rent & Lease').cells.slice(1), [60000, 40, 0, 0, 60000, 30]);
  });
  test('filter by customer and by vendor', () => {
    const r = runReport(db, company(), 'profit_and_loss', { from: '2026-01-01', to: '2026-12-31', customer_id: String(beta) });
    assert.equal(row(r, 'Net Income').cells[1], 50000);
    assert.match(r.subtitle, /Beta/);
    const v = runReport(db, company(), 'profit_and_loss', { from: '2025-01-01', to: '2026-12-31', vendor_id: String(vend) });
    assert.equal(row(v, 'Total Expenses').cells[1], 100000);
  });
  test('relative period overrides dates and is echoed back', () => {
    const r = runReport(db, company(), 'profit_and_loss', { period: 'last_year', from: '2000-01-01', to: '2000-01-31' });
    assert.equal(r.params.period, 'last_year');
    assert.ok(r.params.from > '2000-01-01');
  });
});

describe('balance sheet comparison', () => {
  test('prior-year column still balances', () => {
    const r = runReport(db, company(), 'balance_sheet', { asof: '2026-12-31', compare: 'prior_year' });
    assert.equal(r.check.assets, r.check.liabilitiesAndEquity);
    const assets = row(r, 'TOTAL ASSETS').cells;
    const le = row(r, 'TOTAL LIABILITIES AND EQUITY').cells;
    assert.deepEqual(assets.slice(1, 3), [200000, 60000]);
    assert.deepEqual(le.slice(1, 3), [200000, 60000]);
    assert.equal(assets[3], 140000);
    assert.equal(row(r, 'Retained Earnings').cells[1], 60000); // 2025 profit rolled into RE for the 2026 column
  });
});

describe('general ledger customization', () => {
  test('column picker, split column, multi-account, sort', () => {
    const r = runReport(db, company(), 'general_ledger', { from: '2026-01-01', to: '2026-12-31', account_id: `${A['Business Checking']},${A['Rent & Lease']}`, cols: 'date,name,split,amount,balance' });
    assert.deepEqual(r.columns.map((c) => c.label), ['Date', 'Name', 'Split', 'Amount', 'Balance']);
    const lines = r.rows.filter((x) => x.txn_id);
    assert.equal(lines.length, 4);
    const rentLine = lines.find((x) => x.cells[2] === '1000 Business Checking');
    assert.equal(rentLine.cells[3], 60000);
    assert.equal(r.rows.at(-1).cells[0], 'TOTAL');
    const sorted = runReport(db, company(), 'general_ledger', { from: '2026-01-01', to: '2026-12-31', account_id: String(A['Business Checking']), sort: 'amount' });
    const amounts = sorted.rows.filter((x) => x.txn_id).map((x) => x.cells[6] ?? x.cells[7]);
    assert.deepEqual(amounts, [150000, 60000, 50000]);
  });
  test('customer filter narrows lines', () => {
    const r = runReport(db, company(), 'general_ledger', { from: '2026-01-01', to: '2026-12-31', customer_id: String(acme) });
    assert.ok(r.rows.filter((x) => x.txn_id).every((x) => x.cells[3] === 'Acme'));
  });
});

describe('saved reports', () => {
  test('saves cleaned params; relative period drops fixed dates', () => {
    const s = saveReport(db, co.id, { name: 'Monthly P&L', report: 'profit_and_loss', params: { period: 'last_month', from: '2026-01-01', basis: 'cash', format: 'csv', evil: 'x' } });
    assert.deepEqual(s.params, { period: 'last_month', basis: 'cash' });
    assert.throws(() => saveReport(db, co.id, { name: 'Monthly P&L', report: 'profit_and_loss', params: {} }), /already exists/);
    assert.throws(() => saveReport(db, co.id, { name: 'X', report: 'nope', params: {} }), /Unknown report/);
    assert.equal(listSaved(db, co.id).length, 1);
  });
});

describe('firm branding', () => {
  test('validates logo and color', () => {
    assert.throws(() => saveFirm(db, { accent: 'red' }), /Accent/);
    assert.throws(() => saveFirm(db, { logo: 'javascript:alert(1)' }), /Logo/);
    saveFirm(db, { name: 'Trendwise', logo: 'data:image/png;base64,iVBORw0KGgo=' });
    assert.equal(getFirm(db).name, 'Trendwise');
  });
});

describe('encrypted backup', () => {
  test('round-trips, rejects wrong passphrase and short passphrases', () => {
    assert.throws(() => createBackup(db, 'short'), /at least 12/);
    // VACUUM INTO needs a file-backed database for a faithful snapshot; use one.
    const dir = mkdtempSync(join(tmpdir(), 'ledger-test-'));
    try {
      const fileDb = new Db(join(dir, 'l.db'));
      createCompany(fileDb, { name: 'Backed Up LLC' });
      const bytes = createBackup(fileDb, 'correct horse battery');
      fileDb.close();
      assert.ok(!bytes.includes(Buffer.from('Backed Up LLC')), 'company name must not appear in plaintext');
      assert.throws(() => decryptBackup(bytes, 'wrong passphrase!!'), /Wrong passphrase/);
      const restored = join(dir, 'restored.db');
      writeFileSync(restored, decryptBackup(bytes, 'correct horse battery'));
      const check = new DatabaseSync(restored);
      assert.equal(check.prepare('SELECT name FROM companies').get().name, 'Backed Up LLC');
      check.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
