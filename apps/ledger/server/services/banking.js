import { createHash, randomUUID } from 'node:crypto';
import { bad, notFound, toCents, requireDate, str, intOrNull, fmtMoney, daysBetween } from '../util.js';
import { getAccount, signed, ACCOUNT_TYPES } from './accounts.js';
import { createTransaction, deleteTransaction, TXN_TYPES } from './transactions.js';
import { audit } from './audit.js';

const FEED_ACCOUNT_TYPES = ['bank', 'credit_card'];

// ---------------------------------------------------------------------------
// Parsing

export function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"' && s[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

export function parseDate(v) {
  const s = String(v ?? '').trim();
  let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return iso(+m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/))) {
    let y = +m[3]; if (y < 100) y += y < 70 ? 2000 : 1900;
    return iso(y, +m[1], +m[2]);
  }
  if ((m = s.match(/^(\d{4})(\d{2})(\d{2})/))) return iso(+m[1], +m[2], +m[3]); // OFX 20260131120000
  return null;
}
function iso(y, mo, d) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1) return null;
  return dt.toISOString().slice(0, 10);
}

const HEAD = {
  date: ['date', 'posting date', 'posted date', 'transaction date', 'trans. date', 'trans date'],
  description: ['description', 'payee', 'name', 'details', 'memo', 'transaction description'],
  amount: ['amount', 'transaction amount'],
  debit: ['debit', 'withdrawal', 'withdrawals', 'money out', 'debit amount', 'charges'],
  credit: ['credit', 'deposit', 'deposits', 'money in', 'credit amount', 'payments'],
};

/** Turn bank CSV text into [{date, description, amount}] (amount positive = money in). */
export function parseStatementCsv(text, opts = {}) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw bad('The file has no transactions');
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const find = (k) => (opts[`${k}_col`] !== undefined && opts[`${k}_col`] !== null && opts[`${k}_col`] !== '' ? Number(opts[`${k}_col`]) : header.findIndex((h) => HEAD[k].includes(h)));
  const col = { date: find('date'), description: find('description'), amount: find('amount'), debit: find('debit'), credit: find('credit') };
  if (col.date < 0) throw bad('Could not find a Date column. Columns found: ' + rows[0].join(', '));
  if (col.description < 0) throw bad('Could not find a Description column. Columns found: ' + rows[0].join(', '));
  if (col.amount < 0 && col.debit < 0 && col.credit < 0) throw bad('Could not find an Amount (or Debit/Credit) column. Columns found: ' + rows[0].join(', '));
  const out = [];
  rows.slice(1).forEach((r, i) => {
    const date = parseDate(r[col.date]);
    if (!date) throw bad(`Row ${i + 2}: unrecognized date "${r[col.date]}"`);
    let amount;
    if (col.amount >= 0) amount = toCents(r[col.amount]);
    else amount = toCents(r[col.credit] || 0) - Math.abs(toCents(r[col.debit] || 0));
    if (opts.invert) amount = -amount;
    if (!amount) return;
    out.push({ date, description: str(r[col.description], 300) ?? '(no description)', amount });
  });
  return out;
}

/** Minimal OFX/QFX statement parser. */
export function parseOfx(text) {
  const out = [];
  for (const block of text.split(/<STMTTRN>/i).slice(1)) {
    const tag = (t) => { const m = block.match(new RegExp(`<${t}>([^<\\r\\n]*)`, 'i')); return m ? m[1].trim() : null; };
    const date = parseDate(tag('DTPOSTED'));
    const amount = toCents(tag('TRNAMT'));
    if (!date || !amount) continue;
    out.push({ date, amount, description: [tag('NAME'), tag('MEMO')].filter(Boolean).join(' ').slice(0, 300) || '(no description)', fitid: tag('FITID') });
  }
  if (!out.length) throw bad('No transactions found in the OFX/QFX file');
  return out;
}

// ---------------------------------------------------------------------------
// Feed

function feedAccount(db, companyId, id) {
  const a = getAccount(db, companyId, id);
  if (!FEED_ACCOUNT_TYPES.includes(a.type)) throw bad('Bank feeds are only available for bank and credit card accounts');
  return a;
}

export function importStatement(db, companyId, { account_id, content, format, ...opts }, userId) {
  const acct = feedAccount(db, companyId, intOrNull(account_id));
  if (!content || typeof content !== 'string') throw bad('No file content');
  const isOfx = format === 'ofx' || /<OFX>|<STMTTRN>/i.test(content);
  const parsed = isOfx ? parseOfx(content) : parseStatementCsv(content, opts);
  const batch = randomUUID();
  const seen = new Map();
  let imported = 0, duplicates = 0;
  db.tx(() => {
    for (const t of parsed) {
      const base = t.fitid ? `fitid:${t.fitid}` : `${t.date}|${t.amount}|${t.description.toLowerCase().replace(/\s+/g, ' ')}`;
      const n = (seen.get(base) ?? 0) + 1; seen.set(base, n);
      const fp = createHash('sha256').update(t.fitid ? base : `${base}|${n}`).digest('hex').slice(0, 32);
      const r = db.run(`INSERT OR IGNORE INTO bank_feed (company_id, account_id, date, description, amount, fingerprint, import_batch) VALUES (?,?,?,?,?,?,?)`,
        companyId, acct.id, t.date, t.description, t.amount, fp, batch);
      if (r.changes) imported++; else duplicates++;
    }
    audit(db, { companyId, userId, action: 'import', entity: 'bank_feed', entityId: acct.id, summary: `${imported} transactions imported into ${acct.name} (${duplicates} duplicates skipped)` });
  });
  const auto = applyRules(db, companyId, { account_id: acct.id }, userId);
  return { imported, duplicates, auto_added: auto.added, batch };
}

export function listFeed(db, companyId, { account_id, status = 'review' }) {
  const acct = feedAccount(db, companyId, intOrNull(account_id));
  const rows = db.all(`SELECT f.*, a.name AS suggested_account_name, v.display_name AS suggested_vendor_name, c.display_name AS suggested_customer_name,
      t.type AS txn_type, t.number AS txn_number, r.name AS rule_name
    FROM bank_feed f LEFT JOIN accounts a ON a.id = f.suggested_account_id LEFT JOIN vendors v ON v.id = f.suggested_vendor_id
    LEFT JOIN customers c ON c.id = f.suggested_customer_id LEFT JOIN transactions t ON t.id = f.txn_id LEFT JOIN bank_rules r ON r.id = f.rule_id
    WHERE f.account_id = ? AND f.status ${status === 'done' ? "IN ('added','matched')" : '= ?'} ORDER BY f.date DESC, f.id DESC`,
    ...(status === 'done' ? [acct.id] : [acct.id, status]));
  if (status === 'review') for (const r of rows) r.matches = findMatches(db, companyId, acct, r);
  return rows.map((r) => ({ ...r, txn_type_label: r.txn_type ? TXN_TYPES[r.txn_type]?.label : null }));
}

/** Existing, uncleared transactions in the feed account with the same amount and a nearby date. */
export function findMatches(db, companyId, acct, feed) {
  const candidates = db.all(`SELECT j.id AS journal_id, j.transaction_id, j.date, t.type, t.number, COALESCE(c.display_name, v.display_name) AS payee, t.memo
    FROM journal_lines j JOIN transactions t ON t.id = j.transaction_id LEFT JOIN customers c ON c.id = t.customer_id LEFT JOIN vendors v ON v.id = t.vendor_id
    WHERE j.account_id = ? AND j.cleared = '' AND (j.debit - j.credit) = ? AND j.date BETWEEN date(?, '-14 days') AND date(?, '+14 days')
      AND NOT EXISTS (SELECT 1 FROM bank_feed f WHERE f.txn_id = j.transaction_id AND f.status = 'matched')
    ORDER BY ABS(julianday(j.date) - julianday(?)) LIMIT 5`, acct.id, feed.amount, feed.date, feed.date, feed.date);
  return candidates.map((c) => ({ ...c, type_label: TXN_TYPES[c.type]?.label, days_apart: Math.abs(daysBetween(c.date, feed.date)) }));
}

function getFeedRow(db, companyId, id) {
  const f = db.get('SELECT * FROM bank_feed WHERE id = ? AND company_id = ?', id, companyId);
  if (!f) throw notFound('Bank transaction');
  return f;
}

function markCleared(db, txnId, accountId, amount) {
  const line = db.get(`SELECT id FROM journal_lines WHERE transaction_id = ? AND account_id = ? AND (debit - credit) = ? AND cleared = '' LIMIT 1`, txnId, accountId, amount);
  if (line) db.run("UPDATE journal_lines SET cleared = 'C' WHERE id = ?", line.id);
  return !!line;
}

/** Create a new transaction from a feed row ("Add" in the For Review tab). */
export function addFromFeed(db, companyId, id, body, userId) {
  return db.tx(() => {
    const f = getFeedRow(db, companyId, id);
    if (f.status !== 'review') throw bad('This transaction has already been handled');
    const acct = getAccount(db, companyId, f.account_id);
    const categoryId = intOrNull(body.account_id) ?? f.suggested_account_id;
    if (!categoryId) throw bad('Choose a category');
    const cat = getAccount(db, companyId, categoryId);
    const vendorId = intOrNull(body.vendor_id) ?? (body.vendor_id === undefined ? f.suggested_vendor_id : null);
    const customerId = intOrNull(body.customer_id) ?? (body.customer_id === undefined ? f.suggested_customer_id : null);
    const memo = str(body.memo) ?? f.description;
    const amt = Math.abs(f.amount) / 100;
    const cls = ACCOUNT_TYPES[cat.type].cls;
    const balanceSheetMoney = !['income', 'expense'].includes(cls) && !['accounts_receivable', 'accounts_payable'].includes(cat.type);
    let doc;
    if (balanceSheetMoney && ['bank', 'credit_card', 'other_current_asset', 'other_current_liability', 'long_term_liability', 'equity', 'fixed_asset', 'other_asset'].includes(cat.type)) {
      doc = f.amount < 0
        ? { type: 'transfer', date: f.date, account_id: acct.id, to_account_id: cat.id, total: amt, memo }
        : { type: 'transfer', date: f.date, account_id: cat.id, to_account_id: acct.id, total: amt, memo };
    } else if (f.amount < 0) {
      doc = { type: 'expense', date: f.date, account_id: acct.id, vendor_id: vendorId, memo, lines: [{ account_id: cat.id, amount: amt, description: memo, customer_id: customerId }] };
    } else if (acct.type === 'bank') {
      doc = { type: 'deposit', date: f.date, account_id: acct.id, memo, lines: [{ account_id: cat.id, amount: amt, description: memo, customer_id: customerId, vendor_id: vendorId }] };
    } else {
      // Credit-card credit (refund): debit the card, credit the category.
      doc = { type: 'journal_entry', date: f.date, memo: `Credit card credit: ${memo}`, lines: [
        { account_id: acct.id, debit: amt, description: memo, vendor_id: vendorId },
        { account_id: cat.id, credit: amt, description: memo, vendor_id: vendorId, customer_id: customerId },
      ] };
    }
    const txn = createTransaction(db, companyId, doc, userId);
    markCleared(db, txn.id, acct.id, f.amount);
    db.run("UPDATE bank_feed SET status='added', txn_id=? WHERE id=?", txn.id, f.id);
    return { feed_id: f.id, transaction: txn };
  });
}

export function matchFeed(db, companyId, id, { transaction_id }, userId) {
  return db.tx(() => {
    const f = getFeedRow(db, companyId, id);
    if (f.status !== 'review') throw bad('This transaction has already been handled');
    const txnId = intOrNull(transaction_id);
    const t = db.get('SELECT * FROM transactions WHERE id = ? AND company_id = ?', txnId, companyId);
    if (!t) throw notFound('Transaction');
    if (!markCleared(db, t.id, f.account_id, f.amount)) throw bad(`That transaction doesn't have an uncleared ${fmtMoney(Math.abs(f.amount))} line in this account`);
    db.run("UPDATE bank_feed SET status='matched', txn_id=? WHERE id=?", t.id, f.id);
    audit(db, { companyId, userId, action: 'match', entity: 'bank_feed', entityId: f.id, summary: `${f.description} ${fmtMoney(f.amount)} matched to ${TXN_TYPES[t.type].label} ${t.number ?? ''}` });
    return { ok: true };
  });
}

export function excludeFeed(db, companyId, id, userId) {
  const f = getFeedRow(db, companyId, id);
  if (f.status !== 'review') throw bad('Only transactions awaiting review can be excluded');
  db.run("UPDATE bank_feed SET status='excluded' WHERE id=?", f.id);
  audit(db, { companyId, userId, action: 'exclude', entity: 'bank_feed', entityId: f.id, summary: `${f.description} ${fmtMoney(f.amount)}` });
  return { ok: true };
}

/** Undo add/match/exclude. "Added" transactions are deleted; matched ones are un-cleared. */
export function undoFeed(db, companyId, id, userId) {
  return db.tx(() => {
    const f = getFeedRow(db, companyId, id);
    if (f.status === 'added' && f.txn_id) deleteTransaction(db, companyId, f.txn_id, userId);
    if (f.status === 'matched' && f.txn_id) {
      const line = db.get("SELECT id, cleared FROM journal_lines WHERE transaction_id = ? AND account_id = ? AND (debit - credit) = ? AND cleared != '' LIMIT 1", f.txn_id, f.account_id, f.amount);
      if (line?.cleared === 'R') throw bad('That transaction has been reconciled; undo the reconciliation first');
      if (line) db.run("UPDATE journal_lines SET cleared='' WHERE id=?", line.id);
    }
    db.run("UPDATE bank_feed SET status='review', txn_id=NULL WHERE id=?", f.id);
    return { ok: true };
  });
}

export function updateFeedSuggestion(db, companyId, id, body) {
  const f = getFeedRow(db, companyId, id);
  db.run('UPDATE bank_feed SET suggested_account_id=?, suggested_vendor_id=?, suggested_customer_id=? WHERE id=?',
    intOrNull(body.account_id) ?? f.suggested_account_id, body.vendor_id === undefined ? f.suggested_vendor_id : intOrNull(body.vendor_id),
    body.customer_id === undefined ? f.suggested_customer_id : intOrNull(body.customer_id), f.id);
  return getFeedRow(db, companyId, id);
}

// ---------------------------------------------------------------------------
// Rules

export function listRules(db, companyId) {
  return db.all(`SELECT r.*, a.name AS account_name, b.name AS bank_account_name, v.display_name AS vendor_name, c.display_name AS customer_name
    FROM bank_rules r JOIN accounts a ON a.id = r.account_id LEFT JOIN accounts b ON b.id = r.bank_account_id
    LEFT JOIN vendors v ON v.id = r.vendor_id LEFT JOIN customers c ON c.id = r.customer_id
    WHERE r.company_id = ? ORDER BY r.priority, r.id`, companyId);
}

export function saveRule(db, companyId, body, id = null, userId = null) {
  const existing = id ? db.get('SELECT * FROM bank_rules WHERE id = ? AND company_id = ?', id, companyId) : null;
  if (id && !existing) throw notFound('Rule');
  const m = { ...existing, ...body };
  const name = str(m.name, 100) ?? str(m.match_text, 100);
  const match = str(m.match_text, 200);
  if (!match) throw bad('Enter the text to match in the bank description');
  if (!['in', 'out', 'any'].includes(m.direction ?? 'out')) throw bad('Invalid direction');
  const acct = getAccount(db, companyId, intOrNull(m.account_id) ?? 0);
  const bankId = intOrNull(m.bank_account_id);
  if (bankId) feedAccount(db, companyId, bankId);
  const vals = [name, m.direction ?? 'out', match, bankId, acct.id, intOrNull(m.vendor_id), intOrNull(m.customer_id), m.auto_add ? 1 : 0, Number(m.priority) || 100, m.is_active === undefined ? 1 : m.is_active ? 1 : 0];
  if (existing) db.run('UPDATE bank_rules SET name=?, direction=?, match_text=?, bank_account_id=?, account_id=?, vendor_id=?, customer_id=?, auto_add=?, priority=?, is_active=? WHERE id=?', ...vals, id);
  else id = db.insert('INSERT INTO bank_rules (company_id, name, direction, match_text, bank_account_id, account_id, vendor_id, customer_id, auto_add, priority, is_active) VALUES (?,?,?,?,?,?,?,?,?,?,?)', companyId, ...vals);
  audit(db, { companyId, userId, action: existing ? 'update' : 'create', entity: 'bank_rule', entityId: id, summary: name });
  return db.get('SELECT * FROM bank_rules WHERE id = ?', id);
}

export function deleteRule(db, companyId, id) {
  db.run('UPDATE bank_feed SET rule_id = NULL WHERE rule_id = ? AND company_id = ?', id, companyId);
  db.run('DELETE FROM bank_rules WHERE id = ? AND company_id = ?', id, companyId);
  return { ok: true };
}

/** Apply rules to everything awaiting review. Returns counts. */
export function applyRules(db, companyId, { account_id } = {}, userId = null) {
  const rules = db.all('SELECT * FROM bank_rules WHERE company_id = ? AND is_active = 1 ORDER BY priority, id', companyId);
  const pending = db.all(`SELECT * FROM bank_feed WHERE company_id = ? AND status = 'review' ${account_id ? 'AND account_id = ?' : ''}`, ...(account_id ? [companyId, account_id] : [companyId]));
  let suggested = 0, added = 0;
  for (const f of pending) {
    const rule = rules.find((r) => (r.direction === 'any' || (r.direction === 'in') === (f.amount > 0)) && (!r.bank_account_id || r.bank_account_id === f.account_id) && f.description.toLowerCase().includes(r.match_text.toLowerCase()));
    if (!rule) continue;
    db.run('UPDATE bank_feed SET suggested_account_id=?, suggested_vendor_id=?, suggested_customer_id=?, rule_id=? WHERE id=?', rule.account_id, rule.vendor_id, rule.customer_id, rule.id, f.id);
    suggested++;
    if (rule.auto_add) {
      try { addFromFeed(db, companyId, f.id, {}, userId); added++; } catch { /* leave for manual review */ }
    }
  }
  return { suggested, added };
}

// ---------------------------------------------------------------------------
// Reconciliation

function reconcilable(db, companyId, id) {
  const a = getAccount(db, companyId, id);
  if (!['bank', 'credit_card', 'other_current_asset', 'other_current_liability', 'long_term_liability', 'fixed_asset', 'other_asset'].includes(a.type)) throw bad('This account type cannot be reconciled');
  return a;
}

export function reconcileState(db, companyId, accountId, statementDate) {
  const a = reconcilable(db, companyId, accountId);
  const beg = db.get("SELECT COALESCE(SUM(debit),0) AS d, COALESCE(SUM(credit),0) AS c FROM journal_lines WHERE account_id = ? AND cleared = 'R'", a.id);
  const lines = db.all(`SELECT j.id, j.date, j.debit, j.credit, j.cleared, j.memo, j.transaction_id, t.type, t.number, COALESCE(c.display_name, v.display_name) AS payee
    FROM journal_lines j JOIN transactions t ON t.id = j.transaction_id LEFT JOIN customers c ON c.id = j.customer_id LEFT JOIN vendors v ON v.id = j.vendor_id
    WHERE j.account_id = ? AND j.cleared != 'R' ${statementDate ? 'AND j.date <= ?' : ''} ORDER BY j.date, j.id`, ...(statementDate ? [a.id, requireDate(statementDate, 'statement_date')] : [a.id]))
    .map((l) => ({ ...l, type_label: TXN_TYPES[l.type]?.label, amount: signed(a.type, l.debit, l.credit) }));
  const history = db.all(`SELECT r.*, u.name AS completed_by_name FROM reconciliations r LEFT JOIN users u ON u.id = r.completed_by WHERE r.account_id = ? ORDER BY r.statement_date DESC, r.id DESC`, a.id);
  return { account: a, beginning_balance: signed(a.type, beg.d, beg.c), lines, history, debit_normal: signed(a.type, 1, 0) === 1 };
}

export function saveClearedFlags(db, companyId, accountId, { cleared_ids = [] }) {
  const a = reconcilable(db, companyId, accountId);
  const set = new Set(cleared_ids.map(Number));
  db.tx(() => {
    for (const l of db.all("SELECT id, cleared FROM journal_lines WHERE account_id = ? AND cleared != 'R'", a.id)) {
      const want = set.has(l.id) ? 'C' : '';
      if (l.cleared !== want) db.run('UPDATE journal_lines SET cleared = ? WHERE id = ?', want, l.id);
    }
  });
  return { ok: true };
}

export function finishReconciliation(db, companyId, accountId, body, userId) {
  return db.tx(() => {
    const a = reconcilable(db, companyId, accountId);
    const statementDate = requireDate(body.statement_date, 'statement_date');
    const ending = toCents(body.ending_balance);
    const last = db.get('SELECT MAX(statement_date) AS d FROM reconciliations WHERE account_id = ?', a.id).d;
    if (last && statementDate < last) throw bad(`This account was already reconciled through ${last}`);
    const state = reconcileState(db, companyId, a.id, null);
    const ids = new Set((body.cleared_ids ?? []).map(Number));
    const chosen = state.lines.filter((l) => ids.has(l.id));
    if (chosen.length !== ids.size) throw bad('Some selected lines are not available to reconcile');
    if (chosen.some((l) => l.date > statementDate)) throw bad('Selected transactions must be dated on or before the statement date');
    const cleared = state.beginning_balance + chosen.reduce((s, l) => s + l.amount, 0);
    if (cleared !== ending) throw bad(`Difference is ${fmtMoney(ending - cleared)}. The cleared balance must equal the statement ending balance.`);
    const rid = db.insert('INSERT INTO reconciliations (company_id, account_id, statement_date, beginning_balance, ending_balance, cleared_count, completed_by) VALUES (?,?,?,?,?,?,?)',
      companyId, a.id, statementDate, state.beginning_balance, ending, chosen.length, userId);
    for (const l of chosen) db.run("UPDATE journal_lines SET cleared='R', reconciliation_id=? WHERE id=?", rid, l.id);
    audit(db, { companyId, userId, action: 'reconcile', entity: 'account', entityId: a.id, summary: `${a.name} reconciled through ${statementDate}, ending balance ${fmtMoney(ending)}` });
    return db.get('SELECT * FROM reconciliations WHERE id = ?', rid);
  });
}

export function undoLastReconciliation(db, companyId, accountId, userId) {
  return db.tx(() => {
    const a = reconcilable(db, companyId, accountId);
    const last = db.get('SELECT * FROM reconciliations WHERE account_id = ? ORDER BY statement_date DESC, id DESC LIMIT 1', a.id);
    if (!last) throw bad('This account has no reconciliations');
    db.run("UPDATE journal_lines SET cleared='C', reconciliation_id=NULL WHERE reconciliation_id = ?", last.id);
    db.run('DELETE FROM reconciliations WHERE id = ?', last.id);
    audit(db, { companyId, userId, action: 'undo', entity: 'reconciliation', entityId: last.id, summary: `${a.name} reconciliation through ${last.statement_date} undone` });
    return { ok: true };
  });
}
