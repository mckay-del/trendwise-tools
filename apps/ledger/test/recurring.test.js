import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../server/db.js';
import { createCompany, saveParty, saveItem, updateCompany } from '../server/services/names.js';
import { listAccounts } from '../server/services/accounts.js';
import { createTransaction } from '../server/services/transactions.js';
import { advance, templateFromTransaction, templateView, saveRecurring, runDue, createNow, skipNext, dueReminders, getRecurring } from '../server/services/recurring.js';

let db, co, A, cust, vend, item;
const count = (type) => db.get('SELECT COUNT(*) AS n FROM transactions WHERE type = ?', type).n;

beforeEach(() => {
  db = new Db(':memory:');
  co = createCompany(db, { name: 'R Co' });
  A = Object.fromEntries(listAccounts(db, co.id).map((a) => [a.name, a.id]));
  cust = saveParty(db, co.id, 'customers', { display_name: 'Retainer Client', terms_days: 15 });
  vend = saveParty(db, co.id, 'vendors', { display_name: 'Landlord' });
  item = saveItem(db, co.id, { name: 'Monthly retainer', sales_price: 1500, income_account_id: A['Services Revenue'] });
});

describe('schedule math', () => {
  test('month-end dates and frequencies', () => {
    assert.equal(advance('2026-01-31', 'monthly', 1, 31), '2026-02-28');
    assert.equal(advance('2026-02-28', 'monthly', 1, 31), '2026-03-31');
    assert.equal(advance('2026-01-15', 'monthly', 2, 15), '2026-03-15');
    assert.equal(advance('2026-11-30', 'quarterly', 1, 30), '2027-02-28');
    assert.equal(advance('2028-02-29', 'yearly', 1, 29), '2029-02-28');
    assert.equal(advance('2026-12-28', 'weekly', 2), '2027-01-11');
  });
});

describe('templates', () => {
  test('build from an existing transaction and render for the form', () => {
    const inv = createTransaction(db, co.id, { type: 'invoice', date: '2026-01-01', customer_id: cust.id, lines: [{ item_id: item.id, qty: 1, rate: 1500 }] });
    const t = templateFromTransaction(db, co.id, inv.id);
    assert.equal(t.type, 'invoice');
    assert.deepEqual(t.template.lines, [{ item_id: item.id, description: null ?? undefined, qty: 1, rate: 1500, amount: 1500, taxable: false }].map((l) => Object.fromEntries(Object.entries(l).filter(([, v]) => v !== undefined))));
    const v = templateView(t.template);
    assert.equal(v.lines[0].rate, 150000);
    const je = createTransaction(db, co.id, { type: 'journal_entry', date: '2026-01-31', lines: [{ account_id: A['Depreciation Expense'], debit: 200 }, { account_id: A['Accumulated Depreciation'], credit: 200 }] });
    assert.deepEqual(templateView(templateFromTransaction(db, co.id, je.id).template).lines.map((l) => l.amount), [20000, -20000]);
  });

  test('an invalid template is rejected with the normal validation message', () => {
    assert.throws(() => saveRecurring(db, co.id, { type: 'journal_entry', name: 'Bad JE', frequency: 'monthly', next_date: '2026-02-01',
      template: { lines: [{ account_id: A['Business Checking'], debit: 10 }, { account_id: A['Rent & Lease'], credit: 9 }] } }), /must be equal/);
  });
});

describe('running schedules', () => {
  const rent = (extra = {}) => saveRecurring(db, co.id, { type: 'check', name: 'Office rent', frequency: 'monthly', day_of_month: 1, next_date: '2026-01-01',
    template: { vendor_id: vend.id, account_id: A['Business Checking'], memo: 'Rent', lines: [{ account_id: A['Rent & Lease'], amount: 1850 }] }, ...extra });

  test('catches up on missed periods and stops at the end date', () => {
    const r = rent({ end_date: '2026-03-15' });
    assert.equal(r.amount, 185000);
    const res = runDue(db, { today: '2026-06-10' });
    assert.deepEqual(res, { created: 3, errors: 0 });
    assert.equal(count('check'), 3);
    assert.deepEqual(db.all("SELECT date FROM transactions WHERE type='check' ORDER BY date").map((x) => x.date), ['2026-01-01', '2026-02-01', '2026-03-01']);
    const after = getRecurring(db, co.id, r.id);
    assert.equal(after.is_active, 0, 'finished after the end date');
    assert.equal(after.history.length, 3);
    assert.deepEqual(runDue(db, { today: '2026-12-31' }), { created: 0, errors: 0 });
  });

  test('invoices get due dates from terms and new numbers', () => {
    saveRecurring(db, co.id, { type: 'invoice', name: 'Retainer', frequency: 'monthly', next_date: '2026-01-05',
      template: { customer_id: cust.id, lines: [{ item_id: item.id, qty: 1, rate: 1500 }] } });
    runDue(db, { today: '2026-02-20' });
    const invs = db.all("SELECT number, date, due_date, total FROM transactions WHERE type='invoice' ORDER BY date").map((x) => ({ ...x }));
    assert.deepEqual(invs, [{ number: '1001', date: '2026-01-05', due_date: '2026-01-20', total: 150000 }, { number: '1002', date: '2026-02-05', due_date: '2026-02-20', total: 150000 }]);
  });

  test('reminder mode waits for a person; create and skip move the schedule', () => {
    const r = rent({ mode: 'reminder' });
    assert.deepEqual(runDue(db, { today: '2026-01-10' }), { created: 0, errors: 0 });
    assert.equal(dueReminders(db, co.id, '2026-01-10').length, 1);
    createNow(db, co.id, r.id);
    assert.equal(count('check'), 1);
    skipNext(db, co.id, r.id);
    const after = getRecurring(db, co.id, r.id);
    assert.equal(after.next_date, '2026-03-01');
    assert.deepEqual(after.history.map((h) => h.status), ['skipped', 'created']);
  });

  test('a blocked occurrence is reported, not skipped', () => {
    const r = rent();
    updateCompany(db, co.id, { closing_date: '2026-01-31' });
    const res = runDue(db, { today: '2026-02-05' });
    assert.deepEqual(res, { created: 0, errors: 1 });
    const after = getRecurring(db, co.id, r.id);
    assert.equal(after.next_date, '2026-01-01', 'stays due until fixed');
    assert.match(after.last_error, /closed/);
    assert.equal(dueReminders(db, co.id, '2026-02-05').length, 1);
  });
});
