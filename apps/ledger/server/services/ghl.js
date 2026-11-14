// GoHighLevel (GHL) sync: pull a client sub-account's invoices and payments into the books.
// Read-only on the GHL side. Outbound HTTPS only, so the ledger server stays closed to the internet.
// API reference: https://github.com/GoHighLevel/highlevel-api-docs (apps/invoices.json, apps/payments.json)
import { createHash } from 'node:crypto';
import { bad, notFound, str, intOrNull, requireDate, addDays, today } from '../util.js';
import { systemAccount, getAccount } from './accounts.js';
import { createTransaction, updateTransaction, voidTransaction, getTransaction } from './transactions.js';
import { audit } from './audit.js';

const API_BASE = () => process.env.GHL_API_BASE || 'https://services.leadconnectorhq.com';
const API_VERSION = '2021-07-28';
const PAGE = 100;
class Rollback extends Error {}

// ---------------------------------------------------------------------------
// Connection settings

export function getConnection(db, companyId, { withToken = false } = {}) {
  const c = db.get('SELECT * FROM ghl_connections WHERE company_id = ?', companyId);
  if (!c) return null;
  const issues = db.all("SELECT id, kind, external_id, message, at FROM sync_issues WHERE company_id = ? AND source = 'ghl' ORDER BY at DESC LIMIT 100", companyId);
  const { token, ...rest } = c;
  return { ...rest, ...(withToken ? { token } : {}), token_hint: token ? `••••${token.slice(-4)}` : null, last_result: c.last_result ? JSON.parse(c.last_result) : null, issues };
}

export function saveConnection(db, companyId, body, userId) {
  const existing = db.get('SELECT * FROM ghl_connections WHERE company_id = ?', companyId);
  const company = db.get('SELECT * FROM companies WHERE id = ?', companyId);
  const location = str(body.location_id ?? existing?.location_id, 100);
  if (!location || !/^[A-Za-z0-9_-]{6,64}$/.test(location)) throw bad('Enter the GHL Location ID (Settings → Business Profile in the sub-account)');
  const token = str(body.token, 500) ?? existing?.token;
  if (!token) throw bad('Paste the Private Integration key from the GHL sub-account');
  const defaultStart = company.closing_date ? addDays(company.closing_date, 1) : today();
  const start = requireDate(body.start_date ?? existing?.start_date ?? defaultStart, 'start date');
  const inc = intOrNull(body.income_account_id ?? existing?.income_account_id);
  if (inc) { const a = getAccount(db, companyId, inc); if (!['income', 'other_income'].includes(a.type)) throw bad('Choose an income account'); }
  const enabled = body.is_enabled === undefined ? (existing?.is_enabled ?? 1) : body.is_enabled ? 1 : 0;
  db.run(`INSERT INTO ghl_connections (company_id, location_id, token, start_date, income_account_id, is_enabled) VALUES (?,?,?,?,?,?)
    ON CONFLICT(company_id) DO UPDATE SET location_id=excluded.location_id, token=excluded.token, start_date=excluded.start_date, income_account_id=excluded.income_account_id, is_enabled=excluded.is_enabled`,
  companyId, location, token, start, inc, enabled);
  audit(db, { companyId, userId, action: existing ? 'update' : 'create', entity: 'ghl_connection', summary: `GHL sub-account ${location}, from ${start}${enabled ? '' : ' (paused)'}` });
  return getConnection(db, companyId);
}

export function dismissIssue(db, companyId, id) {
  db.run("DELETE FROM sync_issues WHERE id = ? AND company_id = ? AND source = 'ghl'", id, companyId);
  return getConnection(db, companyId);
}

export function deleteConnection(db, companyId, userId) {
  db.run('DELETE FROM ghl_connections WHERE company_id = ?', companyId);
  audit(db, { companyId, userId, action: 'delete', entity: 'ghl_connection', summary: 'GHL disconnected (records already brought in are kept)' });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// GHL API

async function ghl(conn, path, query = {}) {
  const url = new URL(API_BASE() + path);
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  for (let attempt = 0; attempt < 3; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers: { Authorization: `Bearer ${conn.token}`, Version: API_VERSION, Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
    } catch (e) { throw new Error(`Couldn't reach GHL (${e.cause?.code ?? e.name}). Check the server's internet connection.`); }
    if (res.status === 429 && attempt < 2) { await new Promise((r) => setTimeout(r, (Number(res.headers.get('retry-after')) || 2) * 1000)); continue; }
    const text = await res.text();
    let body; try { body = JSON.parse(text); } catch { body = { message: text.slice(0, 200) }; }
    if (res.status === 401) throw new Error('GHL rejected the key. Create a new Private Integration key in the sub-account and paste it here.');
    if (res.status === 403) throw new Error(`GHL says the key isn't allowed to read ${path.split('/')[1]}. Edit the Private Integration and make sure it has the read-only scopes invoices.readonly and payments/transactions.readonly.`);
    if (!res.ok) throw new Error(`GHL error ${res.status} on ${path}: ${body?.message ?? 'unknown'}`);
    return body;
  }
  throw new Error('GHL is rate-limiting requests; try again in a minute.');
}

async function listAll(conn, path, query, key) {
  const out = [];
  for (let page = 0; page < 200; page++) {
    const body = await ghl(conn, path, { ...query, limit: PAGE, offset: page * PAGE });
    const rows = body?.[key] ?? [];
    out.push(...rows);
    const total = body.total ?? body.totalCount;
    if (rows.length < PAGE || (total !== undefined && out.length >= total)) break;
  }
  return out;
}

const locQuery = (conn) => ({ altId: conn.location_id, altType: 'location' });

export async function fetchGhl(conn) {
  const invoices = await listAll(conn, '/invoices/', { ...locQuery(conn), startAt: conn.start_date }, 'invoices');
  const payments = await listAll(conn, '/payments/transactions', { ...locQuery(conn), locationId: conn.location_id, startAt: conn.start_date }, 'data');
  return { invoices, payments };
}

export async function testConnection(db, companyId) {
  const conn = getConnection(db, companyId, { withToken: true });
  if (!conn) throw notFound('GHL connection');
  const out = {};
  for (const [key, path, q, list] of [['invoices', '/invoices/', locQuery(conn), 'invoices'], ['payments', '/payments/transactions', { ...locQuery(conn), locationId: conn.location_id }, 'data']]) {
    try { const b = await ghl(conn, path, { ...q, limit: 1 }); out[key] = { ok: true, total: b.total ?? b.totalCount ?? (b[list]?.length ?? 0) }; }
    catch (e) { out[key] = { ok: false, error: e.message }; }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Mapping helpers

const money = (n) => Math.round(Number(n ?? 0) * 100) / 100;
const fp = (o) => createHash('sha256').update(JSON.stringify(o)).digest('hex').slice(0, 24);
const localDate = (iso, tz = process.env.LEDGER_TZ || 'America/Los_Angeles') => {
  if (!iso) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
};
const statusOf = (s) => String((s && typeof s === 'object' ? s.value ?? s.status ?? '' : s) ?? '').toLowerCase();

function link(db, cid, kind, externalId) {
  return db.get("SELECT * FROM external_links WHERE company_id = ? AND source = 'ghl' AND kind = ? AND external_id = ?", cid, kind, String(externalId));
}
function setLink(db, cid, kind, externalId, localId, fingerprint = null) {
  db.run(`INSERT INTO external_links (company_id, source, kind, external_id, local_id, fingerprint) VALUES (?, 'ghl', ?, ?, ?, ?)
    ON CONFLICT(company_id, source, kind, external_id) DO UPDATE SET local_id = excluded.local_id, fingerprint = excluded.fingerprint, synced_at = datetime('now')`,
  cid, kind, String(externalId), localId, fingerprint);
}
function issue(db, cid, kind, externalId, message) {
  db.run(`INSERT INTO sync_issues (company_id, source, kind, external_id, message) VALUES (?, 'ghl', ?, ?, ?)
    ON CONFLICT(company_id, source, kind, external_id) DO UPDATE SET message = excluded.message, at = datetime('now')`, cid, kind, String(externalId), message);
}
const clearIssue = (db, cid, kind, externalId) => db.run("DELETE FROM sync_issues WHERE company_id = ? AND source = 'ghl' AND kind = ? AND external_id = ?", cid, kind, String(externalId));

function ensureCustomer(db, cid, contact, stats) {
  const id = contact?.id ?? contact?.contactId;
  if (id) { const l = link(db, cid, 'contact', id); if (l && db.get('SELECT 1 FROM customers WHERE id = ?', l.local_id)) return l.local_id; }
  const name = str(contact?.companyName || contact?.name || contact?.contactName || contact?.email || 'GHL customer', 120);
  let row = db.get('SELECT id FROM customers WHERE company_id = ? AND display_name = ? COLLATE NOCASE', cid, name);
  if (!row) {
    const a = contact?.address ?? {};
    const address = [a.addressLine1, a.addressLine2, [a.city, [a.state, a.postalCode].filter(Boolean).join(' ')].filter(Boolean).join(', ')].filter(Boolean).join('\n') || null;
    const newId = db.insert('INSERT INTO customers (company_id, display_name, company_name, contact_name, email, phone, billing_address, notes) VALUES (?,?,?,?,?,?,?,?)',
      cid, name, str(contact?.companyName), contact?.companyName ? str(contact?.name) : null, str(contact?.email ?? contact?.contactEmail), str(contact?.phoneNo ?? contact?.phone, 40), address, 'Added by GHL sync');
    row = { id: newId };
    stats.customers++;
  }
  if (id) setLink(db, cid, 'contact', id, row.id);
  return row.id;
}

function ensureProduct(db, cid, it, incomeId) {
  if (!it.productId) return null;
  const l = link(db, cid, 'product', it.productId);
  if (l && db.get('SELECT 1 FROM items WHERE id = ?', l.local_id)) return l.local_id;
  const name = str(it.name, 120) ?? 'GHL product';
  let row = db.get('SELECT id FROM items WHERE company_id = ? AND name = ? COLLATE NOCASE', cid, name);
  if (!row) row = { id: db.insert('INSERT INTO items (company_id, name, description, type, sales_price, income_account_id) VALUES (?,?,?,?,?,?)', cid, name, str(it.description, 1000), 'service', Math.round(money(it.amount) * 100), incomeId) };
  setLink(db, cid, 'product', it.productId, row.id);
  return row.id;
}

function defaultIncome(db, cid, conn) {
  if (conn.income_account_id) return conn.income_account_id;
  return db.get("SELECT id FROM accounts WHERE company_id = ? AND type = 'income' AND is_active = 1 ORDER BY number, name LIMIT 1", cid)?.id;
}

/** Build our invoice body from a GHL invoice. Returns { body, warning }. */
function invoiceBody(db, cid, conn, inv, customerId, incomeId) {
  const lines = [];
  for (const it of inv.invoiceItems ?? []) {
    const itemId = ensureProduct(db, cid, it, incomeId);
    lines.push({ item_id: itemId, account_id: itemId ? undefined : incomeId, description: [it.name, it.description].filter(Boolean).join(' — ') || 'GHL item', qty: Number(it.qty ?? 1), rate: money(it.amount) });
  }
  const sum = (ls) => Math.round(ls.reduce((s, l) => s + Math.round((l.qty ?? 1) * l.rate * 100), 0)) / 100;
  const discount = money(inv.totalSummary?.discount);
  if (discount > 0) {
    const disc = db.get("SELECT id FROM accounts WHERE company_id = ? AND name LIKE 'Discount%' AND type = 'income' LIMIT 1", cid)?.id ?? incomeId;
    lines.push({ account_id: disc, description: 'Discount', qty: 1, rate: -discount });
  }
  const tax = money(inv.totalSummary?.tax);
  const inclusive = (inv.invoiceItems ?? []).some((it) => it.taxInclusive);
  if (tax > 0) {
    lines.push({ account_id: systemAccount(db, cid, 'SALES_TAX').id, description: 'Sales tax', qty: 1, rate: tax });
    if (inclusive) lines.push({ account_id: incomeId, description: 'Sales tax included in prices', qty: 1, rate: -tax });
  }
  let warning = null;
  const diff = Math.round((money(inv.total) - sum(lines)) * 100) / 100;
  if (diff !== 0) {
    if (Math.abs(diff) > 1) throw new Error(`Its lines add up to $${sum(lines).toFixed(2)} but GHL's total is $${money(inv.total).toFixed(2)}. Enter it by hand.`);
    lines.push({ account_id: incomeId, description: 'Rounding difference from GHL', qty: 1, rate: diff });
    warning = `adjusted by $${diff.toFixed(2)} for rounding`;
  }
  const date = localDate(inv.issueDate);
  const due = localDate(inv.dueDate);
  return {
    body: { type: 'invoice', date, due_date: due && due >= date ? due : date, customer_id: customerId, memo: [inv.title || inv.name, `GHL invoice ${inv.invoiceNumber ?? inv._id}`].filter(Boolean).join(' · '), lines },
    warning,
  };
}

function numberFor(db, cid, inv, existingId) {
  const n = String(inv.invoiceNumber ?? '').trim();
  if (!n) return undefined;
  const taken = db.get("SELECT id FROM transactions WHERE company_id = ? AND type = 'invoice' AND number = ? AND id != ?", cid, n, existingId ?? 0);
  return taken ? `GHL-${n}` : n;
}

// ---------------------------------------------------------------------------
// Apply (synchronous, inside the database)

function applyInvoices(db, cid, conn, invoices, stats, preview) {
  const incomeId = defaultIncome(db, cid, conn);
  const sorted = [...invoices].sort((a, b) => String(a.issueDate).localeCompare(String(b.issueDate)));
  for (const inv of sorted) {
    const st = statusOf(inv.status);
    const date = localDate(inv.issueDate);
    if (st === 'draft' || inv.liveMode === false || !date || date < conn.start_date) { stats.invoices.skipped++; continue; }
    const l = link(db, cid, 'invoice', inv._id);
    const label = `GHL invoice ${inv.invoiceNumber ?? inv._id}`;
    try {
      db.tx(() => {
        if ((inv.currency ?? 'USD').toUpperCase() !== 'USD') throw new Error(`It's in ${inv.currency}; only USD is supported.`);
        if (st === 'void') {
          if (l && db.get("SELECT 1 FROM transactions WHERE id = ? AND status = 'posted'", l.local_id)) { voidTransaction(db, cid, l.local_id); stats.invoices.voided++; preview.push({ kind: 'invoice', action: 'void', label, total: money(inv.total) }); }
          else stats.invoices.skipped++;
          return;
        }
        const fingerprint = fp({ n: inv.invoiceNumber, d: inv.issueDate, u: inv.dueDate, c: inv.contactDetails?.id, items: inv.invoiceItems, t: inv.total, s: inv.totalSummary });
        const exists = l && db.get('SELECT * FROM transactions WHERE id = ?', l.local_id);
        if (exists && l.fingerprint === fingerprint) { stats.invoices.unchanged++; return; }
        const customerId = ensureCustomer(db, cid, inv.contactDetails, stats);
        const { body, warning } = invoiceBody(db, cid, conn, inv, customerId, incomeId);
        body.number = numberFor(db, cid, inv, exists?.id);
        let txn;
        if (exists) {
          if (exists.status === 'voided') return;
          txn = updateTransaction(db, cid, exists.id, body);
          stats.invoices.updated++;
        } else {
          txn = createTransaction(db, cid, body);
          stats.invoices.created++;
        }
        setLink(db, cid, 'invoice', inv._id, txn.id, fingerprint);
        preview.push({ kind: 'invoice', action: exists ? 'update' : 'create', label: `Invoice ${txn.number}`, who: inv.contactDetails?.companyName || inv.contactDetails?.name, date: body.date, total: txn.total / 100, note: warning });
        clearIssue(db, cid, 'invoice', inv._id);
      });
    } catch (e) {
      stats.issues++;
      issue(db, cid, 'invoice', inv._id, `${label} (${inv.contactDetails?.name ?? 'unknown contact'}, ${date}): ${e.message}`);
      preview.push({ kind: 'invoice', action: 'problem', label, who: inv.contactDetails?.name, date, total: money(inv.total), note: e.message });
    }
  }
}

function applyPayments(db, cid, conn, payments, stats, preview) {
  const incomeId = defaultIncome(db, cid, conn);
  const uf = systemAccount(db, cid, 'UNDEPOSITED').id;
  const sorted = [...payments].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  for (const p of sorted) {
    const st = statusOf(p.status);
    const date = localDate(p.createdAt);
    if (!['succeeded', 'refunded', 'partially_refunded', 'paid'].includes(st) || p.liveMode === false || !date || date < conn.start_date) { stats.payments.skipped++; continue; }
    const label = `GHL payment ${p.chargeId ?? p._id}`;
    try {
      db.tx(() => {
        if ((p.currency ?? 'usd').toLowerCase() !== 'usd') throw new Error(`It's in ${p.currency}; only USD is supported.`);
        const amount = money(p.amount);
        let pl = link(db, cid, 'payment', p._id);
        let customerId;
        if (!pl || !db.get('SELECT 1 FROM transactions WHERE id = ?', pl.local_id)) {
          const isInvoice = String(p.entityType ?? p.entitySourceType ?? '').toLowerCase().includes('invoice');
          const il = isInvoice && p.entityId ? link(db, cid, 'invoice', p.entityId) : null;
          const target = il ? db.get("SELECT * FROM transactions WHERE id = ? AND status = 'posted'", il.local_id) : null;
          let txn;
          if (target) {
            customerId = target.customer_id;
            const open = target.total - db.get('SELECT COALESCE(SUM(amount),0) AS s FROM applications WHERE target_txn_id = ?', target.id).s;
            const apply = Math.min(Math.round(amount * 100), Math.max(open, 0));
            txn = createTransaction(db, cid, { type: 'payment', date, customer_id: customerId, account_id: uf, total: amount, number: String(p.chargeId ?? '').slice(0, 30) || undefined,
              memo: `${label}${apply < Math.round(amount * 100) ? ' (more than the open balance; the rest is a customer credit)' : ''}`, applications: apply > 0 ? [{ target_txn_id: target.id, amount: apply / 100 }] : [] });
          } else if (isInvoice) {
            customerId = ensureCustomer(db, cid, { id: p.contactId, name: p.contactName, email: p.contactEmail }, stats);
            txn = createTransaction(db, cid, { type: 'payment', date, customer_id: customerId, account_id: uf, total: amount, number: String(p.chargeId ?? '').slice(0, 30) || undefined, memo: `${label} for a GHL invoice from before the sync start date` });
            // A note, not an error: it stays listed until someone dismisses it.
            issue(db, cid, 'payment-note', p._id, `${label} (${p.contactName ?? 'customer'}, ${date}, $${amount.toFixed(2)}) paid a GHL invoice from before the sync start date. It was recorded as a customer credit; apply it to the opening invoice with Receive payment.`);
            stats.issues++;
          } else {
            customerId = p.contactId || p.contactName ? ensureCustomer(db, cid, { id: p.contactId, name: p.contactName, email: p.contactEmail }, stats) : null;
            txn = createTransaction(db, cid, { type: 'sales_receipt', date, customer_id: customerId, account_id: uf, number: String(p.chargeId ?? '').slice(0, 30) || undefined, memo: label,
              lines: [{ account_id: incomeId, description: p.entitySourceName || 'GHL payment', qty: 1, rate: amount }] });
          }
          setLink(db, cid, 'payment', p._id, txn.id);
          pl = link(db, cid, 'payment', p._id);
          stats.payments.created++;
          preview.push({ kind: 'payment', action: 'create', label: txn.type === 'payment' ? 'Payment' : 'Sales receipt', who: p.contactName, date, total: amount, note: p.entitySourceName ?? null });
        } else {
          customerId = db.get('SELECT customer_id FROM transactions WHERE id = ?', pl.local_id)?.customer_id;
          stats.payments.unchanged++;
        }
        // Refunds: record whatever has been refunded since last time.
        const refunded = money(p.amountRefunded);
        const rl = link(db, cid, 'refund', p._id);
        const already = rl ? Number(rl.fingerprint) : 0;
        if (refunded > already + 0.004) {
          const delta = Math.round((refunded - already) * 100) / 100;
          const je = createTransaction(db, cid, { type: 'journal_entry', date: localDate(p.updatedAt) ?? date, memo: `Refund of ${label}`, lines: [
            { account_id: incomeId, debit: delta, description: `Refund to ${p.contactName ?? 'customer'}`, customer_id: customerId },
            { account_id: uf, credit: delta, description: `Refund of ${label}`, customer_id: customerId },
          ] });
          setLink(db, cid, 'refund', p._id, je.id, String(refunded));
          stats.payments.refunds++;
          preview.push({ kind: 'refund', action: 'create', label: 'Refund', who: p.contactName, date: localDate(p.updatedAt) ?? date, total: -delta });
        }
        clearIssue(db, cid, 'payment', p._id);
      });
    } catch (e) {
      stats.issues++;
      issue(db, cid, 'payment', p._id, `${label} (${p.contactName ?? 'customer'}, ${date}, $${money(p.amount).toFixed(2)}): ${e.message}`);
      preview.push({ kind: 'payment', action: 'problem', label, who: p.contactName, date, total: money(p.amount), note: e.message });
    }
  }
}

/** Fetch from GHL and bring everything new or changed into the books. dryRun = preview (rolled back). */
export async function syncCompany(db, companyId, { dryRun = false } = {}) {
  const conn = getConnection(db, companyId, { withToken: true });
  if (!conn) throw notFound('GHL connection');
  let data;
  try { data = await fetchGhl(conn); }
  catch (e) {
    if (!dryRun) db.run("UPDATE ghl_connections SET last_sync_at = datetime('now'), last_error = ? WHERE company_id = ?", e.message, companyId);
    throw e;
  }
  const stats = { invoices: { created: 0, updated: 0, voided: 0, unchanged: 0, skipped: 0 }, payments: { created: 0, refunds: 0, unchanged: 0, skipped: 0 }, customers: 0, issues: 0, fetched: { invoices: data.invoices.length, payments: data.payments.length } };
  const preview = [];
  const run = () => { applyInvoices(db, companyId, conn, data.invoices, stats, preview); applyPayments(db, companyId, conn, data.payments, stats, preview); };
  if (dryRun) {
    try { db.tx(() => { run(); throw new Rollback(); }); } catch (e) { if (!(e instanceof Rollback)) throw e; }
    return { dry_run: true, stats, preview };
  }
  run();
  db.run("UPDATE ghl_connections SET last_sync_at = datetime('now'), last_result = ?, last_error = NULL WHERE company_id = ?", JSON.stringify(stats), companyId);
  if (stats.invoices.created + stats.invoices.updated + stats.invoices.voided + stats.payments.created + stats.payments.refunds > 0) {
    audit(db, { companyId, action: 'sync', entity: 'ghl', summary: `GHL: ${stats.invoices.created} invoices added, ${stats.invoices.updated} updated, ${stats.invoices.voided} voided, ${stats.payments.created} payments, ${stats.payments.refunds} refunds${stats.issues ? `, ${stats.issues} need attention` : ''}` });
  }
  return { dry_run: false, stats, preview };
}

/** Hourly: sync every enabled connection, one after another. */
export async function syncAll(db) {
  const results = [];
  for (const c of db.all('SELECT company_id FROM ghl_connections WHERE is_enabled = 1')) {
    try { results.push({ company_id: c.company_id, ...(await syncCompany(db, c.company_id)).stats }); }
    catch (e) { results.push({ company_id: c.company_id, error: e.message }); }
  }
  return results;
}

void getTransaction;
