// Recurring transactions: templates that create a real transaction on a schedule.
// A template is stored in the same input shape the API accepts for a new transaction (amounts in dollars),
// so creating an occurrence is just createTransaction(template + date).
import { bad, notFound, str, intOrNull, requireDate, isDate, toCents, addDays } from '../util.js';
import { createTransaction, getTransaction, TXN_TYPES } from './transactions.js';
import { audit } from './audit.js';

export const RECURRING_TYPES = ['invoice', 'sales_receipt', 'bill', 'expense', 'check', 'deposit', 'transfer', 'journal_entry'];
const FREQS = ['weekly', 'monthly', 'quarterly', 'yearly'];
const HEADER_KEYS = ['customer_id', 'vendor_id', 'account_id', 'to_account_id', 'tax_rate_id', 'memo', 'billing_address', 'total'];

class Rollback extends Error {}

/** Today's date in the firm's time zone (default Pacific), so schedules flip at local midnight. */
export function localToday(tz = process.env.LEDGER_TZ || 'America/Los_Angeles') {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-12
/** Next scheduled date after `date`. dom = preferred day of month (31 = last day). */
export function advance(date, frequency, n = 1, dom = null) {
  if (frequency === 'weekly') return addDays(date, 7 * n);
  const months = { monthly: 1, quarterly: 3, yearly: 12 }[frequency] * n;
  const [y, m, d] = date.split('-').map(Number);
  const total = (y * 12 + (m - 1)) + months;
  const ny = Math.floor(total / 12), nm = (total % 12) + 1;
  const day = Math.min(dom ?? d, lastDay(ny, nm));
  return `${ny}-${String(nm).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Keep only the parts of a transaction body that belong in a template. */
function cleanTemplate(type, body) {
  const t = { type };
  for (const k of HEADER_KEYS) if (body[k] !== undefined && body[k] !== null && body[k] !== '') t[k] = body[k];
  if (Array.isArray(body.lines)) t.lines = body.lines.filter((l) => !l.linked_txn_id).map((l) => {
    const o = {};
    for (const k of ['item_id', 'account_id', 'description', 'qty', 'rate', 'amount', 'taxable', 'customer_id', 'vendor_id', 'debit', 'credit']) if (l[k] !== undefined && l[k] !== null && l[k] !== '') o[k] = l[k];
    return o;
  }).filter((l) => Object.keys(l).length);
  return t;
}

/** Build a template from an existing transaction (for "Make recurring"). */
export function templateFromTransaction(db, companyId, txnId) {
  const t = getTransaction(db, companyId, txnId);
  if (!RECURRING_TYPES.includes(t.type)) throw bad(`A ${TXN_TYPES[t.type].label.toLowerCase()} can't be made recurring`);
  const d = (c) => (c === null || c === undefined ? undefined : c / 100);
  const body = {
    customer_id: t.customer_id, vendor_id: t.vendor_id, account_id: t.account_id, to_account_id: t.to_account_id, tax_rate_id: t.tax_rate_id,
    memo: t.memo?.replace(/\s*\[Voided.*\]$/, ''), billing_address: t.billing_address, total: t.type === 'transfer' ? d(t.total) : undefined,
    lines: t.lines.filter((l) => !l.linked_txn_id).map((l) => (t.type === 'journal_entry'
      ? { account_id: l.account_id, description: l.description, customer_id: l.customer_id, vendor_id: l.vendor_id, ...(l.amount > 0 ? { debit: d(l.amount) } : { credit: d(-l.amount) }) }
      : { item_id: l.item_id, account_id: t.type === 'invoice' || t.type === 'sales_receipt' ? (l.item_id ? undefined : l.account_id) : l.account_id, description: l.description, qty: l.qty, rate: d(l.rate), amount: d(l.amount), taxable: !!l.taxable, customer_id: l.customer_id })),
  };
  const template = cleanTemplate(t.type, body);
  const dom = Number(t.date.slice(8));
  return { type: t.type, template, template_view: templateView(template), suggested_name: `${TXN_TYPES[t.type].label} – ${t.payee ?? t.account_name ?? ''}`.replace(/ – $/, ''),
    from_date: t.date, next_date: advance(t.date, 'monthly', 1, dom), day_of_month: dom };
}

/** Template (input shape, dollars) → the shape the transaction form renders (cents). */
export function templateView(tpl) {
  const c = (v) => (v === undefined || v === null || v === '' ? null : toCents(v));
  return {
    ...tpl,
    total: tpl.total !== undefined ? c(tpl.total) : null,
    lines: (tpl.lines ?? []).map((l) => (tpl.type === 'journal_entry'
      ? { ...l, amount: (c(l.debit) ?? 0) - (c(l.credit) ?? 0) }
      : { ...l, qty: l.qty === undefined || l.qty === '' ? null : Number(l.qty), rate: c(l.rate), amount: c(l.amount) ?? (l.qty && l.rate ? Math.round(Number(l.qty) * toCents(l.rate)) : 0) })),
  };
}

/** Check a template by creating it for real inside a transaction that is rolled back. Returns the total. */
function dryRun(db, companyId, tpl, date) {
  let total = 0;
  try {
    db.tx(() => { total = createTransaction(db, companyId, { ...tpl, date }).total; throw new Rollback(); });
  } catch (e) { if (!(e instanceof Rollback)) throw e; }
  return total;
}

function validateSchedule(body, existing) {
  const m = { ...existing, ...body };
  const name = str(m.name, 120);
  if (!name) throw bad('Give the recurring transaction a name');
  if (!FREQS.includes(m.frequency)) throw bad('Choose how often it repeats');
  const n = Number(m.interval_n ?? 1);
  if (!Number.isInteger(n) || n < 1 || n > 52) throw bad('"Every" must be between 1 and 52');
  const next = requireDate(m.next_date, 'next date');
  const end = m.end_date ? requireDate(m.end_date, 'end date') : null;
  if (end && end < next) throw bad('The end date is before the next date');
  let dom = m.frequency === 'weekly' ? null : intOrNull(m.day_of_month) ?? Number(next.slice(8));
  if (dom !== null && (dom < 1 || dom > 31)) throw bad('Day of month must be 1-31');
  if (!['auto', 'reminder'].includes(m.mode ?? 'auto')) throw bad('Invalid mode');
  return { name, frequency: m.frequency, interval_n: n, day_of_month: dom, next_date: next, end_date: end, mode: m.mode ?? 'auto', is_active: m.is_active === undefined ? 1 : m.is_active ? 1 : 0 };
}

const view = (db, r) => {
  const tpl = JSON.parse(r.template);
  const payee = tpl.customer_id ? db.get('SELECT display_name AS n FROM customers WHERE id = ?', tpl.customer_id)?.n
    : tpl.vendor_id ? db.get('SELECT display_name AS n FROM vendors WHERE id = ?', tpl.vendor_id)?.n : null;
  const last = db.get("SELECT * FROM recurring_log WHERE recurring_id = ? ORDER BY id DESC LIMIT 1", r.id);
  return { ...r, template: tpl, amount: tpl._total ?? null, payee, type_label: TXN_TYPES[r.type]?.label, last_run: last ?? null, is_due: !!r.is_active && r.next_date <= localToday() };
};

export function listRecurring(db, companyId) {
  return db.all('SELECT * FROM recurring WHERE company_id = ? ORDER BY is_active DESC, next_date, name', companyId).map((r) => view(db, r));
}

export function getRecurring(db, companyId, id) {
  const r = db.get('SELECT * FROM recurring WHERE id = ? AND company_id = ?', id, companyId);
  if (!r) throw notFound('Recurring transaction');
  const v = view(db, r);
  return { ...v, template_view: templateView(v.template), history: db.all(`SELECT l.*, t.number, t.total FROM recurring_log l LEFT JOIN transactions t ON t.id = l.transaction_id WHERE l.recurring_id = ? ORDER BY l.id DESC LIMIT 50`, id) };
}

export function saveRecurring(db, companyId, body, id = null, userId = null) {
  const existing = id ? db.get('SELECT * FROM recurring WHERE id = ? AND company_id = ?', id, companyId) : null;
  if (id && !existing) throw notFound('Recurring transaction');
  const type = existing?.type ?? body.type;
  if (!RECURRING_TYPES.includes(type)) throw bad('That type of transaction can\'t be recurring');
  const s = validateSchedule(body, existing ?? {});
  if (db.get('SELECT 1 FROM recurring WHERE company_id = ? AND name = ? AND id != ?', companyId, s.name, id ?? 0)) throw bad(`A recurring transaction named "${s.name}" already exists`);
  // Resuming a paused template: don't create a backlog for the paused months; continue from today.
  if (existing && !existing.is_active && s.is_active && !body.next_date) {
    const today = localToday();
    for (let i = 0; i < 600 && s.next_date < today; i++) s.next_date = advance(s.next_date, s.frequency, s.interval_n, s.day_of_month);
  }
  let tpl = body.template ? cleanTemplate(type, body.template) : JSON.parse(existing.template);
  const company = db.get('SELECT closing_date FROM companies WHERE id = ?', companyId);
  if (company.closing_date && s.next_date <= company.closing_date) throw bad(`The next date must be after the closing date (${company.closing_date})`);
  tpl._total = dryRun(db, companyId, { ...tpl, _total: undefined }, s.next_date); // throws a clear message if the template isn't valid
  const json = JSON.stringify(tpl);
  if (existing) {
    db.run('UPDATE recurring SET name=?, template=?, frequency=?, interval_n=?, day_of_month=?, next_date=?, end_date=?, mode=?, is_active=?, last_error=NULL WHERE id=?',
      s.name, json, s.frequency, s.interval_n, s.day_of_month, s.next_date, s.end_date, s.mode, s.is_active, id);
  } else {
    id = db.insert('INSERT INTO recurring (company_id, name, type, template, frequency, interval_n, day_of_month, next_date, end_date, mode, is_active, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      companyId, s.name, type, json, s.frequency, s.interval_n, s.day_of_month, s.next_date, s.end_date, s.mode, s.is_active, userId);
  }
  audit(db, { companyId, userId, action: existing ? 'update' : 'create', entity: 'recurring', entityId: id, summary: `${s.name} (${s.frequency})` });
  return getRecurring(db, companyId, id);
}

export function deleteRecurring(db, companyId, id, userId) {
  const r = db.get('SELECT * FROM recurring WHERE id = ? AND company_id = ?', id, companyId);
  if (!r) throw notFound('Recurring transaction');
  db.run('DELETE FROM recurring WHERE id = ?', id);
  audit(db, { companyId, userId, action: 'delete', entity: 'recurring', entityId: id, summary: r.name });
  return { ok: true };
}

/** Create the next occurrence (dated next_date), log it, and move next_date forward. */
function createOccurrence(db, r, userId = null) {
  const tpl = JSON.parse(r.template);
  delete tpl._total;
  const t = createTransaction(db, r.company_id, { ...tpl, date: r.next_date, memo: tpl.memo }, userId);
  db.run("INSERT INTO recurring_log (recurring_id, scheduled_date, transaction_id, status) VALUES (?,?,?,'created')", r.id, r.next_date, t.id);
  moveNext(db, r);
  return t;
}

function moveNext(db, r) {
  const next = advance(r.next_date, r.frequency, r.interval_n, r.day_of_month);
  const done = r.end_date && next > r.end_date;
  db.run('UPDATE recurring SET next_date = ?, is_active = ?, last_error = NULL WHERE id = ?', next, done ? 0 : r.is_active, r.id);
  return next;
}

export function createNow(db, companyId, id, userId) {
  return db.tx(() => {
    const r = db.get('SELECT * FROM recurring WHERE id = ? AND company_id = ?', id, companyId);
    if (!r) throw notFound('Recurring transaction');
    if (!r.is_active) throw bad('This recurring transaction is paused or finished');
    return createOccurrence(db, r, userId);
  });
}

export function skipNext(db, companyId, id, userId) {
  return db.tx(() => {
    const r = db.get('SELECT * FROM recurring WHERE id = ? AND company_id = ?', id, companyId);
    if (!r) throw notFound('Recurring transaction');
    db.run("INSERT INTO recurring_log (recurring_id, scheduled_date, status, message) VALUES (?,?,'skipped','Skipped by user')", r.id, r.next_date);
    audit(db, { companyId, userId, action: 'skip', entity: 'recurring', entityId: id, summary: `${r.name}: skipped ${r.next_date}` });
    return { next_date: moveNext(db, r) };
  });
}

/**
 * Create every automatic occurrence that is due (catching up on missed ones, max 36 per template).
 * Reminder-mode templates are left for a person to create or skip. Returns counts.
 */
export function runDue(db, { companyId = null, today = localToday() } = {}) {
  let created = 0, errors = 0;
  const due = db.all(`SELECT * FROM recurring WHERE is_active = 1 AND mode = 'auto' AND next_date <= ? ${companyId ? 'AND company_id = ?' : ''}`, ...(companyId ? [today, companyId] : [today]));
  for (let r of due) {
    for (let i = 0; i < 36 && r.is_active && r.next_date <= today && (!r.end_date || r.next_date <= r.end_date); i++) {
      try {
        db.tx(() => createOccurrence(db, r));
        created++;
      } catch (e) {
        errors++;
        db.run('UPDATE recurring SET last_error = ? WHERE id = ?', e.message, r.id);
        db.run("INSERT INTO recurring_log (recurring_id, scheduled_date, status, message) VALUES (?,?,'error',?)", r.id, r.next_date, e.message);
        break;
      }
      r = db.get('SELECT * FROM recurring WHERE id = ?', r.id);
    }
  }
  return { created, errors };
}

/** Reminder-mode templates waiting for someone, plus automatic ones that failed. */
export function dueReminders(db, companyId, today = localToday()) {
  return listRecurring(db, companyId).filter((r) => r.is_active && r.next_date <= today && (r.mode === 'reminder' || r.last_error));
}

void isDate;
