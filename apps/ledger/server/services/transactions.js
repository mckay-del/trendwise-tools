import { AppError, bad, notFound, toCents, requireDate, isDate, str, intOrNull, addDays, today, fmtMoney } from '../util.js';
import { getAccount, systemAccount, ACCOUNT_TYPES } from './accounts.js';
import { audit } from './audit.js';

/**
 * Transaction types and their behavior.
 *  party:   which name the header carries
 *  lines:   'items' (product/service lines with qty × rate), 'categories' (account + amount),
 *           'deposit' (linked payments + other funds), 'journal' (debits/credits), or null
 *  applies: the document type this one can be applied against
 *  numbered: auto-number when blank
 */
export const TXN_TYPES = {
  invoice:        { label: 'Invoice',        party: 'customer', lines: 'items',      numbered: true, side: 'sales' },
  sales_receipt:  { label: 'Sales Receipt',  party: 'customer', lines: 'items',      numbered: true, side: 'sales' },
  credit_memo:    { label: 'Credit Memo',    party: 'customer', lines: 'items',      numbered: true, side: 'sales', applies: 'invoice' },
  payment:        { label: 'Payment',        party: 'customer', lines: null,         side: 'sales', applies: 'invoice' },
  deposit:        { label: 'Deposit',        party: null,       lines: 'deposit',    side: 'banking' },
  bill:           { label: 'Bill',           party: 'vendor',   lines: 'categories', side: 'expenses' },
  vendor_credit:  { label: 'Vendor Credit',  party: 'vendor',   lines: 'categories', side: 'expenses', applies: 'bill' },
  bill_payment:   { label: 'Bill Payment',   party: 'vendor',   lines: null,         side: 'expenses', applies: 'bill' },
  expense:        { label: 'Expense',        party: 'vendor',   lines: 'categories', side: 'expenses' },
  check:          { label: 'Check',          party: 'vendor',   lines: 'categories', side: 'expenses' },
  transfer:       { label: 'Transfer',       party: null,       lines: null,         side: 'banking' },
  journal_entry:  { label: 'Journal Entry',  party: null,       lines: 'journal',    numbered: true, side: 'accounting' },
};

const PAYMENT_ACCOUNT_TYPES = {
  payment: ['bank', 'other_current_asset'],
  sales_receipt: ['bank', 'other_current_asset'],
  deposit: ['bank', 'other_current_asset'],
  bill_payment: ['bank', 'credit_card'],
  expense: ['bank', 'credit_card', 'other_current_asset'],
  check: ['bank'],
};

// ---------------------------------------------------------------------------
// Reads

const LIST_SQL = `
  SELECT t.*, c.display_name AS customer_name, v.display_name AS vendor_name,
         a.name AS account_name, a.system_key AS account_system_key, ta.name AS to_account_name,
         (SELECT COALESCE(SUM(x.amount),0) FROM applications x WHERE x.target_txn_id = t.id) AS applied_to,
         (SELECT COALESCE(SUM(x.amount),0) FROM applications x WHERE x.source_txn_id = t.id) AS applied_from,
         (SELECT dl.transaction_id FROM transaction_lines dl JOIN transactions d ON d.id = dl.transaction_id
            WHERE dl.linked_txn_id = t.id AND d.status = 'posted' LIMIT 1) AS deposit_id
  FROM transactions t
  LEFT JOIN customers c ON c.id = t.customer_id
  LEFT JOIN vendors v ON v.id = t.vendor_id
  LEFT JOIN accounts a ON a.id = t.account_id
  LEFT JOIN accounts ta ON ta.id = t.to_account_id`;

export function decorate(t, asOf = today()) {
  const def = TXN_TYPES[t.type];
  const out = { ...t, type_label: def?.label ?? t.type, payee: t.customer_name ?? t.vendor_name ?? null };
  if (t.status === 'voided') { out.balance = 0; out.status_label = 'Voided'; return out; }
  if (t.type === 'invoice' || t.type === 'bill') {
    out.balance = t.total - t.applied_to;
    if (out.balance <= 0) out.status_label = 'Paid';
    else if (t.due_date && t.due_date < asOf) out.status_label = 'Overdue';
    else if (t.applied_to > 0) out.status_label = 'Partial';
    else out.status_label = 'Open';
  } else if (def?.applies) {
    out.balance = t.total - t.applied_from; // unapplied credit
    out.status_label = out.balance > 0 ? (t.type === 'payment' || t.type === 'bill_payment' ? 'Unapplied' : 'Open') : 'Closed';
  } else {
    out.balance = 0;
    out.status_label = def?.side === 'accounting' ? 'Posted' : 'Paid';
  }
  if ((t.type === 'payment' || t.type === 'sales_receipt') && t.account_system_key === 'UNDEPOSITED') {
    out.deposit_status = t.deposit_id ? 'Deposited' : 'Undeposited';
  }
  return out;
}

export function listTransactions(db, companyId, q = {}) {
  const where = ['t.company_id = ?'];
  const p = [companyId];
  if (q.type) {
    const types = String(q.type).split(',').filter((x) => TXN_TYPES[x]);
    if (types.length) { where.push(`t.type IN (${types.map(() => '?').join(',')})`); p.push(...types); }
  }
  if (q.side) { const types = Object.keys(TXN_TYPES).filter((k) => TXN_TYPES[k].side === q.side); where.push(`t.type IN (${types.map(() => '?').join(',')})`); p.push(...types); }
  if (q.customer_id) { where.push('t.customer_id = ?'); p.push(Number(q.customer_id)); }
  if (q.vendor_id) { where.push('t.vendor_id = ?'); p.push(Number(q.vendor_id)); }
  if (q.account_id) { where.push('(t.account_id = ? OR t.to_account_id = ? OR EXISTS (SELECT 1 FROM journal_lines j WHERE j.transaction_id = t.id AND j.account_id = ?))'); p.push(...Array(3).fill(Number(q.account_id))); }
  if (q.from && isDate(q.from)) { where.push('t.date >= ?'); p.push(q.from); }
  if (q.to && isDate(q.to)) { where.push('t.date <= ?'); p.push(q.to); }
  if (q.search) { where.push("(t.number LIKE ? OR t.memo LIKE ? OR c.display_name LIKE ? OR v.display_name LIKE ? OR CAST(t.total AS TEXT) = ?)"); const s = `%${q.search}%`; p.push(s, s, s, s, String(toCentsSafe(q.search))); }
  const limit = Math.min(Number(q.limit) || 500, 5000);
  const rows = db.all(`SELECT * FROM (${LIST_SQL} WHERE ${where.join(' AND ')}) ORDER BY date DESC, id DESC LIMIT ${limit}`, ...p);
  let out = rows.map((r) => decorate(r));
  if (q.status === 'open') out = out.filter((r) => r.balance > 0);
  if (q.status === 'overdue') out = out.filter((r) => r.status_label === 'Overdue');
  return out;
}

function toCentsSafe(s) { try { return toCents(s); } catch { return -1; } }

export function getTransaction(db, companyId, id) {
  const t = db.get(`${LIST_SQL} WHERE t.id = ? AND t.company_id = ?`, id, companyId);
  if (!t) throw notFound('Transaction');
  const out = decorate(t);
  out.lines = db.all(`SELECT l.*, i.name AS item_name, a.name AS account_name, c.display_name AS customer_name, v.display_name AS vendor_name,
      lt.type AS linked_type, lt.number AS linked_number, lt.date AS linked_date,
      COALESCE(lc.display_name, lv.display_name) AS linked_payee
    FROM transaction_lines l
    LEFT JOIN items i ON i.id = l.item_id LEFT JOIN accounts a ON a.id = l.account_id
    LEFT JOIN customers c ON c.id = l.customer_id LEFT JOIN vendors v ON v.id = l.vendor_id
    LEFT JOIN transactions lt ON lt.id = l.linked_txn_id
    LEFT JOIN customers lc ON lc.id = lt.customer_id LEFT JOIN vendors lv ON lv.id = lt.vendor_id
    WHERE l.transaction_id = ? ORDER BY l.line_no`, id);
  out.applications = db.all(`SELECT x.*, t.type, t.number, t.date, t.total FROM applications x JOIN transactions t ON t.id = x.target_txn_id WHERE x.source_txn_id = ? ORDER BY t.date`, id);
  out.applied_by = db.all(`SELECT x.*, t.type, t.number, t.date FROM applications x JOIN transactions t ON t.id = x.source_txn_id WHERE x.target_txn_id = ? ORDER BY t.date`, id);
  out.journal = db.all(`SELECT j.*, a.name AS account_name, a.number AS account_number FROM journal_lines j JOIN accounts a ON a.id = j.account_id WHERE j.transaction_id = ? ORDER BY j.id`, id);
  return out;
}

/** Open invoices/bills for a customer/vendor, with balance excluding a given source document. */
export function openDocuments(db, companyId, { type, customer_id, vendor_id, exclude_source_id }) {
  const party = type === 'invoice' ? 'customer_id' : 'vendor_id';
  const partyId = Number(type === 'invoice' ? customer_id : vendor_id);
  const rows = db.all(`SELECT t.*, (SELECT COALESCE(SUM(x.amount),0) FROM applications x WHERE x.target_txn_id = t.id AND x.source_txn_id != ?) AS applied_other,
      (SELECT COALESCE(SUM(x.amount),0) FROM applications x WHERE x.target_txn_id = t.id AND x.source_txn_id = ?) AS applied_this
    FROM transactions t WHERE t.company_id = ? AND t.type = ? AND t.${party} = ? AND t.status = 'posted' ORDER BY t.date, t.id`,
    Number(exclude_source_id) || 0, Number(exclude_source_id) || 0, companyId, type, partyId);
  return rows.map((r) => ({ ...r, open_balance: r.total - r.applied_other })).filter((r) => r.open_balance > 0 || r.applied_this > 0);
}

/** Open credits (credit memos / unapplied payments, vendor credits) for a party. */
export function openCredits(db, companyId, { customer_id, vendor_id }) {
  const isCust = !!customer_id;
  const types = isCust ? ['credit_memo', 'payment'] : ['vendor_credit', 'bill_payment'];
  return db.all(`SELECT t.*, t.total - (SELECT COALESCE(SUM(x.amount),0) FROM applications x WHERE x.source_txn_id = t.id) AS unapplied
    FROM transactions t WHERE t.company_id = ? AND t.type IN (?,?) AND t.${isCust ? 'customer_id' : 'vendor_id'} = ? AND t.status='posted'`,
    companyId, ...types, Number(customer_id || vendor_id)).filter((r) => r.unapplied > 0);
}

/** Payments and sales receipts sitting in Undeposited Funds. */
export function undepositedFunds(db, companyId, excludeDepositId = 0) {
  const uf = systemAccount(db, companyId, 'UNDEPOSITED');
  return db.all(`SELECT t.*, COALESCE(c.display_name, '') AS customer_name FROM transactions t LEFT JOIN customers c ON c.id = t.customer_id
    WHERE t.company_id = ? AND t.account_id = ? AND t.status = 'posted' AND t.type IN ('payment','sales_receipt')
      AND NOT EXISTS (SELECT 1 FROM transaction_lines l JOIN transactions d ON d.id = l.transaction_id
                      WHERE l.linked_txn_id = t.id AND d.status = 'posted' AND d.id != ?)
    ORDER BY t.date, t.id`, companyId, uf.id, excludeDepositId);
}

// ---------------------------------------------------------------------------
// Validation + posting

function party(db, table, companyId, id, label) {
  if (!id) return null;
  const row = db.get(`SELECT * FROM ${table} WHERE id = ? AND company_id = ?`, id, companyId);
  if (!row) throw bad(`${label} not found`);
  return row;
}

function nextNumber(db, companyId, type) {
  const r = db.get(`SELECT MAX(CAST(number AS INTEGER)) AS n FROM transactions WHERE company_id = ? AND type = ? AND number GLOB '[0-9]*'`, companyId, type);
  return String(r.n ? r.n + 1 : (type === 'journal_entry' ? 1 : 1001));
}

function checkClosing(company, date, verb) {
  if (company.closing_date && date <= company.closing_date) {
    throw bad(`The books are closed through ${company.closing_date}. You can't ${verb} a transaction dated ${date}. Change the closing date in Settings first.`);
  }
}

/**
 * Normalize and validate an input document. Returns { header, lines, applications }.
 * Amount fields arrive as dollars (number or string) and leave as integer cents.
 */
function normalize(db, company, body, existing) {
  const companyId = company.id;
  const type = existing?.type ?? body.type;
  const def = TXN_TYPES[type];
  if (!def) throw bad('Unknown transaction type');
  const date = requireDate(body.date ?? today());
  const h = {
    type, date, number: str(body.number, 30), memo: str(body.memo, 2000), due_date: null,
    customer_id: null, vendor_id: null, account_id: null, to_account_id: null, tax_rate_id: null,
    billing_address: str(body.billing_address, 1000), subtotal: 0, tax_amount: 0, total: 0,
  };

  if (def.party === 'customer') {
    const c = party(db, 'customers', companyId, intOrNull(body.customer_id), 'Customer');
    if (!c && type !== 'sales_receipt') throw bad('Choose a customer');
    h.customer_id = c?.id ?? null;
    if (c && !h.billing_address) h.billing_address = c.billing_address;
  }
  if (def.party === 'vendor') {
    const v = party(db, 'vendors', companyId, intOrNull(body.vendor_id), 'Vendor');
    if (!v && ['bill', 'vendor_credit', 'bill_payment'].includes(type)) throw bad('Choose a vendor');
    h.vendor_id = v?.id ?? null;
  }
  if (type === 'invoice' || type === 'bill') {
    const partyRow = h.customer_id ? db.get('SELECT terms_days FROM customers WHERE id=?', h.customer_id) : h.vendor_id ? db.get('SELECT terms_days FROM vendors WHERE id=?', h.vendor_id) : null;
    const terms = partyRow?.terms_days ?? company.default_terms_days;
    h.due_date = body.due_date ? requireDate(body.due_date, 'due_date') : addDays(date, terms);
    if (h.due_date < date) throw bad('Due date cannot be before the transaction date');
  }

  // Header money account
  if (PAYMENT_ACCOUNT_TYPES[type]) {
    let acctId = intOrNull(body.account_id);
    if (!acctId && (type === 'payment' || type === 'sales_receipt')) acctId = systemAccount(db, companyId, 'UNDEPOSITED').id;
    if (!acctId) throw bad(type === 'deposit' ? 'Choose the account to deposit to' : 'Choose a payment account');
    const a = getAccount(db, companyId, acctId);
    if (!PAYMENT_ACCOUNT_TYPES[type].includes(a.type)) throw bad(`${a.name} can't be used as the account on a ${def.label.toLowerCase()}`);
    if (type === 'deposit' && a.system_key === 'UNDEPOSITED') throw bad("You can't deposit into Undeposited Funds");
    h.account_id = a.id;
  }

  let lines = [];
  const lineInputs = Array.isArray(body.lines) ? body.lines : [];

  if (def.lines === 'items') {
    let rate = null;
    if (intOrNull(body.tax_rate_id)) {
      rate = db.get('SELECT * FROM tax_rates WHERE id = ? AND company_id = ?', Number(body.tax_rate_id), companyId);
      if (!rate) throw bad('Sales tax rate not found');
      h.tax_rate_id = rate.id;
    }
    let taxable = 0;
    lineInputs.forEach((l, i) => {
      const item = party(db, 'items', companyId, intOrNull(l.item_id), 'Product/service');
      let accountId = intOrNull(l.account_id) ?? item?.income_account_id ?? null;
      if (!item && !accountId) {
        if (!l.description && !l.amount && !l.rate) return; // blank row
        throw bad(`Line ${i + 1}: choose a product/service`);
      }
      if (!accountId) throw bad(`Line ${i + 1}: ${item.name} has no income account`);
      const acct = getAccount(db, companyId, accountId);
      if (['accounts_receivable', 'accounts_payable'].includes(acct.type)) throw bad(`Line ${i + 1}: A/R and A/P accounts can't be used on sales lines`);
      const qty = l.qty === '' || l.qty == null ? (l.rate != null && l.rate !== '' ? 1 : null) : Number(l.qty);
      if (qty !== null && !Number.isFinite(qty)) throw bad(`Line ${i + 1}: invalid quantity`);
      const rateC = l.rate === '' || l.rate == null ? null : toCents(l.rate);
      const amount = qty !== null && rateC !== null ? Math.round(qty * rateC) : toCents(l.amount);
      const tx = l.taxable === undefined ? !!item?.taxable : !!l.taxable;
      if (tx) taxable += amount;
      lines.push({ item_id: item?.id ?? null, account_id: acct.id, description: str(l.description ?? item?.description, 1000), qty, rate: rateC, amount, taxable: tx ? 1 : 0 });
    });
    if (!lines.length) throw bad('Add at least one line');
    h.subtotal = lines.reduce((s, l) => s + l.amount, 0);
    h.tax_amount = rate ? Math.round(taxable * rate.rate / 100) : 0;
    h.total = h.subtotal + h.tax_amount;
    if (h.total < 0) throw bad('Total cannot be negative');
  }

  if (def.lines === 'categories') {
    lineInputs.forEach((l, i) => {
      const item = party(db, 'items', companyId, intOrNull(l.item_id), 'Product/service');
      const accountId = intOrNull(l.account_id) ?? item?.expense_account_id ?? null;
      const hasQty = l.qty !== undefined && l.qty !== '' && l.qty !== null && l.rate !== undefined && l.rate !== '' && l.rate !== null;
      const amount = hasQty ? Math.round(Number(l.qty) * toCents(l.rate)) : toCents(l.amount);
      if (!accountId) { if (!amount && !l.description) return; throw bad(`Line ${i + 1}: choose a category`); }
      const acct = getAccount(db, companyId, accountId);
      if (['accounts_receivable', 'accounts_payable'].includes(acct.type)) throw bad(`Line ${i + 1}: use a journal entry to post to ${acct.name}`);
      if (acct.id === h.account_id) throw bad(`Line ${i + 1}: the category can't be the same as the payment account`);
      const cust = party(db, 'customers', companyId, intOrNull(l.customer_id), 'Customer');
      lines.push({ item_id: item?.id ?? null, account_id: acct.id, description: str(l.description, 1000), qty: hasQty ? Number(l.qty) : null, rate: hasQty ? toCents(l.rate) : null, amount, customer_id: cust?.id ?? null });
    });
    if (!lines.length) throw bad('Add at least one category line');
    h.subtotal = h.total = lines.reduce((s, l) => s + l.amount, 0);
    if (h.total <= 0) throw bad('Total must be greater than zero');
  }

  if (def.lines === 'deposit') {
    const uf = systemAccount(db, companyId, 'UNDEPOSITED');
    const available = new Map(undepositedFunds(db, companyId, existing?.id ?? 0).map((t) => [t.id, t]));
    const seen = new Set();
    lineInputs.forEach((l, i) => {
      const linked = intOrNull(l.linked_txn_id);
      if (linked) {
        const p = available.get(linked);
        if (!p) throw bad(`Line ${i + 1}: that payment is not in Undeposited Funds (already deposited?)`);
        if (seen.has(linked)) throw bad('The same payment is listed twice');
        if (p.date > date) throw bad(`Line ${i + 1}: ${TXN_TYPES[p.type].label.toLowerCase()} ${p.number ?? ''} is dated ${p.date}, after this deposit (${date}). A deposit can't include money received later.`.replace(/\s+/g, ' '));
        seen.add(linked);
        lines.push({ linked_txn_id: linked, account_id: uf.id, customer_id: p.customer_id, description: str(l.description) ?? `${TXN_TYPES[p.type].label} ${p.number ?? ''}`.trim(), amount: p.total });
        return;
      }
      const amount = toCents(l.amount);
      const accountId = intOrNull(l.account_id);
      if (!accountId) { if (!amount) return; throw bad(`Line ${i + 1}: choose the account the funds came from`); }
      const acct = getAccount(db, companyId, accountId);
      if (acct.id === h.account_id) throw bad(`Line ${i + 1}: can't deposit from the deposit account itself`);
      if (acct.type === 'accounts_payable') throw bad(`Line ${i + 1}: A/P can't be used on a deposit`);
      const cust = party(db, 'customers', companyId, intOrNull(l.customer_id), 'Customer');
      if (acct.type === 'accounts_receivable' && !cust) throw bad(`Line ${i + 1}: choose a customer for A/R`);
      lines.push({ account_id: acct.id, customer_id: cust?.id ?? null, vendor_id: intOrNull(l.vendor_id), description: str(l.description, 1000), amount });
    });
    if (!lines.length) throw bad('Add at least one deposit line');
    h.subtotal = h.total = lines.reduce((s, l) => s + l.amount, 0);
    if (h.total <= 0) throw bad('Deposit total must be greater than zero');
  }

  if (def.lines === 'journal') {
    let dr = 0, cr = 0;
    lineInputs.forEach((l, i) => {
      const d = toCents(l.debit), c = toCents(l.credit);
      const accountId = intOrNull(l.account_id);
      if (!accountId) { if (!d && !c) return; throw bad(`Line ${i + 1}: choose an account`); }
      if (d < 0 || c < 0) throw bad(`Line ${i + 1}: debits and credits must be positive`);
      if (d && c) throw bad(`Line ${i + 1}: enter a debit or a credit, not both`);
      const acct = getAccount(db, companyId, accountId);
      const cust = party(db, 'customers', companyId, intOrNull(l.customer_id), 'Customer');
      const vend = party(db, 'vendors', companyId, intOrNull(l.vendor_id), 'Vendor');
      if (acct.type === 'accounts_receivable' && !cust) throw bad(`Line ${i + 1}: choose a customer for ${acct.name}`);
      if (acct.type === 'accounts_payable' && !vend) throw bad(`Line ${i + 1}: choose a vendor for ${acct.name}`);
      dr += d; cr += c;
      lines.push({ account_id: acct.id, amount: d - c, description: str(l.description, 1000), customer_id: cust?.id ?? null, vendor_id: vend?.id ?? null });
    });
    if (lines.length < 2) throw bad('A journal entry needs at least two lines');
    if (dr !== cr) throw bad(`Debits (${fmtMoney(dr)}) and credits (${fmtMoney(cr)}) must be equal`);
    if (dr === 0) throw bad('Journal entry total cannot be zero');
    h.subtotal = h.total = dr;
  }

  if (type === 'transfer') {
    const from = getAccount(db, companyId, intOrNull(body.account_id) ?? 0);
    const to = getAccount(db, companyId, intOrNull(body.to_account_id) ?? 0);
    for (const a of [from, to]) {
      const cls = ACCOUNT_TYPES[a.type].cls;
      if (cls === 'income' || cls === 'expense' || a.type === 'accounts_receivable' || a.type === 'accounts_payable') throw bad(`${a.name} can't be used in a transfer`);
    }
    if (from.id === to.id) throw bad('Transfer from and to accounts must be different');
    h.account_id = from.id; h.to_account_id = to.id;
    h.subtotal = h.total = toCents(body.total ?? body.amount);
    if (h.total <= 0) throw bad('Transfer amount must be greater than zero');
  }

  if (type === 'payment' || type === 'bill_payment') {
    h.subtotal = h.total = toCents(body.total ?? body.amount);
    if (h.total <= 0) throw bad('Payment amount must be greater than zero');
  }

  // Applications (payment → invoices, credit memo → invoices, bill payment → bills, vendor credit → bills)
  const applications = [];
  if (def.applies) {
    const open = new Map(openDocuments(db, companyId, { type: def.applies, customer_id: h.customer_id, vendor_id: h.vendor_id, exclude_source_id: existing?.id }).map((d) => [d.id, d]));
    for (const a of Array.isArray(body.applications) ? body.applications : []) {
      const amount = toCents(a.amount);
      if (!amount) continue;
      if (amount < 0) throw bad('Applied amounts must be positive');
      const target = open.get(intOrNull(a.target_txn_id));
      if (!target) throw bad(`That ${TXN_TYPES[def.applies].label.toLowerCase()} is not open for this ${def.party}`);
      if (amount > target.open_balance) throw bad(`${TXN_TYPES[def.applies].label} ${target.number ?? ''} only has ${fmtMoney(target.open_balance)} open`);
      applications.push({ target_txn_id: target.id, amount });
    }
    const applied = applications.reduce((s, a) => s + a.amount, 0);
    if (applied > h.total) throw bad(`Applied amount (${fmtMoney(applied)}) exceeds the ${def.label.toLowerCase()} total (${fmtMoney(h.total)})`);
  }

  if (!h.number && def.numbered) h.number = existing?.number ?? nextNumber(db, companyId, type);
  if (h.number && (type === 'invoice' || type === 'sales_receipt' || type === 'credit_memo')) {
    const dup = db.get('SELECT id FROM transactions WHERE company_id = ? AND type = ? AND number = ? AND id != ?', companyId, type, h.number, existing?.id ?? 0);
    if (dup) throw bad(`${def.label} number ${h.number} is already in use`);
  }
  return { header: h, lines, applications };
}

/** Generate double-entry journal lines for a normalized document. */
export function buildJournal(db, companyId, h, lines) {
  const out = [];
  const post = (account_id, amount, extra = {}) => {
    if (!amount) return;
    out.push({ account_id, debit: amount > 0 ? amount : 0, credit: amount < 0 ? -amount : 0, customer_id: extra.customer_id ?? null, vendor_id: extra.vendor_id ?? null, memo: extra.memo ?? null });
  };
  const ar = () => systemAccount(db, companyId, 'AR').id;
  const ap = () => systemAccount(db, companyId, 'AP').id;
  const tax = () => systemAccount(db, companyId, 'SALES_TAX').id;
  const cust = { customer_id: h.customer_id };
  const vend = { vendor_id: h.vendor_id };

  switch (h.type) {
    case 'invoice':
    case 'sales_receipt': {
      post(h.type === 'invoice' ? ar() : h.account_id, h.total, cust);
      for (const l of lines) post(l.account_id, -l.amount, { ...cust, memo: l.description });
      post(tax(), -h.tax_amount, cust);
      break;
    }
    case 'credit_memo': {
      post(ar(), -h.total, cust);
      for (const l of lines) post(l.account_id, l.amount, { ...cust, memo: l.description });
      post(tax(), h.tax_amount, cust);
      break;
    }
    case 'payment':
      post(h.account_id, h.total, cust);
      post(ar(), -h.total, cust);
      break;
    case 'deposit':
      post(h.account_id, h.total);
      for (const l of lines) post(l.account_id, -l.amount, { customer_id: l.customer_id, vendor_id: l.vendor_id, memo: l.description });
      break;
    case 'bill':
      for (const l of lines) post(l.account_id, l.amount, { vendor_id: h.vendor_id, customer_id: l.customer_id, memo: l.description });
      post(ap(), -h.total, vend);
      break;
    case 'vendor_credit':
      post(ap(), h.total, vend);
      for (const l of lines) post(l.account_id, -l.amount, { vendor_id: h.vendor_id, customer_id: l.customer_id, memo: l.description });
      break;
    case 'bill_payment':
      post(ap(), h.total, vend);
      post(h.account_id, -h.total, vend);
      break;
    case 'expense':
    case 'check':
      for (const l of lines) post(l.account_id, l.amount, { vendor_id: h.vendor_id, customer_id: l.customer_id, memo: l.description });
      post(h.account_id, -h.total, vend);
      break;
    case 'transfer':
      post(h.to_account_id, h.total, { memo: h.memo });
      post(h.account_id, -h.total, { memo: h.memo });
      break;
    case 'journal_entry':
      for (const l of lines) post(l.account_id, l.amount, { customer_id: l.customer_id, vendor_id: l.vendor_id, memo: l.description });
      break;
    default:
      throw new Error(`No posting rule for ${h.type}`);
  }
  const dr = out.reduce((s, j) => s + j.debit, 0);
  const cr = out.reduce((s, j) => s + j.credit, 0);
  if (dr !== cr) throw new Error(`Unbalanced posting for ${h.type}: ${dr} != ${cr}`);
  return out;
}

function writeChildren(db, company, txnId, h, lines, applications, previousJournal = []) {
  db.run('DELETE FROM transaction_lines WHERE transaction_id = ?', txnId);
  db.run('DELETE FROM applications WHERE source_txn_id = ?', txnId);
  db.run('DELETE FROM journal_lines WHERE transaction_id = ?', txnId);
  lines.forEach((l, i) => db.run(`INSERT INTO transaction_lines (transaction_id, line_no, item_id, account_id, description, qty, rate, amount, taxable, customer_id, vendor_id, linked_txn_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, txnId, i + 1, l.item_id, l.account_id, l.description, l.qty, l.rate, l.amount, l.taxable ?? 0, l.customer_id, l.vendor_id, l.linked_txn_id));
  for (const a of applications) db.run('INSERT INTO applications (source_txn_id, target_txn_id, amount) VALUES (?,?,?)', txnId, a.target_txn_id, a.amount);
  // Keep "cleared" status on unchanged money-account lines so edits don't undo bank matching.
  const cleared = previousJournal.filter((j) => j.cleared === 'C');
  for (const j of buildJournal(db, company.id, h, lines)) {
    const idx = cleared.findIndex((c) => c.account_id === j.account_id && c.debit === j.debit && c.credit === j.credit);
    const flag = idx >= 0 ? cleared.splice(idx, 1)[0].cleared : '';
    db.run(`INSERT INTO journal_lines (company_id, transaction_id, date, account_id, debit, credit, customer_id, vendor_id, memo, cleared) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      company.id, txnId, h.date, j.account_id, j.debit, j.credit, j.customer_id, j.vendor_id, j.memo, flag);
  }
}

function getCompany(db, companyId) {
  const c = db.get('SELECT * FROM companies WHERE id = ?', companyId);
  if (!c) throw notFound('Company');
  return c;
}

function assertNotReconciled(db, txnId, verb) {
  if (db.get("SELECT 1 FROM journal_lines WHERE transaction_id = ? AND cleared = 'R' LIMIT 1", txnId)) {
    throw bad(`This transaction has been reconciled. Undo the reconciliation before you ${verb} it.`);
  }
}

function assertNotLocked(db, txn, verb) {
  const applied = db.get(`SELECT t.type, t.number FROM applications x JOIN transactions t ON t.id = x.source_txn_id WHERE x.target_txn_id = ? LIMIT 1`, txn.id);
  if (applied) throw bad(`${TXN_TYPES[applied.type].label} ${applied.number ?? ''} is applied to this ${TXN_TYPES[txn.type].label.toLowerCase()}. Remove it before you ${verb} this transaction.`.replace('  ', ' '));
  const dep = db.get(`SELECT d.id FROM transaction_lines l JOIN transactions d ON d.id = l.transaction_id WHERE l.linked_txn_id = ? AND d.status = 'posted' LIMIT 1`, txn.id);
  if (dep) throw bad(`This ${TXN_TYPES[txn.type].label.toLowerCase()} has been deposited. Remove it from the deposit before you ${verb} it.`);
}

export function createTransaction(db, companyId, body, userId = null) {
  return db.tx(() => {
    const company = getCompany(db, companyId);
    const { header: h, lines, applications } = normalize(db, company, body);
    checkClosing(company, h.date, 'add');
    const id = db.insert(`INSERT INTO transactions (company_id, type, number, date, due_date, customer_id, vendor_id, account_id, to_account_id, tax_rate_id, subtotal, tax_amount, total, memo, billing_address, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, companyId, h.type, h.number, h.date, h.due_date, h.customer_id, h.vendor_id, h.account_id, h.to_account_id, h.tax_rate_id, h.subtotal, h.tax_amount, h.total, h.memo, h.billing_address, userId);
    writeChildren(db, company, id, h, lines, applications);
    audit(db, { companyId, userId, action: 'create', entity: h.type, entityId: id, summary: `${TXN_TYPES[h.type].label} ${h.number ?? ''} ${fmtMoney(h.total)}`.replace(/\s+/g, ' ') });
    return getTransaction(db, companyId, id);
  });
}

export function updateTransaction(db, companyId, id, body, userId = null) {
  return db.tx(() => {
    const company = getCompany(db, companyId);
    const existing = db.get('SELECT * FROM transactions WHERE id = ? AND company_id = ?', id, companyId);
    if (!existing) throw notFound('Transaction');
    if (existing.status === 'voided') throw bad('Voided transactions cannot be edited');
    // Optimistic concurrency: refuse to overwrite a change someone else saved after this form was opened.
    if (body.expected_updated_at && body.expected_updated_at !== existing.updated_at) {
      const who = db.get(`SELECT u.name, l.at FROM audit_log l LEFT JOIN users u ON u.id = l.user_id WHERE l.company_id = ? AND l.entity_id = ? AND l.entity = ? ORDER BY l.id DESC LIMIT 1`, companyId, id, existing.type);
      throw new AppError(409, `${who?.name ?? 'Someone else'} changed this ${TXN_TYPES[existing.type].label.toLowerCase()} after you opened it${who?.at ? ` (at ${who.at} UTC)` : ''}. Reload the page to see their changes, then make yours again.`);
    }
    checkClosing(company, existing.date, 'edit');
    assertNotReconciled(db, id, 'edit');
    const { header: h, lines, applications } = normalize(db, company, { ...body, type: existing.type }, existing);
    checkClosing(company, h.date, 'edit');
    if (existing.type === 'invoice' || existing.type === 'bill') {
      const applied = db.get('SELECT COALESCE(SUM(amount),0) AS s FROM applications WHERE target_txn_id = ?', id).s;
      if (h.total < applied) throw bad(`The total can't be less than the ${fmtMoney(applied)} already applied to it`);
      const otherParty = db.get(`SELECT 1 FROM applications x JOIN transactions s ON s.id = x.source_txn_id WHERE x.target_txn_id = ? AND (s.customer_id IS NOT ? OR s.vendor_id IS NOT ?) LIMIT 1`, id, h.customer_id, h.vendor_id);
      if (otherParty) throw bad("Can't change the customer/vendor while payments are applied");
    }
    if (existing.type === 'payment' || existing.type === 'sales_receipt') {
      const dep = db.get(`SELECT d.date FROM transaction_lines l JOIN transactions d ON d.id = l.transaction_id WHERE l.linked_txn_id = ? AND d.status='posted' LIMIT 1`, id);
      if (dep && (h.total !== existing.total || h.account_id !== existing.account_id)) throw bad('This payment has been deposited. Remove it from the deposit before changing the amount or account.');
      if (dep && h.date > dep.date) throw bad(`This payment was deposited on ${dep.date}, so it can't be dated later than that.`);
    }
    const prevJournal = db.all('SELECT * FROM journal_lines WHERE transaction_id = ?', id);
    db.run(`UPDATE transactions SET number=?, date=?, due_date=?, customer_id=?, vendor_id=?, account_id=?, to_account_id=?, tax_rate_id=?, subtotal=?, tax_amount=?, total=?, memo=?, billing_address=?, updated_at=strftime('%Y-%m-%d %H:%M:%f','now') WHERE id=?`,
      h.number, h.date, h.due_date, h.customer_id, h.vendor_id, h.account_id, h.to_account_id, h.tax_rate_id, h.subtotal, h.tax_amount, h.total, h.memo, h.billing_address, id);
    writeChildren(db, company, id, h, lines, applications, prevJournal);
    audit(db, { companyId, userId, action: 'update', entity: h.type, entityId: id, summary: `${TXN_TYPES[h.type].label} ${h.number ?? ''} ${fmtMoney(existing.total)} → ${fmtMoney(h.total)}`.replace(/\s+/g, ' ') });
    return getTransaction(db, companyId, id);
  });
}

export function voidTransaction(db, companyId, id, userId = null) {
  return db.tx(() => {
    const company = getCompany(db, companyId);
    const t = db.get('SELECT * FROM transactions WHERE id = ? AND company_id = ?', id, companyId);
    if (!t) throw notFound('Transaction');
    if (t.status === 'voided') throw bad('Already voided');
    checkClosing(company, t.date, 'void');
    assertNotReconciled(db, id, 'void');
    assertNotLocked(db, t, 'void');
    db.run('DELETE FROM applications WHERE source_txn_id = ?', id);
    db.run('DELETE FROM journal_lines WHERE transaction_id = ?', id);
    db.run(`UPDATE transactions SET status='voided', memo = TRIM(COALESCE(memo,'') || ' [Voided ' || date('now') || ' — was ' || ? || ']'), subtotal=0, tax_amount=0, total=0, updated_at=strftime('%Y-%m-%d %H:%M:%f','now') WHERE id = ?`, fmtMoney(t.total), id);
    db.run("UPDATE transaction_lines SET amount = 0 WHERE transaction_id = ?", id);
    db.run("UPDATE bank_feed SET status='review', txn_id=NULL WHERE txn_id = ?", id);
    audit(db, { companyId, userId, action: 'void', entity: t.type, entityId: id, summary: `${TXN_TYPES[t.type].label} ${t.number ?? ''} ${fmtMoney(t.total)}`.replace(/\s+/g, ' ') });
    return getTransaction(db, companyId, id);
  });
}

export function deleteTransaction(db, companyId, id, userId = null) {
  return db.tx(() => {
    const company = getCompany(db, companyId);
    const t = db.get('SELECT * FROM transactions WHERE id = ? AND company_id = ?', id, companyId);
    if (!t) throw notFound('Transaction');
    checkClosing(company, t.date, 'delete');
    assertNotReconciled(db, id, 'delete');
    assertNotLocked(db, t, 'delete');
    db.run("UPDATE bank_feed SET status='review', txn_id=NULL WHERE txn_id = ?", id);
    db.run('DELETE FROM transactions WHERE id = ?', id);
    audit(db, { companyId, userId, action: 'delete', entity: t.type, entityId: id, summary: `${TXN_TYPES[t.type].label} ${t.number ?? ''} ${fmtMoney(t.total)}`.replace(/\s+/g, ' ') });
    return { ok: true };
  });
}
