// Import from QuickBooks Online exports (Excel .xlsx or CSV):
//   accounts  — Reports › Account List
//   customers — Sales › Customers › Export
//   vendors   — Expenses › Vendors › Export
//   opening   — Reports › Trial Balance (as of the cutover date), plus optional
//               A/R Aging Detail and A/P Aging Detail (same date) to rebuild open invoices and bills.
// Every import runs inside a transaction. Preview runs the real import and rolls it back,
// so what you see in the preview is exactly what an import would do.
import { bad, toCents, str, requireDate, fmtMoney } from '../util.js';
import { ACCOUNT_TYPES, systemAccount } from './accounts.js';
import { createTransaction, deleteTransaction } from './transactions.js';
import { readUpload, findHeader, toIsoDate } from './tabular.js';
import { audit } from './audit.js';

class Rollback extends Error {}

function run(db, { dryRun }, fn) {
  let result;
  try {
    db.tx(() => { result = fn(); if (dryRun) throw new Rollback(); });
  } catch (e) { if (!(e instanceof Rollback)) throw e; }
  return { ...result, dry_run: !!dryRun };
}

const rowsOf = (file, what) => {
  if (!file) throw bad(`Choose the ${what} file`);
  const up = readUpload(file);
  if (!up.rows) throw bad(`The ${what} file must be an Excel (.xlsx) or CSV export`);
  return up.rows;
};
const cell = (r, i) => (i >= 0 ? String(r[i] ?? '').trim() : '');
const money = (v) => { try { return toCents(String(v ?? '').trim() || 0); } catch { return null; } };
const isSkippable = (name) => !name || /^total\b/i.test(name) || /^(net income|grand total)$/i.test(name);

// --- Account types -----------------------------------------------------------
const TYPE_MAP = {
  bank: 'bank', accountsreceivablear: 'accounts_receivable', accountsreceivable: 'accounts_receivable',
  othercurrentassets: 'other_current_asset', othercurrentasset: 'other_current_asset',
  fixedassets: 'fixed_asset', fixedasset: 'fixed_asset', propertyplantandequipment: 'fixed_asset',
  otherassets: 'other_asset', otherasset: 'other_asset',
  accountspayableap: 'accounts_payable', accountspayable: 'accounts_payable', creditcard: 'credit_card',
  othercurrentliabilities: 'other_current_liability', othercurrentliability: 'other_current_liability',
  longtermliabilities: 'long_term_liability', longtermliability: 'long_term_liability',
  equity: 'equity', income: 'income', costofgoodssold: 'cost_of_goods_sold', costofsales: 'cost_of_goods_sold',
  expenses: 'expense', expense: 'expense', otherincome: 'other_income', otherexpense: 'other_expense', otherexpenses: 'other_expense',
};
export const mapType = (t) => TYPE_MAP[String(t ?? '').toLowerCase().replace(/[^a-z]/g, '')] ?? null;

/** "1000 Checking" → { number: '1000', name: 'Checking' } */
function splitNumber(name) {
  const m = name.match(/^(\d[\d.-]{2,})\s+(.+)$/);
  return m ? { number: m[1], name: m[2] } : { number: null, name };
}

// --- Chart of accounts ---------------------------------------------------------
export function importAccounts(db, companyId, body, userId) {
  const rows = rowsOf(body.file, 'Account List');
  const h = findHeader(rows, {
    name: ['account', 'account name', 'name', 'full name', 'account full name'],
    type: ['type', 'account type'], detail: ['detail type', 'detail_type'],
    number: ['account #', 'account number', 'number', 'acct #', 'account no.', 'acct num', 'account no'],
    description: ['description'],
  }, ['name', 'type']);
  if (!h) throw bad('Couldn’t find the "Account" and "Type" columns. Export Reports › Account List from QuickBooks.');
  return run(db, body, () => {
    const out = { created: [], updated: [], linked: [], removed: [], warnings: [] };
    const items = [];
    for (const r of rows.slice(h.index + 1)) {
      const full = cell(r, h.cols.name);
      if (isSkippable(full)) continue;
      const type = mapType(cell(r, h.cols.type));
      if (!type) { out.warnings.push(`Skipped "${full}": unknown account type "${cell(r, h.cols.type)}"`); continue; }
      const parts = full.split(':').map((p) => p.trim()).filter(Boolean);
      let leaf = parts.at(-1), number = cell(r, h.cols.number) || null;
      if (h.cols.number < 0) { const s = splitNumber(leaf); number = s.number; leaf = s.name; }
      items.push({ full, parts, leaf, number, type, detail: cell(r, h.cols.detail) || null, description: cell(r, h.cols.description) || null });
    }
    if (!items.length) throw bad('No accounts found in that file');
    items.sort((a, b) => a.parts.length - b.parts.length);
    const all = () => db.all('SELECT * FROM accounts WHERE company_id = ?', companyId);
    const byFull = new Map();
    const touched = new Set();
    for (const it of items) {
      const parentFull = it.parts.slice(0, -1).join(':');
      const parent = parentFull ? byFull.get(parentFull.toLowerCase()) : null;
      if (parentFull && !parent) out.warnings.push(`"${it.full}": parent account "${parentFull}" wasn't in the file; imported at top level`);
      const accounts = all();
      let acct = accounts.find((a) => a.name.toLowerCase() === it.leaf.toLowerCase() && !touched.has(a.id) && (!a.parent_id || a.parent_id === parent?.id));
      if (!acct && ['accounts_receivable', 'accounts_payable'].includes(it.type)) {
        const sys = systemAccount(db, companyId, it.type === 'accounts_receivable' ? 'AR' : 'AP');
        if (!touched.has(sys.id)) { acct = sys; out.linked.push(`${it.full} → system ${it.type === 'accounts_receivable' ? 'A/R' : 'A/P'} account`); }
      }
      let name = it.leaf;
      const clash = accounts.find((a) => a.name.toLowerCase() === name.toLowerCase() && a.id !== acct?.id);
      if (clash) name = parent ? `${it.leaf} (${parent.name})` : `${it.leaf} (${ACCOUNT_TYPES[it.type].label})`;
      let parentId = parent?.id ?? null;
      if (parent && parent.type !== it.type) { out.warnings.push(`"${it.full}" is a ${ACCOUNT_TYPES[it.type].label} account under a ${ACCOUNT_TYPES[parent.type].label} parent; imported at top level`); parentId = null; }
      if (acct) {
        let type = acct.type;
        if (acct.type !== it.type) {
          const used = db.get('SELECT 1 FROM journal_lines WHERE account_id = ? LIMIT 1', acct.id);
          if (used || acct.system_key) out.warnings.push(`"${it.full}" is ${ACCOUNT_TYPES[it.type].label} in QuickBooks but already exists here as ${ACCOUNT_TYPES[acct.type].label}; type kept`);
          else type = it.type;
        }
        db.run('UPDATE accounts SET name=?, number=COALESCE(?, number), type=?, detail_type=COALESCE(?, detail_type), description=COALESCE(?, description), parent_id=?, is_active=1 WHERE id=?',
          name, it.number, type, it.detail, it.description, parentId, acct.id);
        out.updated.push(it.full);
      } else {
        const id = db.insert('INSERT INTO accounts (company_id, number, name, type, detail_type, description, parent_id) VALUES (?,?,?,?,?,?,?)', companyId, it.number, name, it.type, it.detail, it.description, parentId);
        acct = db.get('SELECT * FROM accounts WHERE id = ?', id);
        out.created.push(it.full);
      }
      touched.add(acct.id);
      byFull.set(it.full.toLowerCase(), db.get('SELECT * FROM accounts WHERE id = ?', acct.id));
    }
    if (body.remove_unused) {
      for (const a of all()) {
        if (touched.has(a.id) || a.system_key) continue;
        const used = db.get(`SELECT 1 FROM journal_lines WHERE account_id = ? UNION SELECT 1 FROM transaction_lines WHERE account_id = ? UNION SELECT 1 FROM items WHERE income_account_id = ? OR expense_account_id = ?
          UNION SELECT 1 FROM accounts WHERE parent_id = ? UNION SELECT 1 FROM vendors WHERE default_account_id = ? UNION SELECT 1 FROM bank_rules WHERE account_id = ? OR bank_account_id = ?
          UNION SELECT 1 FROM bank_feed WHERE account_id = ? OR suggested_account_id = ? UNION SELECT 1 FROM transactions WHERE account_id = ? OR to_account_id = ? LIMIT 1`, ...Array(12).fill(a.id));
        if (used) continue;
        db.run('DELETE FROM accounts WHERE id = ?', a.id);
        out.removed.push(a.name);
      }
    }
    log(db, companyId, userId, 'accounts', body, `${out.created.length} created, ${out.updated.length} updated, ${out.removed.length} removed`, [], body.dryRun);
    return out;
  });
}

// --- Customers & vendors ---------------------------------------------------------
const PARTY_HEAD = {
  customers: { name: ['customer', 'name', 'display name', 'customer name', 'customer full name'] },
  vendors: { name: ['vendor', 'name', 'display name', 'vendor name', 'vendor full name'] },
};
const COMMON_HEAD = {
  company: ['company name', 'company'], email: ['email', 'e-mail', 'email address', 'main email'],
  phone: ['phone', 'phone numbers', 'phone number', 'main phone', 'mobile', 'work phone'],
  contact: ['full name', 'contact', 'contact name', 'primary contact'],
  address: ['billing address', 'address', 'bill address', 'full address'],
  street: ['street address', 'street', 'billing street', 'address line 1', 'billing address line 1'],
  city: ['city', 'billing city'], state: ['state', 'billing state', 'state/province'], zip: ['zip', 'zip code', 'postal code', 'billing zip', 'billing zip code'],
  country: ['country', 'billing country'], notes: ['notes', 'note'], terms: ['terms', 'payment terms'],
  tax_id: ['tax id', 'tax id #', 'taxpayer id', 'ein', 'ssn', 'business id no.', 'tin'],
  is_1099: ['1099 tracking', 'track payments for 1099', '1099', 'eligible for 1099', '1099 vendor'],
};
const parseTerms = (t) => { if (!t) return null; if (/receipt/i.test(t)) return 0; const m = t.match(/(\d+)/); return m ? Math.min(365, Number(m[1])) : null; };
const yes = (v) => /^(yes|y|true|x|1|checked)$/i.test(String(v ?? '').trim());

export function importParties(db, companyId, table, body, userId) {
  const label = table === 'customers' ? 'Customer' : 'Vendor';
  const rows = rowsOf(body.file, `${label} list`);
  const h = findHeader(rows, { ...PARTY_HEAD[table], ...COMMON_HEAD }, ['name']);
  if (!h) throw bad(`Couldn’t find a "${label}" or "Name" column. Export the ${label.toLowerCase()} list from QuickBooks.`);
  const c = h.cols;
  return run(db, body, () => {
    const out = { created: [], updated: [], warnings: [] };
    for (const r of rows.slice(h.index + 1)) {
      const name = str(cell(r, c.name), 120);
      if (isSkippable(name)) continue;
      const address = cell(r, c.address) || [cell(r, c.street), [cell(r, c.city), [cell(r, c.state), cell(r, c.zip)].filter(Boolean).join(' ')].filter(Boolean).join(', '), cell(r, c.country)].filter(Boolean).join('\n');
      const vals = {
        company_name: cell(r, c.company) || null, email: (cell(r, c.email).split(/[,;\s]+/)[0] || null),
        phone: cell(r, c.phone).replace(/^Phone:\s*/i, '').split(/\s{2,}|;|\n/)[0] || null,
        contact_name: cell(r, c.contact) || null, notes: cell(r, c.notes) || null, terms_days: parseTerms(cell(r, c.terms)),
        address: address || null,
      };
      const existing = db.get(`SELECT * FROM ${table} WHERE company_id = ? AND display_name = ? COLLATE NOCASE`, companyId, name);
      const addrCol = table === 'customers' ? 'billing_address' : 'address';
      const extra = table === 'vendors' ? { tax_id: cell(r, c.tax_id) || null, is_1099: c.is_1099 >= 0 ? (yes(cell(r, c.is_1099)) ? 1 : 0) : null } : {};
      if (existing) {
        db.run(`UPDATE ${table} SET company_name=COALESCE(?,company_name), email=COALESCE(?,email), phone=COALESCE(?,phone), contact_name=COALESCE(?,contact_name),
          notes=COALESCE(?,notes), terms_days=COALESCE(?,terms_days), ${addrCol}=COALESCE(?,${addrCol}) ${table === 'vendors' ? ', tax_id=COALESCE(?,tax_id), is_1099=COALESCE(?,is_1099)' : ''} WHERE id=?`,
        vals.company_name, vals.email, vals.phone, vals.contact_name, vals.notes, vals.terms_days, vals.address, ...(table === 'vendors' ? [extra.tax_id, extra.is_1099] : []), existing.id);
        out.updated.push(name);
      } else {
        db.insert(`INSERT INTO ${table} (company_id, display_name, company_name, email, phone, contact_name, notes, terms_days, ${addrCol}${table === 'vendors' ? ', tax_id, is_1099' : ''})
          VALUES (?,?,?,?,?,?,?,?,?${table === 'vendors' ? ',?,?' : ''})`, companyId, name, vals.company_name, vals.email, vals.phone, vals.contact_name, vals.notes, vals.terms_days, vals.address,
        ...(table === 'vendors' ? [extra.tax_id, extra.is_1099 ?? 0] : []));
        out.created.push(name);
      }
    }
    if (!out.created.length && !out.updated.length) throw bad(`No ${table} found in that file`);
    log(db, companyId, userId, table, body, `${out.created.length} created, ${out.updated.length} updated`, [], body.dryRun);
    return out;
  });
}

// --- Opening balances ------------------------------------------------------------

function matchAccount(accounts, raw) {
  const name = raw.trim();
  const lower = name.toLowerCase();
  const leaf = name.split(':').at(-1).trim();
  const { number, name: bare } = splitNumber(leaf);
  return accounts.find((a) => a.name.toLowerCase() === lower)
    ?? accounts.find((a) => a.name.toLowerCase() === leaf.toLowerCase())
    ?? (number ? accounts.find((a) => a.number === number) : null)
    ?? accounts.find((a) => a.name.toLowerCase() === bare.toLowerCase())
    ?? accounts.find((a) => `${a.number ?? ''} ${a.name}`.trim().toLowerCase() === leaf.toLowerCase())
    ?? null;
}

function parseAging(rows, side) {
  const h = findHeader(rows, {
    date: ['date', 'transaction date', 'txn date'], type: ['transaction type', 'type', 'txn type'], num: ['num', 'no.', 'number', 'ref no.', 'invoice no.', 'bill no.'],
    name: side === 'ar' ? ['customer', 'name', 'customer full name', 'customer name'] : ['vendor', 'name', 'vendor full name', 'vendor name', 'supplier'],
    due: ['due date', 'due'], open: ['open balance', 'open bal', 'balance', 'amount due', 'open amount'], amount: ['amount', 'total'],
  }, ['date', 'name']);
  if (!h) throw bad(`Couldn’t find Date and ${side === 'ar' ? 'Customer' : 'Vendor'} columns in the ${side === 'ar' ? 'A/R' : 'A/P'} Aging Detail`);
  if (h.cols.open < 0 && h.cols.amount < 0) throw bad(`Couldn’t find an "Open Balance" column in the ${side === 'ar' ? 'A/R' : 'A/P'} Aging Detail`);
  const out = [];
  for (const r of rows.slice(h.index + 1)) {
    const date = toIsoDate(cell(r, h.cols.date));
    const name = cell(r, h.cols.name);
    if (!date || !name) continue; // section headings, totals
    const open = money(cell(r, h.cols.open >= 0 ? h.cols.open : h.cols.amount));
    if (!open) continue;
    out.push({ date, type: cell(r, h.cols.type), num: cell(r, h.cols.num) || null, name, due: toIsoDate(cell(r, h.cols.due)) ?? date, open });
  }
  return out;
}

function ensureParty(db, companyId, table, name, created) {
  const row = db.get(`SELECT id FROM ${table} WHERE company_id = ? AND display_name = ? COLLATE NOCASE`, companyId, name);
  if (row) return row.id;
  created.push(name);
  return db.insert(`INSERT INTO ${table} (company_id, display_name) VALUES (?, ?)`, companyId, name);
}

export function importOpening(db, companyId, body, userId) {
  const date = requireDate(body.date, 'cutover date');
  const prior = db.get("SELECT * FROM imports WHERE company_id = ? AND kind = 'opening' AND status = 'done'", companyId);
  if (prior) throw bad(`Opening balances were already imported on ${prior.at.slice(0, 10)}. Undo that import first.`);
  const tbRows = rowsOf(body.trial_balance, 'Trial Balance');
  const h = findHeader(tbRows, { debit: ['debit', 'debits'], credit: ['credit', 'credits'], account: ['account', 'account name', ''] }, ['debit', 'credit']);
  if (!h) throw bad('Couldn’t find Debit and Credit columns. Export Reports › Trial Balance from QuickBooks.');
  const acctCol = h.cols.account >= 0 && h.cols.account < Math.min(h.cols.debit, h.cols.credit) ? h.cols.account : 0;
  const ar = body.ar_aging ? parseAging(rowsOf(body.ar_aging, 'A/R Aging Detail'), 'ar') : null;
  const ap = body.ap_aging ? parseAging(rowsOf(body.ap_aging, 'A/P Aging Detail'), 'ap') : null;

  return run(db, body, () => {
    const out = { lines: [], unmatched: [], invoices: 0, bills: 0, credits: 0, created_customers: [], created_vendors: [], warnings: [], txn_ids: [] };
    const accounts = db.all('SELECT * FROM accounts WHERE company_id = ?', companyId);
    let tbDr = 0, tbCr = 0;
    for (const r of tbRows.slice(h.index + 1)) {
      const name = cell(r, acctCol);
      if (isSkippable(name)) continue;
      const d = money(r[h.cols.debit]), c = money(r[h.cols.credit]);
      if (d === null || c === null) { out.warnings.push(`Skipped "${name}": amount isn't a number`); continue; }
      if (!d && !c) continue;
      tbDr += d; tbCr += c;
      const acct = matchAccount(accounts, name);
      if (!acct) { out.unmatched.push({ name, debit: d, credit: c }); continue; }
      out.lines.push({ name, account_id: acct.id, account: `${acct.number ? acct.number + ' ' : ''}${acct.name}`, type: acct.type, debit: d, credit: c });
    }
    out.tb_debits = tbDr; out.tb_credits = tbCr;
    if (!out.lines.length && !out.unmatched.length) throw bad('No balances found in the trial balance');
    if (tbDr !== tbCr) out.warnings.push(`The trial balance doesn't balance: debits ${fmtMoney(tbDr)} vs credits ${fmtMoney(tbCr)}. The difference goes to Opening Balance Equity.`);
    if (out.unmatched.length) {
      if (!body.dryRun) throw bad(`${out.unmatched.length} trial balance account(s) don't match this chart of accounts: ${out.unmatched.map((u) => u.name).join(', ')}. Import the chart of accounts first.`);
      return out; // preview shows what needs fixing
    }

    const obe = systemAccount(db, companyId, 'OPENING_EQUITY');
    const sideTotal = (type) => out.lines.filter((l) => l.type === type).reduce((s, l) => s + (type === 'accounts_receivable' ? l.debit - l.credit : l.credit - l.debit), 0);
    const arTb = sideTotal('accounts_receivable'), apTb = sideTotal('accounts_payable');
    // A/R and A/P are rebuilt as open invoices/bills so customer balances and aging work.
    // Without the aging detail, one opening document per side goes to a placeholder name.
    const arDocs = ar ?? (arTb ? [{ date, type: 'Opening balance', num: null, name: 'Opening A/R (no detail imported)', due: date, open: arTb }] : []);
    const apDocs = ap ?? (apTb ? [{ date, type: 'Opening balance', num: null, name: 'Opening A/P (no detail imported)', due: date, open: apTb }] : []);
    if (!ar && arTb) out.warnings.push('No A/R Aging Detail was provided, so opening A/R is one invoice to "Opening A/R (no detail imported)". Import the aging detail to keep balances by customer.');
    if (!ap && apTb) out.warnings.push('No A/P Aging Detail was provided, so opening A/P is one bill to "Opening A/P (no detail imported)". Import the aging detail to keep balances by vendor.');
    const jeLines = [];
    for (const l of out.lines) {
      if (l.type === 'accounts_receivable' || l.type === 'accounts_payable') continue;
      jeLines.push({ account_id: l.account_id, debit: l.debit / 100 || '', credit: l.credit / 100 || '', description: 'Opening balance from QuickBooks' });
    }
    const dr = jeLines.reduce((s, l) => s + toCents(l.debit || 0), 0), cr = jeLines.reduce((s, l) => s + toCents(l.credit || 0), 0);
    if (dr !== cr) jeLines.push({ account_id: obe.id, ...(dr > cr ? { credit: (dr - cr) / 100 } : { debit: (cr - dr) / 100 }), description: 'Balancing entry for A/R and A/P detail (offset by opening invoices and bills)' });
    if (jeLines.length >= 2) {
      const je = createTransaction(db, companyId, { type: 'journal_entry', date, number: 'QBO-OPEN', memo: `Opening balances imported from QuickBooks as of ${date}`, lines: jeLines }, userId);
      out.txn_ids.push(je.id);
    }

    const usedNums = new Set();
    const docs = (list, side) => {
      let total = 0;
      for (const d of list) {
        if (d.date > date) { out.warnings.push(`${d.type || 'Item'} ${d.num ?? ''} for ${d.name} is dated after the cutover date; skipped`); continue; }
        const isAr = side === 'ar';
        const partyId = ensureParty(db, companyId, isAr ? 'customers' : 'vendors', d.name, isAr ? out.created_customers : out.created_vendors);
        const credit = d.open < 0;
        const type = isAr ? (credit ? 'credit_memo' : 'invoice') : (credit ? 'vendor_credit' : 'bill');
        let num = d.num;
        if (num && (usedNums.has(`${type}:${num}`) || (isAr && db.get('SELECT 1 FROM transactions WHERE company_id = ? AND type = ? AND number = ?', companyId, type, num)))) num = `${num}-QBO`;
        if (num) usedNums.add(`${type}:${num}`);
        const amt = Math.abs(d.open) / 100;
        const desc = `Open balance from QuickBooks${d.type ? ` (${d.type}${d.num ? ' ' + d.num : ''})` : ''}`;
        const t = createTransaction(db, companyId, isAr
          ? { type, date: d.date, ...(type === 'invoice' ? { due_date: d.due >= d.date ? d.due : d.date } : {}), number: num, customer_id: partyId, memo: desc, lines: [{ account_id: obe.id, description: desc, qty: 1, rate: amt }] }
          : { type, date: d.date, ...(type === 'bill' ? { due_date: d.due >= d.date ? d.due : d.date } : {}), number: num, vendor_id: partyId, memo: desc, lines: [{ account_id: obe.id, description: desc, amount: amt }] }, userId);
        out.txn_ids.push(t.id);
        if (credit) out.credits++; else if (isAr) out.invoices++; else out.bills++;
        total += d.open;
      }
      return total;
    };
    { const t = docs(arDocs, 'ar'); out.ar_detail_total = t; if (ar && t !== arTb) out.warnings.push(`Open A/R detail totals ${fmtMoney(t)} but the trial balance shows ${fmtMoney(arTb)} in A/R. The ${fmtMoney(arTb - t)} difference sits in Opening Balance Equity — check the report dates match.`); }
    { const t = docs(apDocs, 'ap'); out.ap_detail_total = t; if (ap && t !== apTb) out.warnings.push(`Open A/P detail totals ${fmtMoney(t)} but the trial balance shows ${fmtMoney(apTb)} in A/P. The ${fmtMoney(apTb - t)} difference sits in Opening Balance Equity — check the report dates match.`); }
    out.import_id = log(db, companyId, userId, 'opening', body, `Opening balances as of ${date}: ${out.lines.length} accounts, ${out.invoices} invoices, ${out.bills} bills, ${out.credits} credits`, out.txn_ids, body.dryRun);
    return out;
  });
}

// --- Log & undo ---------------------------------------------------------------------

function log(db, companyId, userId, kind, body, summary, txnIds, dryRun) {
  if (dryRun) return null;
  const files = ['file', 'trial_balance', 'ar_aging', 'ap_aging'].map((k) => body[k]?.file_name).filter(Boolean).join(', ');
  const id = db.insert('INSERT INTO imports (company_id, kind, file_name, summary, txn_ids, user_id) VALUES (?,?,?,?,?,?)', companyId, kind, str(files, 500), summary, JSON.stringify(txnIds), userId);
  audit(db, { companyId, userId, action: 'import', entity: `qbo_${kind}`, entityId: id, summary });
  return id;
}

export function listImports(db, companyId) {
  return db.all('SELECT i.*, u.name AS user_name FROM imports i LEFT JOIN users u ON u.id = i.user_id WHERE i.company_id = ? ORDER BY i.id DESC', companyId)
    .map((r) => ({ ...r, txn_ids: JSON.parse(r.txn_ids), can_undo: r.kind === 'opening' && r.status === 'done' }));
}

export function undoImport(db, companyId, id, userId) {
  return db.tx(() => {
    const imp = db.get('SELECT * FROM imports WHERE id = ? AND company_id = ?', id, companyId);
    if (!imp) throw bad('Import not found');
    if (imp.kind !== 'opening' || imp.status !== 'done') throw bad('Only an opening-balance import can be undone');
    const ids = JSON.parse(imp.txn_ids);
    // Bills/invoices first (they may have payments applied → deleteTransaction will refuse with a clear message).
    for (const tid of [...ids].reverse()) if (db.get('SELECT 1 FROM transactions WHERE id = ?', tid)) deleteTransaction(db, companyId, tid, userId);
    db.run("UPDATE imports SET status = 'undone' WHERE id = ?", id);
    audit(db, { companyId, userId, action: 'undo', entity: 'qbo_opening', entityId: id, summary: `Opening balance import undone (${ids.length} transactions removed)` });
    return { ok: true, removed: ids.length };
  });
}
