import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../server/db.js';
import { createCompany } from '../server/services/names.js';
import { listAccounts } from '../server/services/accounts.js';
import * as bank from '../server/services/banking.js';

let db, co, A;
const bal = (n) => listAccounts(db, co.id).find((a) => a.name === n).balance;
const feedRow = (acct, desc) => bank.listFeed(db, co.id, { account_id: A[acct] }).find((f) => f.description === desc);

beforeEach(() => {
  db = new Db(':memory:');
  co = createCompany(db, { name: 'Split Co' });
  A = Object.fromEntries(listAccounts(db, co.id).map((a) => [a.name, a.id]));
  bank.importStatement(db, co.id, { account_id: A['Business Checking'], content: 'Date,Description,Amount\n03/05/2026,TRUCK LOAN PMT,-612.40\n03/06/2026,MOBILE DEPOSIT,2500.00\n' });
  bank.importStatement(db, co.id, { account_id: A['Business Credit Card'], content: 'Date,Description,Amount\n03/07/2026,RETURN COSTCO,80.00\n' });
});

test('loan payment split into principal and interest', () => {
  const f = feedRow('Business Checking', 'TRUCK LOAN PMT');
  const r = bank.addFromFeed(db, co.id, f.id, { splits: [{ account_id: A['Notes Payable'], amount: '540.15' }, { account_id: A['Interest Paid'], amount: '72.25' }] });
  assert.equal(r.transaction.type, 'expense');
  assert.equal(r.transaction.lines.length, 2);
  assert.equal(bal('Business Checking'), -61240);
  assert.equal(bal('Notes Payable'), -54015); // liability reduced
  assert.equal(bal('Interest Paid'), 7225);
  assert.equal(db.get("SELECT cleared FROM journal_lines WHERE transaction_id = ? AND account_id = ?", r.transaction.id, A['Business Checking']).cleared, 'C');
});

test('deposit split between income and an owner contribution', () => {
  const f = feedRow('Business Checking', 'MOBILE DEPOSIT');
  const r = bank.addFromFeed(db, co.id, f.id, { splits: [{ account_id: A['Services Revenue'], amount: 2000 }, { account_id: A["Owner's Investment"], amount: 500 }] });
  assert.equal(r.transaction.type, 'deposit');
  assert.equal(bal('Services Revenue'), 200000);
  assert.equal(bal("Owner's Investment"), 50000);
});

test('credit card return split across two categories', () => {
  const f = feedRow('Business Credit Card', 'RETURN COSTCO');
  const r = bank.addFromFeed(db, co.id, f.id, { splits: [{ account_id: A['Office Supplies & Software'], amount: 50 }, { account_id: A['Meals'], amount: 30 }] });
  assert.equal(r.transaction.type, 'journal_entry');
  assert.equal(bal('Business Credit Card'), -8000);
  assert.equal(bal('Meals'), -3000);
});

test('split lines must add up to the bank amount', () => {
  const f = feedRow('Business Checking', 'TRUCK LOAN PMT');
  assert.throws(() => bank.addFromFeed(db, co.id, f.id, { splits: [{ account_id: A['Notes Payable'], amount: 500 }, { account_id: A['Interest Paid'], amount: 72.25 }] }), /add up to \$572\.25.*\$612\.40.*Difference: \$40\.15/);
  assert.throws(() => bank.addFromFeed(db, co.id, f.id, { splits: [{ account_id: A['Accounts Payable'], amount: 612.4 }] }), /Pay bills/);
  assert.equal(feedRow('Business Checking', 'TRUCK LOAN PMT').status, 'review', 'nothing recorded after an error');
});
