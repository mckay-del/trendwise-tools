import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../server/db.js';
import { createCompany, updateCompany } from '../server/services/names.js';
import { listAccounts } from '../server/services/accounts.js';
import { createTransaction, updateTransaction } from '../server/services/transactions.js';
import * as bank from '../server/services/banking.js';
import { closeStatus, saveCloseChecks, closePeriod, reopenPeriod, defaultPeriod, closeOverview, MANUAL_CHECKS } from '../server/services/close.js';

test('month-end close: checklist, close, reopen', () => {
  const db = new Db(':memory:');
  let co = createCompany(db, { name: 'Close Co' });
  const A = Object.fromEntries(listAccounts(db, co.id).map((a) => [a.name, a.id]));
  const user = { id: null, name: 'Tester' };
  const company = () => db.get('SELECT * FROM companies WHERE id = ?', co.id);
  updateCompany(db, co.id, { closing_date: '2026-09-30' }); // e.g. a QuickBooks cutover
  assert.equal(defaultPeriod(company(), '2026-11-14'), '2026-10');

  createTransaction(db, co.id, { type: 'journal_entry', date: '2026-10-01', lines: [{ account_id: A['Business Checking'], debit: 1000 }, { account_id: A["Owner's Investment"], credit: 1000 }] });
  const unc = createTransaction(db, co.id, { type: 'expense', date: '2026-10-10', account_id: A['Business Checking'], lines: [{ account_id: A['Uncategorized Expense'], amount: 40 }] });
  bank.importStatement(db, co.id, { account_id: A['Business Checking'], content: 'Date,Description,Amount\n10/20/2026,BANK FEE,-5.00\n' });

  let s = closeStatus(db, company(), '2026-10');
  const st = (k) => s.items.find((i) => i.key === k).status;
  assert.deepEqual([st('reconciled'), st('feed'), st('uncategorized')], ['todo', 'todo', 'todo']);
  assert.equal(s.ready, false);
  assert.equal(s.progress.total, 3 + MANUAL_CHECKS.length);

  // Fix everything
  updateTransaction(db, co.id, unc.id, { date: '2026-10-10', account_id: A['Business Checking'], lines: [{ account_id: A['Office Supplies & Software'], amount: 40 }] });
  const f = bank.listFeed(db, co.id, { account_id: A['Business Checking'] })[0];
  bank.addFromFeed(db, co.id, f.id, { account_id: A['Bank Charges & Fees'] });
  const rec = bank.reconcileState(db, co.id, A['Business Checking'], '2026-10-31');
  bank.finishReconciliation(db, co.id, A['Business Checking'], { statement_date: '2026-10-31', ending_balance: 955, cleared_ids: rec.lines.map((l) => l.id) });
  s = closeStatus(db, company(), '2026-10');
  assert.deepEqual([st('reconciled'), st('feed'), st('uncategorized')], ['ok', 'ok', 'ok']);
  assert.equal(s.ready, false, 'manual sign-offs still open');
  assert.throws(() => closePeriod(db, company(), '2026-10', {}, user), /still open/);

  s = saveCloseChecks(db, company(), '2026-10', { checks: Object.fromEntries(MANUAL_CHECKS.map(([k]) => [k, true])), notes: 'Client confirmed Oct deposits.' }, user);
  assert.equal(s.ready, true);
  assert.equal(s.manual[0].by, 'Tester');
  assert.equal(s.notes, 'Client confirmed Oct deposits.');

  s = closePeriod(db, company(), '2026-10', {}, user);
  assert.equal(s.closed, true);
  assert.equal(company().closing_date, '2026-10-31');
  assert.throws(() => createTransaction(db, co.id, { type: 'expense', date: '2026-10-25', account_id: A['Business Checking'], lines: [{ account_id: A['Meals'], amount: 1 }] }), /closed/);
  assert.equal(closeOverview(db)[0].period, '2026-10'.replace('10', closeOverview(db)[0].period.slice(5)));

  // Reopen restores the cutover date that was there before
  s = reopenPeriod(db, company(), '2026-10', user);
  assert.equal(s.closed, false);
  assert.equal(company().closing_date, '2026-09-30');
  // Closing anyway with open items is allowed when confirmed
  saveCloseChecks(db, company(), '2026-10', { checks: { package_sent: false } }, user);
  assert.throws(() => closePeriod(db, company(), '2026-10', {}, user), /still open/);
  assert.equal(closePeriod(db, company(), '2026-10', { override: true }, user).closed, true);
});
