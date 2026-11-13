import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../server/db.js';
import { createCompany, saveParty, saveItem, saveTaxRate, updateCompany } from '../server/services/names.js';
import { createTransaction, updateTransaction, voidTransaction, deleteTransaction, getTransaction, openDocuments, undepositedFunds } from '../server/services/transactions.js';
import { listAccounts, systemAccount } from '../server/services/accounts.js';
import { runReport } from '../server/services/reports.js';
import * as bank from '../server/services/banking.js';
import { toCents } from '../server/util.js';

let db, co, acct, cust, vend, item;
const A = (name) => acct.find((a) => a.name === name).id;
const bal = (name) => listAccounts(db, co.id).find((a) => a.name === name).balance;
const row = (rep, label) => rep.rows.find((r) => r.cells[0] === label || r.cells[0]?.endsWith?.(' ' + label));
const company = () => db.get('SELECT * FROM companies WHERE id = ?', co.id);

beforeEach(() => {
  db = new Db(':memory:');
  co = createCompany(db, { name: 'Test Co' });
  acct = listAccounts(db, co.id);
  cust = saveParty(db, co.id, 'customers', { display_name: 'Acme', terms_days: 30 });
  vend = saveParty(db, co.id, 'vendors', { display_name: 'Contractor LLC', is_1099: true, tax_id: '12-3456789' });
  item = saveItem(db, co.id, { name: 'Consulting', sales_price: 150, income_account_id: A('Services Revenue') });
});

describe('money parsing', () => {
  test('toCents handles formats', () => {
    assert.equal(toCents('$1,234.56'), 123456);
    assert.equal(toCents('(45.10)'), -4510);
    assert.equal(toCents('-0.5'), -50);
    assert.equal(toCents(19.99), 1999);
    assert.equal(toCents(''), 0);
    assert.throws(() => toCents('abc'));
  });
});

describe('sales cycle', () => {
  test('invoice → payment → deposit posts correctly', () => {
    const inv = createTransaction(db, co.id, { type: 'invoice', date: '2026-01-10', customer_id: cust.id, lines: [{ item_id: item.id, qty: 4, rate: 150 }] });
    assert.equal(inv.total, 60000);
    assert.equal(inv.number, '1001');
    assert.equal(inv.due_date, '2026-02-09');
    assert.equal(bal('Accounts Receivable'), 60000);
    assert.equal(bal('Services Revenue'), 60000);

    const pay = createTransaction(db, co.id, { type: 'payment', date: '2026-01-20', customer_id: cust.id, total: 600, applications: [{ target_txn_id: inv.id, amount: 600 }] });
    assert.equal(pay.account_system_key, 'UNDEPOSITED');
    assert.equal(bal('Accounts Receivable'), 0);
    assert.equal(bal('Undeposited Funds'), 60000);
    assert.equal(getTransaction(db, co.id, inv.id).status_label, 'Paid');
    assert.equal(undepositedFunds(db, co.id).length, 1);

    createTransaction(db, co.id, { type: 'deposit', date: '2026-01-21', account_id: A('Business Checking'), lines: [{ linked_txn_id: pay.id }] });
    assert.equal(bal('Undeposited Funds'), 0);
    assert.equal(bal('Business Checking'), 60000);
    assert.equal(undepositedFunds(db, co.id).length, 0);
    assert.throws(() => deleteTransaction(db, co.id, pay.id), /deposited/);
    assert.throws(() => deleteTransaction(db, co.id, inv.id), /applied/);
  });

  test('sales tax on taxable lines only', () => {
    const rate = saveTaxRate(db, co.id, { name: 'Clark County', rate: 8.375 });
    const inv = createTransaction(db, co.id, { type: 'invoice', date: '2026-02-01', customer_id: cust.id, tax_rate_id: rate.id, lines: [
      { item_id: item.id, qty: 1, rate: 100, taxable: true }, { item_id: item.id, qty: 1, rate: 50, taxable: false },
    ] });
    assert.equal(inv.subtotal, 15000);
    assert.equal(inv.tax_amount, 838); // 8.375% of $100 = 8.375 → 8.38
    assert.equal(bal('Sales Tax Payable'), 838);
    const rep = runReport(db, company(), 'sales_tax', { from: '2026-01-01', to: '2026-12-31' });
    assert.equal(rep.rows.at(-1).cells[4], 838);
  });

  test('partial payment, overpayment rejected, credit memo applied', () => {
    const inv = createTransaction(db, co.id, { type: 'invoice', date: '2026-03-01', customer_id: cust.id, lines: [{ item_id: item.id, qty: 10, rate: 100 }] });
    createTransaction(db, co.id, { type: 'payment', date: '2026-03-05', customer_id: cust.id, total: 300, account_id: A('Business Checking'), applications: [{ target_txn_id: inv.id, amount: 300 }] });
    assert.equal(getTransaction(db, co.id, inv.id).balance, 70000);
    assert.throws(() => createTransaction(db, co.id, { type: 'payment', date: '2026-03-06', customer_id: cust.id, total: 800, applications: [{ target_txn_id: inv.id, amount: 800 }] }), /only has/);
    createTransaction(db, co.id, { type: 'credit_memo', date: '2026-03-07', customer_id: cust.id, lines: [{ item_id: item.id, qty: 1, rate: 200 }], applications: [{ target_txn_id: inv.id, amount: 200 }] });
    assert.equal(getTransaction(db, co.id, inv.id).balance, 50000);
    assert.equal(bal('Accounts Receivable'), 50000);
    assert.equal(bal('Services Revenue'), 80000);
  });

  test('editing a payment re-validates applications', () => {
    const inv = createTransaction(db, co.id, { type: 'invoice', date: '2026-03-01', customer_id: cust.id, lines: [{ item_id: item.id, qty: 1, rate: 500 }] });
    const pay = createTransaction(db, co.id, { type: 'payment', date: '2026-03-05', customer_id: cust.id, total: 500, applications: [{ target_txn_id: inv.id, amount: 500 }] });
    // Re-saving the same payment must not count its own application against the invoice.
    const again = updateTransaction(db, co.id, pay.id, { date: '2026-03-05', customer_id: cust.id, total: 500, applications: [{ target_txn_id: inv.id, amount: 500 }] });
    assert.equal(again.applications[0].amount, 50000);
    assert.throws(() => updateTransaction(db, co.id, inv.id, { date: '2026-03-01', customer_id: cust.id, lines: [{ item_id: item.id, qty: 1, rate: 100 }] }), /already applied/);
  });
});

describe('expenses', () => {
  test('bill → bill payment, expense, check', () => {
    const bill = createTransaction(db, co.id, { type: 'bill', date: '2026-01-05', vendor_id: vend.id, lines: [{ account_id: A('Contract Labor'), amount: 1000 }] });
    assert.equal(bal('Accounts Payable'), 100000);
    createTransaction(db, co.id, { type: 'bill_payment', date: '2026-01-25', vendor_id: vend.id, account_id: A('Business Checking'), total: 1000, applications: [{ target_txn_id: bill.id, amount: 1000 }] });
    assert.equal(bal('Accounts Payable'), 0);
    assert.equal(bal('Business Checking'), -100000);
    createTransaction(db, co.id, { type: 'expense', date: '2026-01-26', account_id: A('Business Credit Card'), lines: [{ account_id: A('Meals'), amount: 45.5 }] });
    assert.equal(bal('Business Credit Card'), 4550);
    assert.throws(() => createTransaction(db, co.id, { type: 'check', date: '2026-01-26', account_id: A('Business Credit Card'), lines: [{ account_id: A('Meals'), amount: 1 }] }), /can't be used/);
  });

  test('1099 summary excludes card payments and applies the $2,000 threshold for 2026', () => {
    createTransaction(db, co.id, { type: 'check', date: '2026-04-01', vendor_id: vend.id, account_id: A('Business Checking'), lines: [{ account_id: A('Contract Labor'), amount: 1500 }] });
    createTransaction(db, co.id, { type: 'expense', date: '2026-04-02', vendor_id: vend.id, account_id: A('Business Credit Card'), lines: [{ account_id: A('Contract Labor'), amount: 900 }] });
    let rep = runReport(db, company(), 'vendor_1099', { year: '2026' });
    assert.deepEqual(rep.rows[0].cells, ['Contractor LLC', '12-3456789', 90000, 150000, 'No']);
    createTransaction(db, co.id, { type: 'check', date: '2026-05-01', vendor_id: vend.id, account_id: A('Business Checking'), lines: [{ account_id: A('Contract Labor'), amount: 600 }] });
    rep = runReport(db, company(), 'vendor_1099', { year: '2026' });
    assert.equal(rep.rows[0].cells[4], 'Yes');
  });
});

describe('journal entries & controls', () => {
  test('unbalanced JE rejected; A/R line requires customer', () => {
    assert.throws(() => createTransaction(db, co.id, { type: 'journal_entry', date: '2026-01-01', lines: [{ account_id: A('Business Checking'), debit: 100 }, { account_id: A("Owner's Investment"), credit: 90 }] }), /must be equal/);
    assert.throws(() => createTransaction(db, co.id, { type: 'journal_entry', date: '2026-01-01', lines: [{ account_id: A('Accounts Receivable'), debit: 100 }, { account_id: A('Services Revenue'), credit: 100 }] }), /customer/);
  });

  test('closing date blocks changes on or before it', () => {
    const je = createTransaction(db, co.id, { type: 'journal_entry', date: '2026-01-15', lines: [{ account_id: A('Business Checking'), debit: 100 }, { account_id: A("Owner's Investment"), credit: 100 }] });
    updateCompany(db, co.id, { closing_date: '2026-01-31' });
    assert.throws(() => createTransaction(db, co.id, { type: 'journal_entry', date: '2026-01-20', lines: [{ account_id: A('Business Checking'), debit: 1 }, { account_id: A("Owner's Investment"), credit: 1 }] }), /closed/);
    assert.throws(() => deleteTransaction(db, co.id, je.id), /closed/);
    assert.throws(() => updateTransaction(db, co.id, je.id, { date: '2026-02-15', lines: [{ account_id: A('Business Checking'), debit: 100 }, { account_id: A("Owner's Investment"), credit: 100 }] }), /closed/);
  });

  test('void removes postings but keeps the record', () => {
    const exp = createTransaction(db, co.id, { type: 'expense', date: '2026-02-01', account_id: A('Business Checking'), lines: [{ account_id: A('Rent & Lease'), amount: 2000 }] });
    voidTransaction(db, co.id, exp.id);
    const t = getTransaction(db, co.id, exp.id);
    assert.equal(t.status, 'voided');
    assert.equal(t.journal.length, 0);
    assert.equal(bal('Rent & Lease'), 0);
  });
});

describe('reports', () => {
  function seed() {
    createTransaction(db, co.id, { type: 'journal_entry', date: '2025-12-31', lines: [{ account_id: A('Business Checking'), debit: 10000 }, { account_id: A("Owner's Investment"), credit: 10000 }] });
    createTransaction(db, co.id, { type: 'sales_receipt', date: '2025-06-01', customer_id: cust.id, account_id: A('Business Checking'), lines: [{ item_id: item.id, qty: 1, rate: 3000 }] });
    const inv = createTransaction(db, co.id, { type: 'invoice', date: '2026-01-10', customer_id: cust.id, lines: [{ item_id: item.id, qty: 10, rate: 100 }] });
    createTransaction(db, co.id, { type: 'payment', date: '2026-02-10', customer_id: cust.id, account_id: A('Business Checking'), total: 400, applications: [{ target_txn_id: inv.id, amount: 400 }] });
    createTransaction(db, co.id, { type: 'bill', date: '2026-01-15', vendor_id: vend.id, due_date: '2026-01-30', lines: [{ account_id: A('Contract Labor'), amount: 250 }] });
    createTransaction(db, co.id, { type: 'expense', date: '2026-01-20', account_id: A('Business Credit Card'), lines: [{ account_id: A('Office Supplies & Software'), amount: 75 }] });
    return inv;
  }

  test('balance sheet balances and rolls prior-year income into retained earnings', () => {
    seed();
    const bs = runReport(db, company(), 'balance_sheet', { asof: '2026-03-31' });
    assert.equal(bs.check.assets, bs.check.liabilitiesAndEquity);
    assert.equal(row(bs, 'Retained Earnings').cells[1], 300000);
    assert.equal(row(bs, 'Net Income').cells[1], 100000 - 25000 - 7500);
    assert.equal(row(bs, 'TOTAL ASSETS').cells[1], 1000000 + 300000 + 40000 + 60000);
  });

  test('P&L accrual vs cash basis', () => {
    seed();
    const acc = runReport(db, company(), 'profit_and_loss', { from: '2026-01-01', to: '2026-03-31' });
    assert.equal(row(acc, 'Total Income').cells[1], 100000);
    assert.equal(row(acc, 'Net Income').cells[1], 67500);
    const cash = runReport(db, company(), 'profit_and_loss', { from: '2026-01-01', to: '2026-03-31', basis: 'cash' });
    assert.equal(row(cash, 'Total Income').cells[1], 40000); // only the paid share
    assert.equal(row(cash, 'Total Expenses').cells[1], 7500); // unpaid bill excluded
    const monthly = runReport(db, company(), 'profit_and_loss', { from: '2026-01-01', to: '2026-03-31', columns: 'months' });
    assert.equal(monthly.columns.length, 5);
  });

  test('trial balance debits equal credits', () => {
    seed();
    const tb = runReport(db, company(), 'trial_balance', { asof: '2026-03-31' });
    const total = tb.rows.at(-1).cells;
    assert.equal(total[1], total[2]);
  });

  test('aging buckets', () => {
    seed();
    const ar = runReport(db, company(), 'ar_aging', { asof: '2026-03-31' });
    // invoice due 2026-02-09, 50 days past due as of 3/31 → 31-60 bucket
    assert.deepEqual(ar.rows[0].cells, ['Acme', 0, 0, 60000, 0, 0, 60000]);
    const ap = runReport(db, company(), 'ap_aging_detail', { asof: '2026-03-31' });
    assert.equal(ap.rows.at(-1).cells[6], 25000);
  });

  test('cash flow ties to bank change', () => {
    seed();
    const cf = runReport(db, company(), 'cash_flow', { from: '2026-01-01', to: '2026-03-31' });
    assert.equal(row(cf, 'NET CASH INCREASE FOR PERIOD').cells[1], 40000);
    assert.equal(row(cf, 'CASH AT END OF PERIOD').cells[1], 1340000);
  });

  test('general ledger running balance', () => {
    seed();
    const gl = runReport(db, company(), 'general_ledger', { from: '2026-01-01', to: '2026-03-31', account_id: String(A('Business Checking')) });
    assert.equal(gl.rows[1].cells[7], 1300000);
    assert.equal(gl.rows.at(-1).cells[7], 1340000);
  });
});

describe('banking', () => {
  const csv = `Date,Description,Amount\n01/03/2026,"AMAZON MKTPLACE, SEATTLE",-42.17\n01/04/2026,STRIPE TRANSFER,1250.00\n01/05/2026,CHECK 1042,-300.00\n`;

  test('import dedupes, rules suggest + auto-add, add/match/undo', () => {
    const checking = A('Business Checking');
    bank.saveRule(db, co.id, { match_text: 'amazon', direction: 'out', account_id: A('Office Supplies & Software'), auto_add: false });
    const r1 = bank.importStatement(db, co.id, { account_id: checking, content: csv });
    assert.equal(r1.imported, 3);
    const r2 = bank.importStatement(db, co.id, { account_id: checking, content: csv });
    assert.equal(r2.imported, 0);
    assert.equal(r2.duplicates, 3);

    let feed = bank.listFeed(db, co.id, { account_id: checking });
    const amazon = feed.find((f) => f.description.startsWith('AMAZON'));
    assert.equal(amazon.suggested_account_id, A('Office Supplies & Software'));
    const added = bank.addFromFeed(db, co.id, amazon.id, {});
    assert.equal(added.transaction.type, 'expense');
    assert.equal(bal('Office Supplies & Software'), 4217);

    // A check entered by hand should be offered as a match.
    const chk = createTransaction(db, co.id, { type: 'check', number: '1042', date: '2026-01-02', account_id: checking, vendor_id: vend.id, lines: [{ account_id: A('Contract Labor'), amount: 300 }] });
    feed = bank.listFeed(db, co.id, { account_id: checking });
    const chkFeed = feed.find((f) => f.description === 'CHECK 1042');
    assert.equal(chkFeed.matches[0].transaction_id, chk.id);
    bank.matchFeed(db, co.id, chkFeed.id, { transaction_id: chk.id });
    assert.equal(db.get("SELECT cleared FROM journal_lines WHERE transaction_id = ? AND account_id = ?", chk.id, checking).cleared, 'C');

    // Stripe deposit categorized to income
    const stripe = feed.find((f) => f.description === 'STRIPE TRANSFER');
    const dep = bank.addFromFeed(db, co.id, stripe.id, { account_id: A('Services Revenue'), customer_id: cust.id });
    assert.equal(dep.transaction.type, 'deposit');

    bank.undoFeed(db, co.id, amazon.id);
    assert.equal(bal('Office Supplies & Software'), 0);
    assert.equal(bank.listFeed(db, co.id, { account_id: checking }).length, 1);
  });

  test('transfer between accounts from feed and credit card refund', () => {
    const cc = A('Business Credit Card');
    bank.importStatement(db, co.id, { account_id: cc, content: 'Date,Description,Amount\n2026-01-10,PAYMENT THANK YOU,500\n2026-01-11,REFUND OFFICE DEPOT,20\n' });
    const feed = bank.listFeed(db, co.id, { account_id: cc });
    const pmt = bank.addFromFeed(db, co.id, feed.find((f) => f.description.startsWith('PAYMENT')).id, { account_id: A('Business Checking') });
    assert.equal(pmt.transaction.type, 'transfer');
    assert.equal(bal('Business Checking'), -50000);
    assert.equal(bal('Business Credit Card'), -50000);
    const ref = bank.addFromFeed(db, co.id, feed.find((f) => f.description.startsWith('REFUND')).id, { account_id: A('Office Supplies & Software') });
    assert.equal(ref.transaction.type, 'journal_entry');
    assert.equal(bal('Business Credit Card'), -52000);
  });

  test('debit/credit column CSV and OFX parsing', () => {
    const rows = bank.parseStatementCsv('Posting Date,Description,Debit,Credit\n1/2/26,Fee,5.00,\n1/3/26,Deposit,,100.00\n');
    assert.deepEqual(rows.map((r) => r.amount), [-500, 10000]);
    const ofx = bank.parseOfx('<OFX><STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260105120000<TRNAMT>-12.34<FITID>abc<NAME>COFFEE</STMTTRN></OFX>');
    assert.deepEqual(ofx[0], { date: '2026-01-05', amount: -1234, description: 'COFFEE', fitid: 'abc' });
  });

  test('reconciliation requires zero difference, locks transactions, can be undone', () => {
    const checking = A('Business Checking');
    const dep = createTransaction(db, co.id, { type: 'journal_entry', date: '2026-01-01', lines: [{ account_id: checking, debit: 1000 }, { account_id: A("Owner's Investment"), credit: 1000 }] });
    const exp = createTransaction(db, co.id, { type: 'expense', date: '2026-01-15', account_id: checking, lines: [{ account_id: A('Bank Charges & Fees'), amount: 25 }] });
    createTransaction(db, co.id, { type: 'expense', date: '2026-02-15', account_id: checking, lines: [{ account_id: A('Bank Charges & Fees'), amount: 25 }] });
    const st = bank.reconcileState(db, co.id, checking, '2026-01-31');
    assert.equal(st.beginning_balance, 0);
    assert.equal(st.lines.length, 2);
    const ids = st.lines.map((l) => l.id);
    assert.throws(() => bank.finishReconciliation(db, co.id, checking, { statement_date: '2026-01-31', ending_balance: 980, cleared_ids: ids }), /Difference/);
    bank.finishReconciliation(db, co.id, checking, { statement_date: '2026-01-31', ending_balance: 975, cleared_ids: ids });
    assert.throws(() => deleteTransaction(db, co.id, exp.id), /reconciled/);
    assert.equal(bank.reconcileState(db, co.id, checking, '2026-02-28').beginning_balance, 97500);
    bank.undoLastReconciliation(db, co.id, checking);
    deleteTransaction(db, co.id, exp.id);
    void dep;
  });
});

test('every posted transaction keeps the ledger balanced', () => {
  createTransaction(db, co.id, { type: 'invoice', date: '2026-01-10', customer_id: cust.id, lines: [{ item_id: item.id, qty: 3, rate: 33.33 }] });
  createTransaction(db, co.id, { type: 'transfer', date: '2026-01-11', account_id: A('Business Checking'), to_account_id: A('Business Savings'), total: 10 });
  const r = db.get('SELECT SUM(debit) AS d, SUM(credit) AS c FROM journal_lines WHERE company_id = ?', co.id);
  assert.equal(r.d, r.c);
  assert.ok(systemAccount(db, co.id, 'AR'));
  assert.equal(openDocuments(db, co.id, { type: 'invoice', customer_id: cust.id }).length, 1);
});
