import { bad, notFound, str, intOrNull, toCents, today } from '../util.js';
import { getAccount, seedChartOfAccounts, systemAccount } from './accounts.js';
import { audit } from './audit.js';
import { listTransactions } from './transactions.js';

const flag = (v, dflt = 0) => (v === undefined ? dflt : v ? 1 : 0);
const termsOrNull = (v) => {
  const n = intOrNull(v);
  if (n !== null && (n < 0 || n > 365)) throw bad('Terms must be between 0 and 365 days');
  return n;
};

// --- Companies --------------------------------------------------------------

export function listCompanies(db) {
  return db.all('SELECT * FROM companies ORDER BY name');
}

export function getCompany(db, id) {
  const c = db.get('SELECT * FROM companies WHERE id = ?', id);
  if (!c) throw notFound('Company');
  return c;
}

export function createCompany(db, body, userId) {
  const name = str(body.name, 120);
  if (!name) throw bad('Company name is required');
  return db.tx(() => {
    const id = db.insert('INSERT INTO companies (name, legal_name, ein, email, phone, address, fiscal_year_start_month) VALUES (?,?,?,?,?,?,?)',
      name, str(body.legal_name), str(body.ein, 20), str(body.email), str(body.phone, 40), str(body.address, 1000), Number(body.fiscal_year_start_month) || 1);
    seedChartOfAccounts(db, id);
    audit(db, { companyId: id, userId, action: 'create', entity: 'company', entityId: id, summary: name });
    return getCompany(db, id);
  });
}

export function updateCompany(db, id, body, userId) {
  const c = getCompany(db, id);
  const name = str(body.name ?? c.name, 120);
  if (!name) throw bad('Company name is required');
  const fy = Number(body.fiscal_year_start_month ?? c.fiscal_year_start_month);
  if (!(fy >= 1 && fy <= 12)) throw bad('Fiscal year start month must be 1-12');
  let closing = body.closing_date === undefined ? c.closing_date : str(body.closing_date);
  if (closing && !/^\d{4}-\d{2}-\d{2}$/.test(closing)) throw bad('Closing date must be YYYY-MM-DD');
  const terms = termsOrNull(body.default_terms_days ?? c.default_terms_days) ?? 30;
  db.run(`UPDATE companies SET name=?, legal_name=?, ein=?, email=?, phone=?, address=?, fiscal_year_start_month=?, closing_date=?, default_terms_days=?, invoice_footer=? WHERE id=?`,
    name, pick(body, c, 'legal_name'), pick(body, c, 'ein'), pick(body, c, 'email'), pick(body, c, 'phone'), pick(body, c, 'address'), fy, closing, terms, pick(body, c, 'invoice_footer'), id);
  if (closing !== c.closing_date) audit(db, { companyId: id, userId, action: 'update', entity: 'closing_date', summary: `Closing date ${c.closing_date ?? 'none'} → ${closing ?? 'none'}` });
  else audit(db, { companyId: id, userId, action: 'update', entity: 'company', entityId: id, summary: 'Company settings updated' });
  return getCompany(db, id);
}
const pick = (body, row, k) => (body[k] === undefined ? row[k] : str(body[k], 2000));

// --- Customers / vendors ----------------------------------------------------

const PARTY = {
  customers: { fk: 'customer_id', label: 'Customer', fields: ['company_name', 'contact_name', 'email', 'phone', 'billing_address', 'notes'] },
  vendors:   { fk: 'vendor_id',   label: 'Vendor',   fields: ['company_name', 'contact_name', 'email', 'phone', 'address', 'tax_id', 'notes'] },
};

export function listParties(db, companyId, table, { includeInactive } = {}) {
  const { fk } = PARTY[table];
  const ctl = table === 'customers' ? 'AR' : 'AP';
  const acct = systemAccount(db, companyId, ctl);
  const rows = db.all(`SELECT p.*,
      COALESCE((SELECT SUM(${table === 'customers' ? 'j.debit - j.credit' : 'j.credit - j.debit'}) FROM journal_lines j WHERE j.account_id = ? AND j.${fk} = p.id), 0) AS balance,
      COALESCE((SELECT SUM(t.total - (SELECT COALESCE(SUM(x.amount),0) FROM applications x WHERE x.target_txn_id = t.id))
         FROM transactions t WHERE t.${fk} = p.id AND t.type = ? AND t.status='posted' AND t.due_date < ?), 0) AS overdue
    FROM ${table} p WHERE p.company_id = ? ${includeInactive ? '' : 'AND p.is_active = 1'} ORDER BY p.display_name COLLATE NOCASE`,
    acct.id, table === 'customers' ? 'invoice' : 'bill', today(), companyId);
  return rows;
}

export function getParty(db, companyId, table, id) {
  const p = db.get(`SELECT * FROM ${table} WHERE id = ? AND company_id = ?`, id, companyId);
  if (!p) throw notFound(PARTY[table].label);
  const withBal = listParties(db, companyId, table, { includeInactive: true }).find((r) => r.id === p.id);
  return { ...withBal, transactions: listTransactions(db, companyId, { [PARTY[table].fk]: id, limit: 1000 }) };
}

export function saveParty(db, companyId, table, body, id = null, userId = null) {
  const { label, fields } = PARTY[table];
  const existing = id ? db.get(`SELECT * FROM ${table} WHERE id = ? AND company_id = ?`, id, companyId) : null;
  if (id && !existing) throw notFound(label);
  const display = str(body.display_name ?? existing?.display_name, 120);
  if (!display) throw bad('Display name is required');
  const dup = db.get(`SELECT id FROM ${table} WHERE company_id = ? AND display_name = ? AND id != ?`, companyId, display, id ?? 0);
  if (dup) throw bad(`A ${label.toLowerCase()} named "${display}" already exists`);
  const vals = Object.fromEntries(fields.map((f) => [f, body[f] === undefined ? existing?.[f] ?? null : str(body[f], 2000)]));
  const terms = body.terms_days === undefined ? existing?.terms_days ?? null : termsOrNull(body.terms_days);
  const active = flag(body.is_active, existing?.is_active ?? 1);
  if (existing && !active && existing.is_active) {
    const bal = listParties(db, companyId, table, { includeInactive: true }).find((r) => r.id === id).balance;
    if (bal !== 0) throw bad(`This ${label.toLowerCase()} has an open balance and can't be made inactive`);
  }
  let extraCols = [], extraVals = [];
  if (table === 'customers') { extraCols = ['taxable']; extraVals = [flag(body.taxable, existing?.taxable ?? 1)]; }
  else {
    const def = body.default_account_id === undefined ? existing?.default_account_id ?? null : intOrNull(body.default_account_id);
    if (def) getAccount(db, companyId, def);
    extraCols = ['is_1099', 'default_account_id']; extraVals = [flag(body.is_1099, existing?.is_1099 ?? 0), def];
  }
  const cols = ['display_name', ...fields, 'terms_days', 'is_active', ...extraCols];
  const values = [display, ...fields.map((f) => vals[f]), terms, active, ...extraVals];
  if (existing) {
    db.run(`UPDATE ${table} SET ${cols.map((c) => `${c}=?`).join(', ')} WHERE id = ?`, ...values, id);
  } else {
    id = db.insert(`INSERT INTO ${table} (company_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`, companyId, ...values);
  }
  audit(db, { companyId, userId, action: existing ? 'update' : 'create', entity: table.slice(0, -1), entityId: id, summary: display });
  return db.get(`SELECT * FROM ${table} WHERE id = ?`, id);
}

// --- Products & services ----------------------------------------------------

export function listItems(db, companyId, { includeInactive } = {}) {
  return db.all(`SELECT i.*, ia.name AS income_account_name, ea.name AS expense_account_name FROM items i
    LEFT JOIN accounts ia ON ia.id = i.income_account_id LEFT JOIN accounts ea ON ea.id = i.expense_account_id
    WHERE i.company_id = ? ${includeInactive ? '' : 'AND i.is_active = 1'} ORDER BY i.name COLLATE NOCASE`, companyId);
}

export function saveItem(db, companyId, body, id = null, userId = null) {
  const existing = id ? db.get('SELECT * FROM items WHERE id = ? AND company_id = ?', id, companyId) : null;
  if (id && !existing) throw notFound('Product/service');
  const merged = { ...existing, ...body };
  const name = str(merged.name, 120);
  if (!name) throw bad('Name is required');
  if (db.get('SELECT 1 FROM items WHERE company_id = ? AND name = ? AND id != ?', companyId, name, id ?? 0)) throw bad(`"${name}" already exists`);
  const type = merged.type ?? 'service';
  if (!['service', 'non_inventory'].includes(type)) throw bad('Invalid item type');
  const inc = intOrNull(merged.income_account_id);
  const exp = intOrNull(merged.expense_account_id);
  if (!inc && !exp) throw bad('Choose an income account and/or an expense account');
  if (inc) getAccount(db, companyId, inc);
  if (exp) getAccount(db, companyId, exp);
  const price = body.sales_price === undefined ? existing?.sales_price ?? 0 : toCents(body.sales_price);
  const cost = body.cost === undefined ? existing?.cost ?? 0 : toCents(body.cost);
  const vals = [name, str(merged.sku, 60), type, str(merged.description, 1000), price, cost, inc, exp, flag(body.taxable, existing?.taxable ?? 0), flag(body.is_active, existing?.is_active ?? 1)];
  if (existing) db.run('UPDATE items SET name=?, sku=?, type=?, description=?, sales_price=?, cost=?, income_account_id=?, expense_account_id=?, taxable=?, is_active=? WHERE id=?', ...vals, id);
  else id = db.insert('INSERT INTO items (company_id, name, sku, type, description, sales_price, cost, income_account_id, expense_account_id, taxable, is_active) VALUES (?,?,?,?,?,?,?,?,?,?,?)', companyId, ...vals);
  audit(db, { companyId, userId, action: existing ? 'update' : 'create', entity: 'item', entityId: id, summary: name });
  return db.get('SELECT * FROM items WHERE id = ?', id);
}

// --- Sales tax rates --------------------------------------------------------

export function listTaxRates(db, companyId) {
  return db.all('SELECT * FROM tax_rates WHERE company_id = ? ORDER BY name', companyId);
}

export function saveTaxRate(db, companyId, body, id = null, userId = null) {
  const existing = id ? db.get('SELECT * FROM tax_rates WHERE id = ? AND company_id = ?', id, companyId) : null;
  if (id && !existing) throw notFound('Tax rate');
  const name = str(body.name ?? existing?.name, 80);
  const rate = Number(body.rate ?? existing?.rate);
  if (!name) throw bad('Name is required');
  if (!(rate >= 0 && rate < 100)) throw bad('Rate must be a percentage between 0 and 100');
  if (db.get('SELECT 1 FROM tax_rates WHERE company_id = ? AND name = ? AND id != ?', companyId, name, id ?? 0)) throw bad(`"${name}" already exists`);
  if (existing) db.run('UPDATE tax_rates SET name=?, rate=?, is_active=? WHERE id=?', name, rate, flag(body.is_active, existing.is_active), id);
  else id = db.insert('INSERT INTO tax_rates (company_id, name, rate) VALUES (?,?,?)', companyId, name, rate);
  audit(db, { companyId, userId, action: existing ? 'update' : 'create', entity: 'tax_rate', entityId: id, summary: `${name} ${rate}%` });
  return db.get('SELECT * FROM tax_rates WHERE id = ?', id);
}
