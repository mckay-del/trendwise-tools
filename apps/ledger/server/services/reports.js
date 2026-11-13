import { bad, isDate, today, addDays, daysBetween } from '../util.js';
import { ACCOUNT_TYPES, isPnl, signed, systemAccount } from './accounts.js';
import { TXN_TYPES } from './transactions.js';

/**
 * Every report returns: { title, subtitle, columns: [{label, type}], rows: [{cells, kind, depth, txn_id?, account_id?}] }
 * kind: 'section' | 'row' | 'subtotal' | 'total' | 'grand'. Money cells are integer cents.
 */

export const REPORTS = {
  profit_and_loss:    { title: 'Profit and Loss', group: 'Business overview', params: ['range', 'basis', 'columns'] },
  balance_sheet:      { title: 'Balance Sheet', group: 'Business overview', params: ['asof'] },
  cash_flow:          { title: 'Statement of Cash Flows', group: 'Business overview', params: ['range'] },
  ar_aging:           { title: 'A/R Aging Summary', group: 'Who owes you', params: ['asof'] },
  ar_aging_detail:    { title: 'A/R Aging Detail', group: 'Who owes you', params: ['asof'] },
  sales_by_customer:  { title: 'Sales by Customer Summary', group: 'Sales and customers', params: ['range'] },
  sales_by_item:      { title: 'Sales by Product/Service Summary', group: 'Sales and customers', params: ['range'] },
  sales_tax:          { title: 'Sales Tax Liability', group: 'Sales and customers', params: ['range'] },
  ap_aging:           { title: 'A/P Aging Summary', group: 'What you owe', params: ['asof'] },
  ap_aging_detail:    { title: 'A/P Aging Detail', group: 'What you owe', params: ['asof'] },
  expenses_by_vendor: { title: 'Expenses by Vendor Summary', group: 'Expenses and vendors', params: ['range'] },
  vendor_1099:        { title: '1099 Contractor Summary', group: 'Expenses and vendors', params: ['year'] },
  trial_balance:      { title: 'Trial Balance', group: 'For my accountant', params: ['asof'] },
  general_ledger:     { title: 'General Ledger', group: 'For my accountant', params: ['range', 'account'] },
  journal:            { title: 'Journal', group: 'For my accountant', params: ['range'] },
  transaction_list:   { title: 'Transaction List by Date', group: 'For my accountant', params: ['range'] },
  account_list:       { title: 'Account List', group: 'For my accountant', params: [] },
};

const money = (label) => ({ label, type: 'money' });
const text = (label) => ({ label, type: 'text' });
const date = (label) => ({ label, type: 'date' });

export function fiscalYearStart(company, iso) {
  const m = company.fiscal_year_start_month;
  const [y, mo] = iso.split('-').map(Number);
  const year = mo >= m ? y : y - 1;
  return `${year}-${String(m).padStart(2, '0')}-01`;
}

function accountsById(db, companyId) {
  const rows = db.all('SELECT * FROM accounts WHERE company_id = ?', companyId);
  const map = new Map(rows.map((a) => [a.id, a]));
  for (const a of rows) { let d = 0, p = a.parent_id; while (p && map.has(p) && d < 6) { d++; p = map.get(p).parent_id; } a.depth = d; }
  return map;
}

function sortAccounts(list, byId) {
  // Order parents before children (path ordering), then by number/name.
  const key = (a) => { const path = []; let cur = a; while (cur) { path.unshift(`${String(cur.number ?? '').padStart(8, '~')}|${cur.name}`); cur = cur.parent_id ? byId.get(cur.parent_id) : null; } return path.join('/'); };
  return [...list].sort((x, y) => (ACCOUNT_TYPES[x.type].order - ACCOUNT_TYPES[y.type].order) || key(x).localeCompare(key(y)));
}

/** Net debit by account for journal lines in [from, to]. */
function netByAccount(db, companyId, from, to) {
  const rows = db.all(`SELECT account_id, SUM(debit) AS d, SUM(credit) AS c FROM journal_lines WHERE company_id = ? AND date >= ? AND date <= ? GROUP BY account_id`, companyId, from ?? '0000-01-01', to ?? '9999-12-31');
  return new Map(rows.map((r) => [r.account_id, r.d - r.c]));
}

/** Net debit by P&L account on a cash basis: payments recognize the paid share of invoices/bills. */
function cashBasisPnl(db, companyId, from, to, byId) {
  const out = new Map();
  const add = (id, v) => out.set(id, (out.get(id) ?? 0) + v);
  const direct = db.all(`SELECT j.account_id, j.debit - j.credit AS net FROM journal_lines j JOIN transactions t ON t.id = j.transaction_id
    WHERE j.company_id = ? AND j.date >= ? AND j.date <= ? AND t.type NOT IN ('invoice','credit_memo','bill','vendor_credit')`, companyId, from, to);
  for (const r of direct) if (isPnl(byId.get(r.account_id).type)) add(r.account_id, r.net);
  const apps = db.all(`SELECT x.amount, x.target_txn_id, tg.total FROM applications x
    JOIN transactions s ON s.id = x.source_txn_id JOIN transactions tg ON tg.id = x.target_txn_id
    WHERE s.company_id = ? AND s.type IN ('payment','bill_payment') AND s.status='posted' AND s.date >= ? AND s.date <= ?`, companyId, from, to);
  for (const a of apps) {
    if (!a.total) continue;
    const ratio = a.amount / a.total;
    for (const j of db.all('SELECT account_id, debit - credit AS net FROM journal_lines WHERE transaction_id = ?', a.target_txn_id)) {
      if (isPnl(byId.get(j.account_id).type)) add(j.account_id, Math.round(j.net * ratio));
    }
  }
  return out;
}

function pnlNet(db, companyId, from, to, basis, byId) {
  return basis === 'cash' ? cashBasisPnl(db, companyId, from, to, byId) : netByAccount(db, companyId, from, to);
}

/** Roll child balances into parents so a parent row shows its subtree total. */
function rollup(values, byId) {
  const out = new Map(values);
  for (const [id, v] of values) {
    let p = byId.get(id)?.parent_id;
    while (p) { out.set(p, (out.get(p) ?? 0) + v); p = byId.get(p)?.parent_id; }
  }
  return out;
}

function sectionRows(accounts, columnsValues, byId, { label, totalLabel, depth = 0, showZero = false }) {
  // columnsValues: array of Map(account_id -> signed amount)
  const rolled = columnsValues.map((m) => rollup(m, byId));
  const rows = [{ cells: [label, ...columnsValues.map(() => null)], kind: 'section', depth }];
  const totals = columnsValues.map(() => 0);
  for (const a of accounts) {
    const vals = rolled.map((m) => m.get(a.id) ?? 0);
    if (!showZero && vals.every((v) => v === 0)) continue;
    rows.push({ cells: [`${a.number ? a.number + ' ' : ''}${a.name}`, ...vals], kind: 'row', depth: depth + 1 + a.depth, account_id: a.id });
  }
  for (const a of accounts) if (!a.parent_id || !accounts.some((x) => x.id === a.parent_id)) columnsValues.forEach((m, i) => { totals[i] += rolled[i].get(a.id) ?? 0; });
  if (rows.length === 1 && totals.every((v) => v === 0)) return { rows: [], totals }; // hide empty sections
  rows.push({ cells: [totalLabel, ...totals], kind: 'subtotal', depth });
  return { rows, totals };
}

function periodColumns(from, to, mode) {
  if (mode !== 'months') return [{ label: 'Total', from, to }];
  const cols = [];
  let cur = from.slice(0, 7) + '-01';
  while (cur <= to && cols.length < 36) {
    const [y, m] = cur.split('-').map(Number);
    const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
    const end = addDays(next, -1);
    cols.push({ label: new Date(cur + 'T00:00:00Z').toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }), from: cur < from ? from : cur, to: end > to ? to : end });
    cur = next;
  }
  cols.push({ label: 'Total', from, to });
  return cols;
}

export function profitAndLoss(db, company, { from, to, basis = 'accrual', columns: colMode = 'total' }) {
  const byId = accountsById(db, company.id);
  const cols = periodColumns(from, to, colMode);
  const nets = cols.map((c) => pnlNet(db, company.id, c.from, c.to, basis, byId));
  const of = (types) => sortAccounts([...byId.values()].filter((a) => types.includes(a.type)), byId);
  const asSigned = (types) => nets.map((m) => new Map([...m].filter(([id]) => types.includes(byId.get(id)?.type)).map(([id, v]) => [id, ACCOUNT_TYPES[byId.get(id).type].cls === 'income' ? -v : v])));
  const rows = [];
  const sec = (types, label, totalLabel) => { const r = sectionRows(of(types), asSigned(types), byId, { label, totalLabel }); rows.push(...r.rows); return r.totals; };
  const inc = sec(['income'], 'Income', 'Total Income');
  const cogs = sec(['cost_of_goods_sold'], 'Cost of Goods Sold', 'Total Cost of Goods Sold');
  const gp = inc.map((v, i) => v - cogs[i]);
  rows.push({ cells: ['Gross Profit', ...gp], kind: 'total', depth: 0 });
  const exp = sec(['expense'], 'Expenses', 'Total Expenses');
  const noi = gp.map((v, i) => v - exp[i]);
  rows.push({ cells: ['Net Operating Income', ...noi], kind: 'total', depth: 0 });
  const oi = sec(['other_income'], 'Other Income', 'Total Other Income');
  const oe = sec(['other_expense'], 'Other Expenses', 'Total Other Expenses');
  const noth = oi.map((v, i) => v - oe[i]);
  rows.push({ cells: ['Net Other Income', ...noth], kind: 'total', depth: 0 });
  rows.push({ cells: ['Net Income', ...noi.map((v, i) => v + noth[i])], kind: 'grand', depth: 0 });
  return { title: 'Profit and Loss', subtitle: `${fmtRange(from, to)} · ${basis === 'cash' ? 'Cash' : 'Accrual'} basis`, columns: [text(''), ...cols.map((c) => money(c.label))], rows, netIncome: noi.at(-1) + noth.at(-1) };
}

/** Net income (accrual) for a date range, in cents (positive = profit). */
export function netIncome(db, companyId, from, to) {
  const r = db.get(`SELECT COALESCE(SUM(j.credit - j.debit),0) AS ni FROM journal_lines j JOIN accounts a ON a.id = j.account_id
    WHERE j.company_id = ? AND j.date >= ? AND j.date <= ? AND a.type IN ('income','cost_of_goods_sold','expense','other_income','other_expense')`, companyId, from, to);
  return r.ni;
}

export function balanceSheet(db, company, { asof }) {
  const byId = accountsById(db, company.id);
  const fy = fiscalYearStart(company, asof);
  const cum = netByAccount(db, company.id, null, asof);
  const re = systemAccount(db, company.id, 'RETAINED_EARNINGS');
  const priorNI = netIncome(db, company.id, '0000-01-01', addDays(fy, -1));
  const curNI = netIncome(db, company.id, fy, asof);
  const signedMap = (types) => [new Map([...cum].filter(([id]) => types.includes(byId.get(id)?.type)).map(([id, v]) => [id, signed(byId.get(id).type, Math.max(v, 0), Math.max(-v, 0))]))];
  const of = (types) => sortAccounts([...byId.values()].filter((a) => types.includes(a.type)), byId);
  const rows = [];
  const sec = (types, label, totalLabel, depth, extra) => {
    const vals = signedMap(types);
    if (extra) for (const [id, v] of extra) vals[0].set(id, (vals[0].get(id) ?? 0) + v);
    const r = sectionRows(of(types), vals, byId, { label, totalLabel, depth });
    rows.push(...r.rows);
    return r.totals[0];
  };
  rows.push({ cells: ['ASSETS', null], kind: 'section', depth: 0 });
  rows.push({ cells: ['Current Assets', null], kind: 'section', depth: 1 });
  const bank = sec(['bank'], 'Bank Accounts', 'Total Bank Accounts', 2);
  const ar = sec(['accounts_receivable'], 'Accounts Receivable', 'Total Accounts Receivable', 2);
  const oca = sec(['other_current_asset'], 'Other Current Assets', 'Total Other Current Assets', 2);
  rows.push({ cells: ['Total Current Assets', bank + ar + oca], kind: 'subtotal', depth: 1 });
  const fa = sec(['fixed_asset'], 'Fixed Assets', 'Total Fixed Assets', 1);
  const oa = sec(['other_asset'], 'Other Assets', 'Total Other Assets', 1);
  const assets = bank + ar + oca + fa + oa;
  rows.push({ cells: ['TOTAL ASSETS', assets], kind: 'grand', depth: 0 });
  rows.push({ cells: ['LIABILITIES AND EQUITY', null], kind: 'section', depth: 0 });
  rows.push({ cells: ['Liabilities', null], kind: 'section', depth: 1 });
  rows.push({ cells: ['Current Liabilities', null], kind: 'section', depth: 2 });
  const ap = sec(['accounts_payable'], 'Accounts Payable', 'Total Accounts Payable', 3);
  const cc = sec(['credit_card'], 'Credit Cards', 'Total Credit Cards', 3);
  const ocl = sec(['other_current_liability'], 'Other Current Liabilities', 'Total Other Current Liabilities', 3);
  rows.push({ cells: ['Total Current Liabilities', ap + cc + ocl], kind: 'subtotal', depth: 2 });
  const ltl = sec(['long_term_liability'], 'Long-Term Liabilities', 'Total Long-Term Liabilities', 2);
  const liab = ap + cc + ocl + ltl;
  rows.push({ cells: ['Total Liabilities', liab], kind: 'subtotal', depth: 1 });
  const eq = sec(['equity'], 'Equity', 'Total Equity', 1, [[re.id, priorNI]]);
  if (rows.at(-1).cells[0] !== 'Total Equity') rows.push({ cells: ['Equity', null], kind: 'section', depth: 1 }, { cells: ['Total Equity', 0], kind: 'subtotal', depth: 1 });
  // Net Income sits just above "Total Equity"
  rows.splice(rows.length - 1, 0, { cells: ['Net Income', curNI], kind: 'row', depth: 2 });
  rows[rows.length - 1].cells[1] = eq + curNI;
  rows.push({ cells: ['TOTAL LIABILITIES AND EQUITY', liab + eq + curNI], kind: 'grand', depth: 0 });
  return { title: 'Balance Sheet', subtitle: `As of ${fmtDate(asof)}`, columns: [text(''), money('Total')], rows, check: { assets, liabilitiesAndEquity: liab + eq + curNI } };
}

export function trialBalance(db, company, { asof }) {
  const byId = accountsById(db, company.id);
  const fy = fiscalYearStart(company, asof);
  const cum = netByAccount(db, company.id, null, asof);
  const ytd = netByAccount(db, company.id, fy, asof);
  const re = systemAccount(db, company.id, 'RETAINED_EARNINGS');
  const rows = [];
  let td = 0, tc = 0;
  for (const a of sortAccounts([...byId.values()], byId)) {
    let net = isPnl(a.type) ? ytd.get(a.id) ?? 0 : cum.get(a.id) ?? 0;
    if (a.id === re.id) net -= netIncome(db, company.id, '0000-01-01', addDays(fy, -1));
    if (!net) continue;
    const d = net > 0 ? net : 0, c = net < 0 ? -net : 0;
    td += d; tc += c;
    rows.push({ cells: [`${a.number ? a.number + ' ' : ''}${a.name}`, d || null, c || null], kind: 'row', depth: 0, account_id: a.id });
  }
  rows.push({ cells: ['TOTAL', td, tc], kind: 'grand', depth: 0 });
  return { title: 'Trial Balance', subtitle: `As of ${fmtDate(asof)}`, columns: [text(''), money('Debit'), money('Credit')], rows };
}

export function generalLedger(db, company, { from, to, account_id }) {
  const byId = accountsById(db, company.id);
  const accounts = sortAccounts([...byId.values()].filter((a) => !account_id || a.id === Number(account_id)), byId);
  const fy = fiscalYearStart(company, from);
  const before = netByAccount(db, company.id, null, addDays(from, -1));
  const beforePnl = netByAccount(db, company.id, fy, addDays(from, -1));
  const rows = [];
  for (const a of accounts) {
    const begNet = isPnl(a.type) ? beforePnl.get(a.id) ?? 0 : before.get(a.id) ?? 0;
    const lines = db.all(`SELECT j.*, t.type, t.number, t.memo AS txn_memo, COALESCE(c.display_name, v.display_name) AS name
      FROM journal_lines j JOIN transactions t ON t.id = j.transaction_id LEFT JOIN customers c ON c.id = j.customer_id LEFT JOIN vendors v ON v.id = j.vendor_id
      WHERE j.account_id = ? AND j.date >= ? AND j.date <= ? ORDER BY j.date, j.transaction_id, j.id`, a.id, from, to);
    if (!lines.length && !begNet && !account_id) continue;
    const sgn = (net) => (ACCOUNT_TYPES[a.type].cls === 'asset' || ACCOUNT_TYPES[a.type].cls === 'expense' ? net : -net);
    let bal = sgn(begNet);
    rows.push({ cells: [`${a.number ? a.number + ' ' : ''}${a.name}`, null, null, null, null, null, null, null], kind: 'section', depth: 0, account_id: a.id });
    rows.push({ cells: ['Beginning Balance', null, null, null, null, null, null, bal], kind: 'row', depth: 1 });
    let td = 0, tc = 0;
    for (const l of lines) {
      bal += sgn(l.debit - l.credit); td += l.debit; tc += l.credit;
      rows.push({ cells: [l.date, TXN_TYPES[l.type]?.label ?? l.type, l.number, l.name, l.memo ?? l.txn_memo, l.debit || null, l.credit || null, bal], kind: 'row', depth: 1, txn_id: l.transaction_id });
    }
    rows.push({ cells: [`Total for ${a.name}`, null, null, null, null, td, tc, bal], kind: 'subtotal', depth: 0 });
  }
  return { title: account_id ? `Account QuickReport: ${byId.get(Number(account_id))?.name ?? ''}` : 'General Ledger', subtitle: fmtRange(from, to), columns: [date('Date'), text('Transaction Type'), text('Num'), text('Name'), text('Memo/Description'), money('Debit'), money('Credit'), money('Balance')], rows };
}

export function journalReport(db, company, { from, to }) {
  const lines = db.all(`SELECT j.*, t.type, t.number, a.name AS account_name, a.number AS account_number, COALESCE(c.display_name, v.display_name) AS name
    FROM journal_lines j JOIN transactions t ON t.id = j.transaction_id JOIN accounts a ON a.id = j.account_id
    LEFT JOIN customers c ON c.id = j.customer_id LEFT JOIN vendors v ON v.id = j.vendor_id
    WHERE j.company_id = ? AND j.date >= ? AND j.date <= ? ORDER BY j.date, j.transaction_id, j.id`, company.id, from, to);
  const rows = [];
  let cur = null, td = 0, tc = 0, gd = 0, gc = 0;
  const flush = () => { if (cur !== null) rows.push({ cells: ['', '', '', '', '', td, tc], kind: 'subtotal', depth: 0 }); td = tc = 0; };
  for (const l of lines) {
    if (l.transaction_id !== cur) { flush(); cur = l.transaction_id; }
    rows.push({ cells: [l.date, TXN_TYPES[l.type]?.label, l.number, l.name, `${l.account_number ? l.account_number + ' ' : ''}${l.account_name}`, l.debit || null, l.credit || null], kind: 'row', depth: 0, txn_id: l.transaction_id });
    td += l.debit; tc += l.credit; gd += l.debit; gc += l.credit;
  }
  flush();
  rows.push({ cells: ['TOTAL', '', '', '', '', gd, gc], kind: 'grand', depth: 0 });
  return { title: 'Journal', subtitle: fmtRange(from, to), columns: [date('Date'), text('Transaction Type'), text('Num'), text('Name'), text('Account'), money('Debit'), money('Credit')], rows };
}

export function transactionList(db, company, { from, to }) {
  const rows = db.all(`SELECT t.*, COALESCE(c.display_name, v.display_name) AS name, a.name AS account_name FROM transactions t
    LEFT JOIN customers c ON c.id = t.customer_id LEFT JOIN vendors v ON v.id = t.vendor_id LEFT JOIN accounts a ON a.id = t.account_id
    WHERE t.company_id = ? AND t.date >= ? AND t.date <= ? ORDER BY t.date, t.id`, company.id, from, to)
    .map((t) => ({ cells: [t.date, TXN_TYPES[t.type]?.label, t.number, t.status === 'voided' ? 'Voided' : '', t.name, t.memo, t.account_name, t.total], kind: 'row', depth: 0, txn_id: t.id }));
  return { title: 'Transaction List by Date', subtitle: fmtRange(from, to), columns: [date('Date'), text('Transaction Type'), text('Num'), text('Status'), text('Name'), text('Memo/Description'), text('Account'), money('Amount')], rows };
}

/** Open documents and unapplied credits as of a date, for A/R ('invoice') or A/P ('bill'). */
export function openItemsAsOf(db, companyId, side, asof) {
  const isAr = side === 'ar';
  const docType = isAr ? 'invoice' : 'bill';
  const creditTypes = isAr ? ['payment', 'credit_memo'] : ['bill_payment', 'vendor_credit'];
  const fk = isAr ? 'customer_id' : 'vendor_id';
  const nameTable = isAr ? 'customers' : 'vendors';
  // Application is effective on the later of its source and target dates.
  const appliedTo = (id) => db.get(`SELECT COALESCE(SUM(x.amount),0) AS s FROM applications x JOIN transactions s ON s.id = x.source_txn_id JOIN transactions tg ON tg.id = x.target_txn_id
      WHERE x.target_txn_id = ? AND MAX(s.date, tg.date) <= ?`, id, asof).s;
  const appliedFrom = (id) => db.get(`SELECT COALESCE(SUM(x.amount),0) AS s FROM applications x JOIN transactions s ON s.id = x.source_txn_id JOIN transactions tg ON tg.id = x.target_txn_id
      WHERE x.source_txn_id = ? AND MAX(s.date, tg.date) <= ?`, id, asof).s;
  const docs = db.all(`SELECT t.*, n.display_name AS name FROM transactions t JOIN ${nameTable} n ON n.id = t.${fk}
    WHERE t.company_id = ? AND t.type = ? AND t.status='posted' AND t.date <= ?`, companyId, docType, asof)
    .map((t) => ({ ...t, open: t.total - appliedTo(t.id), days: daysBetween(t.due_date ?? t.date, asof) }))
    .filter((t) => t.open !== 0);
  const credits = db.all(`SELECT t.*, n.display_name AS name FROM transactions t JOIN ${nameTable} n ON n.id = t.${fk}
    WHERE t.company_id = ? AND t.type IN (?,?) AND t.status='posted' AND t.date <= ?`, companyId, ...creditTypes, asof)
    .map((t) => ({ ...t, open: -(t.total - appliedFrom(t.id)), days: 0 }))
    .filter((t) => t.open !== 0);
  return [...docs, ...credits];
}

const BUCKETS = [['Current', (d) => d <= 0], ['1 - 30', (d) => d >= 1 && d <= 30], ['31 - 60', (d) => d >= 31 && d <= 60], ['61 - 90', (d) => d >= 61 && d <= 90], ['91 and over', (d) => d > 90]];

export function aging(db, company, { asof, side, detail }) {
  const items = openItemsAsOf(db, company.id, side, asof);
  const label = side === 'ar' ? 'A/R' : 'A/P';
  if (!detail) {
    const byName = new Map();
    for (const it of items) {
      const row = byName.get(it.name) ?? Array(BUCKETS.length).fill(0);
      row[BUCKETS.findIndex(([, f]) => f(it.days))] += it.open;
      byName.set(it.name, row);
    }
    const rows = [...byName].sort(([a], [b]) => a.localeCompare(b)).map(([name, b]) => ({ cells: [name, ...b, b.reduce((s, v) => s + v, 0)], kind: 'row', depth: 0 }));
    const tot = BUCKETS.map((_, i) => rows.reduce((s, r) => s + r.cells[i + 1], 0));
    rows.push({ cells: ['TOTAL', ...tot, tot.reduce((s, v) => s + v, 0)], kind: 'grand', depth: 0 });
    return { title: `${label} Aging Summary`, subtitle: `As of ${fmtDate(asof)}`, columns: [text(''), ...BUCKETS.map(([l]) => money(l)), money('Total')], rows };
  }
  const rows = [];
  let grand = 0;
  for (const [bl, f] of [...BUCKETS].reverse()) {
    const group = items.filter((i) => f(i.days)).sort((a, b) => a.date.localeCompare(b.date));
    if (!group.length) continue;
    rows.push({ cells: [bl, null, null, null, null, null, null], kind: 'section', depth: 0 });
    let sub = 0;
    for (const i of group) { sub += i.open; rows.push({ cells: [i.date, TXN_TYPES[i.type].label, i.number, i.name, i.due_date, i.days > 0 ? String(i.days) : '', i.open], kind: 'row', depth: 1, txn_id: i.id }); }
    rows.push({ cells: [`Total for ${bl}`, null, null, null, null, null, sub], kind: 'subtotal', depth: 0 });
    grand += sub;
  }
  rows.push({ cells: ['TOTAL', null, null, null, null, null, grand], kind: 'grand', depth: 0 });
  return { title: `${label} Aging Detail`, subtitle: `As of ${fmtDate(asof)}`, columns: [date('Date'), text('Transaction Type'), text('Num'), text(side === 'ar' ? 'Customer' : 'Vendor'), date('Due Date'), text('Past Due'), money('Open Balance')], rows };
}

export function salesByCustomer(db, company, { from, to }) {
  const rows = db.all(`SELECT COALESCE(c.display_name, 'Not specified') AS name, SUM(j.credit - j.debit) AS amt
    FROM journal_lines j JOIN accounts a ON a.id = j.account_id LEFT JOIN customers c ON c.id = j.customer_id
    WHERE j.company_id = ? AND j.date >= ? AND j.date <= ? AND a.type IN ('income') GROUP BY name HAVING amt != 0 ORDER BY name`, company.id, from, to)
    .map((r) => ({ cells: [r.name, r.amt], kind: 'row', depth: 0 }));
  rows.push({ cells: ['TOTAL', rows.reduce((s, r) => s + r.cells[1], 0)], kind: 'grand', depth: 0 });
  return { title: 'Sales by Customer Summary', subtitle: fmtRange(from, to), columns: [text(''), money('Total')], rows };
}

export function salesByItem(db, company, { from, to }) {
  const rows = db.all(`SELECT COALESCE(i.name, 'Not specified') AS name, SUM(CASE WHEN t.type='credit_memo' THEN -COALESCE(l.qty,0) ELSE COALESCE(l.qty,0) END) AS qty,
      SUM(CASE WHEN t.type='credit_memo' THEN -l.amount ELSE l.amount END) AS amt
    FROM transaction_lines l JOIN transactions t ON t.id = l.transaction_id LEFT JOIN items i ON i.id = l.item_id
    WHERE t.company_id = ? AND t.status='posted' AND t.type IN ('invoice','sales_receipt','credit_memo') AND t.date >= ? AND t.date <= ?
    GROUP BY name ORDER BY name`, company.id, from, to)
    .map((r) => ({ cells: [r.name, r.qty ? String(Math.round(r.qty * 100) / 100) : '', r.amt], kind: 'row', depth: 0 }));
  rows.push({ cells: ['TOTAL', '', rows.reduce((s, r) => s + r.cells[2], 0)], kind: 'grand', depth: 0 });
  return { title: 'Sales by Product/Service Summary', subtitle: fmtRange(from, to), columns: [text(''), text('Quantity'), money('Amount')], rows };
}

export function expensesByVendor(db, company, { from, to }) {
  const rows = db.all(`SELECT COALESCE(v.display_name, 'Not specified') AS name, SUM(j.debit - j.credit) AS amt
    FROM journal_lines j JOIN accounts a ON a.id = j.account_id LEFT JOIN vendors v ON v.id = j.vendor_id
    WHERE j.company_id = ? AND j.date >= ? AND j.date <= ? AND a.type IN ('expense','cost_of_goods_sold','other_expense') GROUP BY name HAVING amt != 0 ORDER BY name`, company.id, from, to)
    .map((r) => ({ cells: [r.name, r.amt], kind: 'row', depth: 0 }));
  rows.push({ cells: ['TOTAL', rows.reduce((s, r) => s + r.cells[1], 0)], kind: 'grand', depth: 0 });
  return { title: 'Expenses by Vendor Summary', subtitle: fmtRange(from, to), columns: [text(''), money('Total')], rows };
}

/**
 * 1099-NEC contractor summary. Card/third-party-network payments are reported by the processor
 * on a 1099-K, so only payments from bank accounts count toward the threshold.
 * Threshold is $600 through tax year 2025 and $2,000 for payments made after 2025.
 */
export function vendor1099(db, company, { year }) {
  const y = Number(year) || Number(today().slice(0, 4));
  const threshold = y >= 2026 ? 200000 : 60000;
  const rows = db.all(`SELECT v.display_name AS name, v.tax_id, a.type AS pay_type, SUM(t.total) AS amt
    FROM transactions t JOIN vendors v ON v.id = t.vendor_id JOIN accounts a ON a.id = t.account_id
    WHERE t.company_id = ? AND v.is_1099 = 1 AND t.status='posted' AND t.type IN ('expense','check','bill_payment') AND t.date >= ? AND t.date <= ?
    GROUP BY v.id, a.type ORDER BY v.display_name`, company.id, `${y}-01-01`, `${y}-12-31`);
  const byVendor = new Map();
  for (const r of rows) {
    const e = byVendor.get(r.name) ?? { tax_id: r.tax_id, bank: 0, card: 0 };
    if (r.pay_type === 'credit_card') e.card += r.amt; else e.bank += r.amt;
    byVendor.set(r.name, e);
  }
  const out = [...byVendor].map(([name, e]) => ({ cells: [name, e.tax_id ?? 'MISSING', e.card, e.bank, e.bank >= threshold ? 'Yes' : 'No'], kind: 'row', depth: 0 }));
  out.push({ cells: ['TOTAL', '', out.reduce((s, r) => s + r.cells[2], 0), out.reduce((s, r) => s + r.cells[3], 0), ''], kind: 'grand', depth: 0 });
  return { title: '1099 Contractor Summary', subtitle: `Tax year ${y} · reporting threshold $${(threshold / 100).toLocaleString()} · excludes card payments (reported on 1099-K)`, columns: [text('Vendor'), text('Tax ID'), money('Paid by card (excluded)'), money('Reportable (bank)'), text('Over threshold')], rows: out };
}

export function salesTax(db, company, { from, to }) {
  const rows = db.all(`SELECT COALESCE(r.name, 'No tax') AS name, r.rate,
      SUM(CASE WHEN t.type='credit_memo' THEN -t.subtotal ELSE t.subtotal END) AS sales,
      SUM(CASE WHEN t.type='credit_memo' THEN -(SELECT COALESCE(SUM(l.amount),0) FROM transaction_lines l WHERE l.transaction_id=t.id AND l.taxable=1) ELSE (SELECT COALESCE(SUM(l.amount),0) FROM transaction_lines l WHERE l.transaction_id=t.id AND l.taxable=1) END) AS taxable,
      SUM(CASE WHEN t.type='credit_memo' THEN -t.tax_amount ELSE t.tax_amount END) AS tax
    FROM transactions t LEFT JOIN tax_rates r ON r.id = t.tax_rate_id
    WHERE t.company_id = ? AND t.status='posted' AND t.type IN ('invoice','sales_receipt','credit_memo') AND t.date >= ? AND t.date <= ?
    GROUP BY t.tax_rate_id ORDER BY name`, company.id, from, to)
    .map((r) => ({ cells: [r.rate != null ? `${r.name} (${r.rate}%)` : r.name, r.sales, r.taxable, r.sales - r.taxable, r.tax], kind: 'row', depth: 0 }));
  const tot = [1, 2, 3, 4].map((i) => rows.reduce((s, r) => s + r.cells[i], 0));
  rows.push({ cells: ['TOTAL', ...tot], kind: 'grand', depth: 0 });
  return { title: 'Sales Tax Liability', subtitle: fmtRange(from, to), columns: [text('Rate'), money('Total Sales'), money('Taxable Sales'), money('Non-taxable Sales'), money('Tax Amount')], rows };
}

export function cashFlow(db, company, { from, to }) {
  const byId = accountsById(db, company.id);
  const delta = netByAccount(db, company.id, from, to);
  const ni = netIncome(db, company.id, from, to);
  const rows = [{ cells: ['OPERATING ACTIVITIES', null], kind: 'section', depth: 0 }, { cells: ['Net Income', ni], kind: 'row', depth: 1 }];
  const group = (pred) => sortAccounts([...byId.values()].filter(pred), byId).map((a) => [a, -(delta.get(a.id) ?? 0)]).filter(([, v]) => v);
  const opAdj = group((a) => ['accounts_receivable', 'other_current_asset', 'accounts_payable', 'credit_card', 'other_current_liability'].includes(a.type));
  if (opAdj.length) rows.push({ cells: ['Adjustments to reconcile Net Income to Net Cash provided by operations:', null], kind: 'section', depth: 1 });
  for (const [a, v] of opAdj) rows.push({ cells: [a.name, v], kind: 'row', depth: 2, account_id: a.id });
  const op = ni + opAdj.reduce((s, [, v]) => s + v, 0);
  rows.push({ cells: ['Net cash provided by operating activities', op], kind: 'subtotal', depth: 0 });
  const inv = group((a) => ['fixed_asset', 'other_asset'].includes(a.type));
  rows.push({ cells: ['INVESTING ACTIVITIES', null], kind: 'section', depth: 0 });
  for (const [a, v] of inv) rows.push({ cells: [a.name, v], kind: 'row', depth: 1, account_id: a.id });
  const invT = inv.reduce((s, [, v]) => s + v, 0);
  rows.push({ cells: ['Net cash provided by investing activities', invT], kind: 'subtotal', depth: 0 });
  const fin = group((a) => ['long_term_liability', 'equity'].includes(a.type));
  rows.push({ cells: ['FINANCING ACTIVITIES', null], kind: 'section', depth: 0 });
  for (const [a, v] of fin) rows.push({ cells: [a.name, v], kind: 'row', depth: 1, account_id: a.id });
  const finT = fin.reduce((s, [, v]) => s + v, 0);
  rows.push({ cells: ['Net cash provided by financing activities', finT], kind: 'subtotal', depth: 0 });
  const net = op + invT + finT;
  rows.push({ cells: ['NET CASH INCREASE FOR PERIOD', net], kind: 'total', depth: 0 });
  const banks = [...byId.values()].filter((a) => a.type === 'bank').map((a) => a.id);
  const opening = netByAccount(db, company.id, null, addDays(from, -1));
  const cashStart = banks.reduce((s, id) => s + (opening.get(id) ?? 0), 0);
  rows.push({ cells: ['Cash at beginning of period', cashStart], kind: 'row', depth: 0 });
  rows.push({ cells: ['CASH AT END OF PERIOD', cashStart + net], kind: 'grand', depth: 0 });
  return { title: 'Statement of Cash Flows', subtitle: fmtRange(from, to), columns: [text(''), money('Total')], rows };
}

export function accountList(db, company) {
  const byId = accountsById(db, company.id);
  const bal = netByAccount(db, company.id, null, null);
  const rows = sortAccounts([...byId.values()], byId).map((a) => ({ cells: [`${a.number ? a.number + ' ' : ''}${a.name}`, ACCOUNT_TYPES[a.type].label, a.detail_type ?? '', a.is_active ? '' : 'Inactive', isPnl(a.type) ? null : signed(a.type, Math.max(bal.get(a.id) ?? 0, 0), Math.max(-(bal.get(a.id) ?? 0), 0))], kind: 'row', depth: a.depth, account_id: a.id }));
  return { title: 'Account List', subtitle: '', columns: [text('Account'), text('Type'), text('Detail Type'), text('Status'), money('Balance')], rows };
}

export function runReport(db, company, name, q) {
  const def = REPORTS[name];
  if (!def) throw bad('Unknown report');
  const t = today();
  const from = isDate(q.from) ? q.from : fiscalYearStart(company, t);
  const to = isDate(q.to) ? q.to : t;
  const asof = isDate(q.asof) ? q.asof : t;
  if (from > to) throw bad('Start date must be on or before end date');
  const args = { from, to, asof, basis: q.basis, columns: q.columns, account_id: q.account_id, year: q.year };
  const fn = {
    profit_and_loss: profitAndLoss, balance_sheet: balanceSheet, cash_flow: cashFlow, trial_balance: trialBalance,
    general_ledger: generalLedger, journal: journalReport, transaction_list: transactionList, account_list: accountList,
    ar_aging: (d, c, a) => aging(d, c, { ...a, side: 'ar' }), ar_aging_detail: (d, c, a) => aging(d, c, { ...a, side: 'ar', detail: true }),
    ap_aging: (d, c, a) => aging(d, c, { ...a, side: 'ap' }), ap_aging_detail: (d, c, a) => aging(d, c, { ...a, side: 'ap', detail: true }),
    sales_by_customer: salesByCustomer, sales_by_item: salesByItem, expenses_by_vendor: expensesByVendor, vendor_1099: vendor1099, sales_tax: salesTax,
  }[name];
  const r = fn(db, company, args);
  return { ...r, name, company: company.name, params: { from, to, asof, basis: q.basis ?? 'accrual', columns: q.columns ?? 'total', account_id: q.account_id ?? null, year: args.year ?? t.slice(0, 4) } };
}

export function dashboard(db, company) {
  const t = today();
  const fy = fiscalYearStart(company, t);
  const banks = db.all(`SELECT a.id, a.name, a.type, COALESCE(SUM(j.debit),0) AS d, COALESCE(SUM(j.credit),0) AS c,
      (SELECT COUNT(*) FROM bank_feed f WHERE f.account_id = a.id AND f.status='review') AS to_review,
      (SELECT MAX(r.statement_date) FROM reconciliations r WHERE r.account_id = a.id) AS last_reconciled
    FROM accounts a LEFT JOIN journal_lines j ON j.account_id = a.id
    WHERE a.company_id = ? AND a.type IN ('bank','credit_card') AND a.is_active = 1 GROUP BY a.id ORDER BY a.type, a.name`, company.id)
    .map((a) => ({ id: a.id, name: a.name, type: a.type, balance: signed(a.type, a.d, a.c), to_review: a.to_review, last_reconciled: a.last_reconciled }));
  const ar = openItemsAsOf(db, company.id, 'ar', t).filter((i) => i.type === 'invoice');
  const ap = openItemsAsOf(db, company.id, 'ap', t).filter((i) => i.type === 'bill');
  const months = [];
  for (let k = 5; k >= 0; k--) {
    const d = new Date(t + 'T00:00:00Z'); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - k);
    const start = d.toISOString().slice(0, 10);
    const e = new Date(d); e.setUTCMonth(e.getUTCMonth() + 1); e.setUTCDate(0);
    const end = e.toISOString().slice(0, 10);
    const r = db.get(`SELECT COALESCE(SUM(CASE WHEN a.type IN ('income','other_income') THEN j.credit - j.debit ELSE 0 END),0) AS inc,
        COALESCE(SUM(CASE WHEN a.type IN ('expense','cost_of_goods_sold','other_expense') THEN j.debit - j.credit ELSE 0 END),0) AS exp
      FROM journal_lines j JOIN accounts a ON a.id = j.account_id WHERE j.company_id = ? AND j.date >= ? AND j.date <= ?`, company.id, start, end);
    months.push({ label: d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }), income: r.inc, expenses: r.exp });
  }
  const ytd = db.get(`SELECT COALESCE(SUM(CASE WHEN a.type IN ('income','other_income') THEN j.credit - j.debit ELSE 0 END),0) AS inc,
      COALESCE(SUM(CASE WHEN a.type IN ('expense','cost_of_goods_sold','other_expense') THEN j.debit - j.credit ELSE 0 END),0) AS exp
    FROM journal_lines j JOIN accounts a ON a.id = j.account_id WHERE j.company_id = ? AND j.date >= ? AND j.date <= ?`, company.id, fy, t);
  const topExpenses = db.all(`SELECT a.name, SUM(j.debit - j.credit) AS amt FROM journal_lines j JOIN accounts a ON a.id = j.account_id
    WHERE j.company_id = ? AND j.date >= ? AND j.date <= ? AND a.type IN ('expense','cost_of_goods_sold','other_expense') GROUP BY a.id HAVING amt > 0 ORDER BY amt DESC LIMIT 5`, company.id, fy, t);
  const uf = systemAccount(db, company.id, 'UNDEPOSITED');
  const ufBal = db.get('SELECT COALESCE(SUM(debit - credit),0) AS b FROM journal_lines WHERE account_id = ?', uf.id).b;
  return {
    as_of: t, fiscal_year_start: fy, banks, months, undeposited: ufBal,
    ytd: { income: ytd.inc, expenses: ytd.exp, net: ytd.inc - ytd.exp }, top_expenses: topExpenses,
    ar: { open: ar.reduce((s, i) => s + i.open, 0), overdue: ar.filter((i) => i.days > 0).reduce((s, i) => s + i.open, 0), count: ar.length, overdue_count: ar.filter((i) => i.days > 0).length },
    ap: { open: ap.reduce((s, i) => s + i.open, 0), overdue: ap.filter((i) => i.days > 0).reduce((s, i) => s + i.open, 0), count: ap.length, overdue_count: ap.filter((i) => i.days > 0).length, due_soon: ap.filter((i) => i.days <= 0 && i.days > -8).reduce((s, i) => s + i.open, 0) },
  };
}

export function toCsv(report) {
  const esc = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [[report.title], [report.company ?? ''], [report.subtitle ?? ''], [], report.columns.map((c) => c.label)];
  for (const r of report.rows) lines.push(r.cells.map((v, i) => (report.columns[i]?.type === 'money' && typeof v === 'number' ? (v / 100).toFixed(2) : (i === 0 ? '  '.repeat(r.depth ?? 0) : '') + (v ?? ''))));
  return lines.map((l) => l.map(esc).join(',')).join('\r\n') + '\r\n';
}

function fmtDate(iso) { const [y, m, d] = iso.split('-'); return `${new Date(Date.UTC(+y, +m - 1, +d)).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })} ${+d}, ${y}`; }
function fmtRange(a, b) { return `${fmtDate(a)} – ${fmtDate(b)}`; }
