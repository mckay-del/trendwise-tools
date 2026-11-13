import { bad, notFound, str, intOrNull } from '../util.js';

/** Account types, QBO-style. `cls` drives normal balance and statement placement. */
export const ACCOUNT_TYPES = {
  bank:                    { label: 'Bank',                     cls: 'asset',     order: 1 },
  accounts_receivable:     { label: 'Accounts Receivable (A/R)', cls: 'asset',    order: 2 },
  other_current_asset:     { label: 'Other Current Assets',     cls: 'asset',     order: 3 },
  fixed_asset:             { label: 'Fixed Assets',             cls: 'asset',     order: 4 },
  other_asset:             { label: 'Other Assets',             cls: 'asset',     order: 5 },
  accounts_payable:        { label: 'Accounts Payable (A/P)',   cls: 'liability', order: 6 },
  credit_card:             { label: 'Credit Card',              cls: 'liability', order: 7 },
  other_current_liability: { label: 'Other Current Liabilities', cls: 'liability', order: 8 },
  long_term_liability:     { label: 'Long Term Liabilities',    cls: 'liability', order: 9 },
  equity:                  { label: 'Equity',                   cls: 'equity',    order: 10 },
  income:                  { label: 'Income',                   cls: 'income',    order: 11 },
  cost_of_goods_sold:      { label: 'Cost of Goods Sold',       cls: 'expense',   order: 12 },
  expense:                 { label: 'Expenses',                 cls: 'expense',   order: 13 },
  other_income:            { label: 'Other Income',             cls: 'income',    order: 14 },
  other_expense:           { label: 'Other Expense',            cls: 'expense',   order: 15 },
};

export const isDebitNormal = (type) => ['asset', 'expense'].includes(ACCOUNT_TYPES[type]?.cls);
export const isPnl = (type) => ['income', 'expense'].includes(ACCOUNT_TYPES[type]?.cls);
export const isMoneyAccount = (type) => type === 'bank' || type === 'credit_card' || type === 'other_current_asset';
/** Signed balance from debit/credit totals according to the account's normal side. */
export const signed = (type, debit, credit) => (isDebitNormal(type) ? debit - credit : credit - debit);

/** Default chart of accounts for a US service business. */
const DEFAULT_COA = [
  ['1000', 'Business Checking', 'bank'],
  ['1010', 'Business Savings', 'bank'],
  ['1100', 'Accounts Receivable', 'accounts_receivable', 'AR'],
  ['1200', 'Undeposited Funds', 'other_current_asset', 'UNDEPOSITED'],
  ['1300', 'Prepaid Expenses', 'other_current_asset'],
  ['1500', 'Furniture & Equipment', 'fixed_asset'],
  ['1510', 'Vehicles', 'fixed_asset'],
  ['1590', 'Accumulated Depreciation', 'fixed_asset'],
  ['2000', 'Accounts Payable', 'accounts_payable', 'AP'],
  ['2100', 'Business Credit Card', 'credit_card'],
  ['2200', 'Sales Tax Payable', 'other_current_liability', 'SALES_TAX'],
  ['2300', 'Payroll Liabilities', 'other_current_liability'],
  ['2700', 'Notes Payable', 'long_term_liability'],
  ['3000', 'Opening Balance Equity', 'equity', 'OPENING_EQUITY'],
  ['3100', "Owner's Investment", 'equity'],
  ['3200', "Owner's Draw", 'equity'],
  ['3900', 'Retained Earnings', 'equity', 'RETAINED_EARNINGS'],
  ['4000', 'Services Revenue', 'income'],
  ['4100', 'Product Sales', 'income'],
  ['4900', 'Discounts Given', 'income'],
  ['5000', 'Cost of Goods Sold', 'cost_of_goods_sold'],
  ['5100', 'Subcontractors', 'cost_of_goods_sold'],
  ['6000', 'Advertising & Marketing', 'expense'],
  ['6050', 'Bank Charges & Fees', 'expense'],
  ['6100', 'Car & Truck', 'expense'],
  ['6150', 'Contract Labor', 'expense'],
  ['6200', 'Dues & Subscriptions', 'expense'],
  ['6250', 'Insurance', 'expense'],
  ['6300', 'Interest Paid', 'expense'],
  ['6350', 'Legal & Professional Services', 'expense'],
  ['6400', 'Meals', 'expense'],
  ['6450', 'Office Supplies & Software', 'expense'],
  ['6500', 'Payroll Expenses', 'expense'],
  ['6550', 'Rent & Lease', 'expense'],
  ['6600', 'Repairs & Maintenance', 'expense'],
  ['6650', 'Taxes & Licenses', 'expense'],
  ['6700', 'Travel', 'expense'],
  ['6750', 'Utilities', 'expense'],
  ['6800', 'Depreciation Expense', 'expense'],
  ['6999', 'Uncategorized Expense', 'expense', 'UNCATEGORIZED_EXPENSE'],
  ['7000', 'Interest Earned', 'other_income'],
  ['7900', 'Uncategorized Income', 'income', 'UNCATEGORIZED_INCOME'],
  ['8000', 'Other Miscellaneous Expense', 'other_expense'],
];

export function seedChartOfAccounts(db, companyId) {
  for (const [number, name, type, key] of DEFAULT_COA) {
    db.insert('INSERT INTO accounts (company_id, number, name, type, system_key) VALUES (?,?,?,?,?)',
      companyId, number, name, type, key ?? null);
  }
}

/** Get (or lazily create) a system account such as AR or AP. */
export function systemAccount(db, companyId, key) {
  const row = db.get('SELECT * FROM accounts WHERE company_id = ? AND system_key = ?', companyId, key);
  if (row) return row;
  const defaults = DEFAULT_COA.find((r) => r[3] === key);
  if (!defaults) throw new Error(`Unknown system account ${key}`);
  let name = defaults[1];
  if (db.get('SELECT 1 FROM accounts WHERE company_id = ? AND name = ?', companyId, name)) name += ' (System)';
  const id = db.insert('INSERT INTO accounts (company_id, number, name, type, system_key) VALUES (?,?,?,?,?)',
    companyId, defaults[0], name, defaults[2], key);
  return db.get('SELECT * FROM accounts WHERE id = ?', id);
}

export function getAccount(db, companyId, id) {
  const a = db.get('SELECT * FROM accounts WHERE id = ? AND company_id = ?', id, companyId);
  if (!a) throw notFound('Account');
  return a;
}

export function listAccounts(db, companyId, { includeInactive = false, asOf = null } = {}) {
  const rows = db.all(`
    SELECT a.*, COALESCE(SUM(j.debit),0) AS debits, COALESCE(SUM(j.credit),0) AS credits
    FROM accounts a
    LEFT JOIN journal_lines j ON j.account_id = a.id ${asOf ? 'AND j.date <= ?' : ''}
    WHERE a.company_id = ? ${includeInactive ? '' : 'AND a.is_active = 1'}
    GROUP BY a.id`, ...(asOf ? [asOf, companyId] : [companyId]));
  return rows
    .map((a) => ({ ...a, balance: signed(a.type, a.debits, a.credits), type_label: ACCOUNT_TYPES[a.type]?.label, cls: ACCOUNT_TYPES[a.type]?.cls }))
    .sort((x, y) => (ACCOUNT_TYPES[x.type].order - ACCOUNT_TYPES[y.type].order) || String(x.number ?? '').localeCompare(String(y.number ?? '')) || x.name.localeCompare(y.name));
}

function validateAccount(db, companyId, body, existing) {
  const name = str(body.name, 120);
  if (!name) throw bad('Account name is required');
  const type = body.type ?? existing?.type;
  if (!ACCOUNT_TYPES[type]) throw bad('Invalid account type');
  if (existing?.system_key && type !== existing.type) throw bad('The type of a system account cannot be changed');
  if (existing && type !== existing.type) {
    const used = db.get('SELECT 1 FROM journal_lines WHERE account_id = ? LIMIT 1', existing.id);
    if (used && ACCOUNT_TYPES[type].cls !== ACCOUNT_TYPES[existing.type].cls) throw bad('Cannot move an account with activity to a different class (e.g. asset → expense)');
    if (used && ['accounts_receivable', 'accounts_payable'].some((t) => t === type || t === existing.type)) throw bad('Cannot change A/R or A/P type on an account with activity');
  }
  const parentId = intOrNull(body.parent_id);
  if (parentId) {
    const p = getAccount(db, companyId, parentId);
    if (p.type !== type) throw bad('A sub-account must have the same type as its parent');
    if (existing && p.id === existing.id) throw bad('An account cannot be its own parent');
  }
  const dup = db.get('SELECT id FROM accounts WHERE company_id = ? AND name = ? AND id != ?', companyId, name, existing?.id ?? 0);
  if (dup) throw bad(`An account named "${name}" already exists`);
  return { name, type, number: str(body.number, 20), detail_type: str(body.detail_type, 80), description: str(body.description), parent_id: parentId };
}

export function createAccount(db, companyId, body) {
  const v = validateAccount(db, companyId, body);
  const id = db.insert('INSERT INTO accounts (company_id, number, name, type, detail_type, parent_id, description) VALUES (?,?,?,?,?,?,?)',
    companyId, v.number, v.name, v.type, v.detail_type, v.parent_id, v.description);
  return getAccount(db, companyId, id);
}

export function updateAccount(db, companyId, id, body) {
  const existing = getAccount(db, companyId, id);
  const v = validateAccount(db, companyId, { ...existing, ...body }, existing);
  let isActive = body.is_active === undefined ? existing.is_active : (body.is_active ? 1 : 0);
  if (!isActive && existing.system_key) throw bad('System accounts cannot be made inactive');
  if (!isActive) {
    const bal = db.get('SELECT COALESCE(SUM(debit - credit),0) AS b FROM journal_lines WHERE account_id = ?', id).b;
    if (bal !== 0) throw bad('Account has a balance. Move the balance before making it inactive.');
  }
  db.run('UPDATE accounts SET number=?, name=?, type=?, detail_type=?, parent_id=?, description=?, is_active=? WHERE id=?',
    v.number, v.name, v.type, v.detail_type, v.parent_id, v.description, isActive, id);
  return getAccount(db, companyId, id);
}
