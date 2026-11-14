import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../server/db.js';
import { createCompany, saveParty, saveItem } from '../server/services/names.js';
import { listAccounts } from '../server/services/accounts.js';
import { createTransaction, undepositedFunds } from '../server/services/transactions.js';
import * as bank from '../server/services/banking.js';

let db, co, A, cust;
const bal = (n) => listAccounts(db, co.id).find((a) => a.name === n).balance;
const feedRow = (desc) => bank.listFeed(db, co.id, { account_id: A['Business Checking'] }).find((f) => f.description === desc);
const paid = (amount, date) => {
  const inv = createTransaction(db, co.id, { type: 'invoice', date, customer_id: cust.id, lines: [{ item_id: item().id, qty: 1, rate: amount }] });
  return createTransaction(db, co.id, { type: 'payment', date, customer_id: cust.id, total: amount, number: `ch_${date}_${amount}`, applications: [{ target_txn_id: inv.id, amount }] });
};
let _item;
const item = () => (_item ??= saveItem(db, co.id, { name: 'Retainer', income_account_id: A['Services Revenue'] }));

beforeEach(() => {
  db = new Db(':memory:'); _item = null;
  co = createCompany(db, { name: 'Deposits Co' });
  A = Object.fromEntries(listAccounts(db, co.id).map((a) => [a.name, a.id]));
  cust = saveParty(db, co.id, 'customers', { display_name: 'Champion RMA LLC' });
});

test('a wire matches the waiting payment and creates its deposit in one step', () => {
  const p = paid(1000, '2026-08-04');
  bank.importStatement(db, co.id, { account_id: A['Business Checking'], content: 'Date,Description,Amount\n08/05/2026,INCOMING WIRE CHAMPION RMA,1000.00\n' });
  const f = feedRow('INCOMING WIRE CHAMPION RMA');
  assert.equal(f.matches[0].transaction_id, p.id);
  assert.equal(f.matches[0].undeposited, true);
  assert.match(f.matches[0].type_label, /undeposited/);
  const r = bank.matchFeed(db, co.id, f.id, { transaction_id: p.id });
  assert.ok(r.deposit_id);
  assert.equal(bal('Undeposited Funds'), 0);
  assert.equal(bal('Business Checking'), 100000);
  assert.equal(db.get("SELECT cleared FROM journal_lines WHERE transaction_id = ? AND account_id = ?", r.deposit_id, A['Business Checking']).cleared, 'C');
  // Undo puts the payment back in Undeposited Funds
  bank.undoFeed(db, co.id, f.id);
  assert.equal(bal('Undeposited Funds'), 100000);
  assert.equal(undepositedFunds(db, co.id).length, 1);
});

test('a Stripe payout: several payments less the fee', () => {
  const p1 = paid(1000, '2026-09-01'), p2 = paid(500, '2026-09-02');
  paid(250, '2026-09-20'); // not in this payout
  bank.importStatement(db, co.id, { account_id: A['Business Checking'], content: 'Date,Description,Amount\n09/04/2026,STRIPE TRANSFER,1455.20\n' });
  const f = feedRow('STRIPE TRANSFER');
  assert.equal(f.matches.length, 0, 'no single payment equals the payout');
  const cands = bank.depositCandidates(db, co.id, f.id);
  assert.equal(cands.length, 3);
  assert.deepEqual(cands.slice(0, 2).map((c) => c.id).sort(), [p1.id, p2.id].sort(), 'closest dates first');
  assert.throws(() => bank.addFromFeed(db, co.id, f.id, { payment_ids: [p1.id], fee_account_id: A['Bank Charges & Fees'] }), /more than the \$1,000\.00 of payments/);
  const r = bank.addFromFeed(db, co.id, f.id, { payment_ids: [p1.id, p2.id], fee_account_id: A['Bank Charges & Fees'] });
  assert.equal(r.fee, 4480);
  assert.equal(r.transaction.type, 'deposit');
  assert.equal(bal('Business Checking'), 145520);
  assert.equal(bal('Bank Charges & Fees'), 4480);
  assert.equal(bal('Undeposited Funds'), 25000, 'only the later payment is still waiting');
  assert.equal(bal('Services Revenue'), 175000, 'revenue counted once, gross');
});
