import { bad, isDate, today, addDays, daysBetween } from '../util.js';
import { ACCOUNT_TYPES, isPnl, isDebitNormal, signed, systemAccount } from './accounts.js';
import { TXN_TYPES } from './transactions.js';

/**
 * Every report returns: { title, subtitle, columns: [{label, type}], rows: [{cells, kind, depth, txn_id?, account_id?}] }
 * kind: 'section' | 'row' | 'subtotal' | 'total' | 'grand'. Money cells are integer cents.
 */

export const REPORTS = {
  profit_and_loss:    { title: 'Profit and Loss', group: 'Business overview', params: ['range', 'basis', 'columns'], customize: true },
  balance_sheet:      { title: 'Balance Sheet', group: 'Business overview', params: ['asof'], customize: true },
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
  general_ledger:     { title: 'General Ledger', group: 'For my accountant', params: ['range'], customize: true },
  journal:            { title: 'Journal', group: 'For my accountant', params: ['range'] },
  transaction_list:   { title: 'Transaction List by Date', group: 'For my accountant', params: ['range'] },
  account_list:       { title: 'Account List', group: 'For my accountant', params: [] },
};

const money = (label) => ({ label, type: 'money' });
const text = (label) => ({ label, type: 'text' });
const date = (label) => ({ label, type: 'date' });
const percent = (label) => ({ label, type: 'percent' });

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

/** SQL fragment + params restricting journal lines (alias j) to a customer and/or vendor. */
function nameFilter(f = {}, alias = 'j') {
  const sql = [], p = [];
  if (f.customer_id) { sql.push(`${alias}.customer_id = ?`); p.push(Number(f.customer_id)); }
  if (f.vendor_id) { sql.push(`${alias}.vendor_id = ?`); p.push(Number(f.vendor_id)); }
  return { sql: sql.length ? ' AND ' + sql.join(' AND ') : '', p };
}

/** Net debit by account for journal lines in [from, to], optionally filtered by customer/vendor. */
function netByAccount(db, companyId, from, to, filter) {
  const nf = nameFilter(filter);
  const rows = db.all(`SELECT j.account_id, SUM(j.debit) AS d, SUM(j.credit) AS c FROM journal_lines j WHERE j.company_id = ? AND j.date >= ? AND j.date <= ?${nf.sql} GROUP BY j.account_id`, companyId, from ?? '0000-01-01', to ?? '9999-12-31', ...nf.p);
  return new Map(rows.map((r) => [r.account_id, r.d - r.c]));
}

/** Net debit by P&L account on a cash basis: payments recognize the paid share of invoices/bills. */
function cashBasisPnl(db, companyId, from, to, byId, filter) {
  const out = new Map();
  const add = (id, v) => out.set(id, (out.get(id) ?? 0) + v);
  const nf = nameFilter(filter);
  const direct = db.all(`SELECT j.account_id, j.debit - j.credit AS net FROM journal_lines j JOIN transactions t ON t.id = j.transaction_id
    WHERE j.company_id = ? AND j.date >= ? AND j.date <= ? AND t.type NOT IN ('invoice','credit_memo','bill','vendor_credit')${nf.sql}`, companyId, from, to, ...nf.p);
  for (const r of direct) if (isPnl(byId.get(r.account_id).type)) add(r.account_id, r.net);
  const apps = db.all(`SELECT x.amount, x.target_txn_id, tg.total FROM applications x
    JOIN transactions s ON s.id = x.source_txn_id JOIN transactions tg ON tg.id = x.target_txn_id
    WHERE s.company_id = ? AND s.type IN ('payment','bill_payment') AND s.status='posted' AND s.date >= ? AND s.date <= ?`, companyId, from, to);
  for (const a of apps) {
    if (!a.total) continue;
    const ratio = a.amount / a.total;
    for (const j of db.all(`SELECT j.account_id, j.debit - j.credit AS net FROM journal_lines j WHERE j.transaction_id = ?${nf.sql}`, a.target_txn_id, ...nf.p)) {
      if (isPnl(byId.get(j.account_id).type)) add(j.account_id, Math.round(j.net * ratio));
    }
  }
  return out;
}

function pnlNet(db, companyId, from, to, basis, byId, filter) {
  return basis === 'cash' ? cashBasisPnl(db, companyId, from, to, byId, filter) : netByAccount(db, companyId, from, to, filter);
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
  if (mode !== 'months' && mode !== 'quarters') return [{ label: 'Total', from, to }];
  const step = mode === 'quarters' ? 3 : 1;
  const cols = [];
  let [y, m] = from.split('-').map(Number);
  if (step === 3) m = Math.floor((m - 1) / 3) * 3 + 1;
  let cur = `${y}-${String(m).padStart(2, '0')}-01`;
  while (cur <= to && cols.length < 36) {
    const end = addMonths(cur, step, -1);
    const label = step === 3 ? `Q${Math.floor((m - 1) / 3) + 1} ${y}` : new Date(cur + 'T00:00:00Z').toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
    cols.push({ label, from: cur < from ? from : cur, to: end > to ? to : end });
    cur = addDays(end, 1);
    [y, m] = cur.split('-').map(Number);
  }
  cols.push({ label: 'Total', from, to });
  return cols;
}

/** First day of the month `n` months after `iso`'s month, plus `dayOffset` days. */
function addMonths(iso, n, dayOffset = 0) {
  const [y, m] = iso.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return addDays(d.toISOString().slice(0, 10), dayOffset);
}
const monthEnd = (iso) => addMonths(iso, 1, -1);
const isMonthStart = (iso) => iso.endsWith('-01');
const isMonthEnd = (iso) => monthEnd(iso) === iso;

/** Same date one year earlier (Feb 29 → Feb 28); month-ends stay month-ends. */
function minusYear(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  if (isMonthEnd(iso)) return monthEnd(`${y - 1}-${String(m).padStart(2, '0')}-01`);
  const last = Number(monthEnd(`${y - 1}-${String(m).padStart(2, '0')}-01`).slice(8));
  return `${y - 1}-${String(m).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

/** The comparison range for a period: same dates last year, or the immediately preceding period of equal length. */
export function comparisonRange(from, to, mode) {
  if (mode === 'prior_year') return { from: minusYear(from), to: minusYear(to), label: 'PY' };
  if (isMonthStart(from) && isMonthEnd(to)) {
    const months = (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7)) + 1;
    return { from: addMonths(from, -months), to: addDays(from, -1), label: 'PP' };
  }
  const days = daysBetween(from, to) + 1;
  return { from: addDays(from, -days), to: addDays(from, -1), label: 'PP' };
}

function compareAsOf(asof, mode) {
  if (mode === 'prior_year') return minusYear(asof);
  return isMonthEnd(asof) ? addDays(asof.slice(0, 8) + '01', -1) : (() => { const prev = addMonths(asof.slice(0, 8) + '01', -1); const last = monthEnd(prev); const d = prev.slice(0, 8) + asof.slice(8); return d > last ? last : d; })();
}

/** Relative report periods, resolved against today so saved reports and packages stay current. */
export const PERIODS = {
  this_month: 'This month', last_month: 'Last month', this_quarter: 'This quarter', last_quarter: 'Last quarter',
  this_year: 'This fiscal year', ytd: 'This fiscal year to date', last_year: 'Last fiscal year', last_year_to_date: 'Last fiscal year to date',
  last_12_months: 'Last 12 months', today: 'Today',
};
export function resolvePeriod(company, key, now = today()) {
  const mStart = now.slice(0, 8) + '01';
  const qStart = `${now.slice(0, 4)}-${String(Math.floor((Number(now.slice(5, 7)) - 1) / 3) * 3 + 1).padStart(2, '0')}-01`;
  const fy = fiscalYearStart(company, now);
  switch (key) {
    case 'this_month': return { from: mStart, to: monthEnd(mStart) };
    case 'last_month': { const s = addMonths(mStart, -1); return { from: s, to: monthEnd(s) }; }
    case 'this_quarter': return { from: qStart, to: addMonths(qStart, 3, -1) };
    case 'last_quarter': { const s = addMonths(qStart, -3); return { from: s, to: addMonths(s, 3, -1) }; }
    case 'this_year': return { from: fy, to: addMonths(fy, 12, -1) };
    case 'ytd': return { from: fy, to: now };
    case 'last_year': { const s = addMonths(fy, -12); return { from: s, to: addDays(fy, -1) }; }
    case 'last_year_to_date': return { from: addMonths(fy, -12), to: minusYear(now) };
    case 'last_12_months': return { from: addMonths(mStart, -11), to: now };
    case 'today': return { from: now, to: now };
    default: return null;
  }
}

/**
 * Add comparison / percentage columns to rows that carry `n` value columns after the label.
 * opts: { labels, pctOf: [totals per value column] | null, compare: bool (value col 1 is the comparison), change, pct }
 */
function decorate(rows, { labels, tags = [], pctOf = null, compare = false, change = false, pct = false }) {
  const cols = [];
  labels.forEach((l, i) => { cols.push(money(l)); if (pctOf) cols.push(percent(`% of Income${compare ? (i ? ` (${tags[i]})` : '') : labels.length > 1 ? ` (${l})` : ''}`)); });
  if (compare && change) cols.push(money('$ Change'));
  if (compare && pct) cols.push(percent('% Change'));
  const pctVal = (a, b) => (a === null || a === undefined || !b ? null : Math.round((a / Math.abs(b)) * 1000) / 10);
  for (const r of rows) {
    const vals = r.cells.slice(1);
    const out = [r.cells[0]];
    vals.forEach((v, i) => { out.push(v); if (pctOf) out.push(v === null ? null : pctVal(v, pctOf[i])); });
    const [a, b] = vals;
    if (compare && change) out.push(a === null ? null : a - (b ?? 0));
    if (compare && pct) out.push(a === null ? null : pctVal(a - (b ?? 0), b));
    r.cells = out;
  }
  return cols;
}

export function profitAndLoss(db, company, q) {
  const { from, to, basis = 'accrual', columns: colMode = 'total', compare, show_change = '1', show_pct = '1', pct_income, customer_id, vendor_id, show_zero } = q;
  const byId = accountsById(db, company.id);
  const filter = { customer_id, vendor_id };
  const comparing = !!compare && colMode === 'total';
  let cols = periodColumns(from, to, colMode);
  if (comparing) { const c = comparisonRange(from, to, compare); cols = [{ label: fmtShortRange(from, to), tag: '', from, to }, { from: c.from, to: c.to, label: `${fmtShortRange(c.from, c.to)} (${c.label})`, tag: c.label }]; }
  const nets = cols.map((c) => pnlNet(db, company.id, c.from, c.to, basis, byId, filter));
  const of = (types) => sortAccounts([...byId.values()].filter((a) => types.includes(a.type) && (a.is_active || nets.some((m) => m.get(a.id)))), byId);
  const asSigned = (types) => nets.map((m) => new Map([...m].filter(([id]) => types.includes(byId.get(id)?.type)).map(([id, v]) => [id, ACCOUNT_TYPES[byId.get(id).type].cls === 'income' ? -v : v])));
  const rows = [];
  const sec = (types, label, totalLabel) => { const r = sectionRows(of(types), asSigned(types), byId, { label, totalLabel, showZero: show_zero === '1' }); rows.push(...r.rows); return r.totals; };
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
  if (rows.some((r) => r.cells[0] === 'Total Other Income' || r.cells[0] === 'Total Other Expenses')) rows.push({ cells: ['Net Other Income', ...noth], kind: 'total', depth: 0 });
  const ni = noi.map((v, i) => v + noth[i]);
  rows.push({ cells: ['Net Income', ...ni], kind: 'grand', depth: 0 });
  const columns = decorate(rows, { labels: cols.map((c) => c.label), tags: cols.map((c) => c.tag), pctOf: pct_income === '1' ? inc : null, compare: comparing, change: show_change === '1', pct: show_pct === '1' });
  const names = filterLabel(db, filter);
  return { title: 'Profit and Loss', subtitle: `${fmtRange(from, to)} · ${basis === 'cash' ? 'Cash' : 'Accrual'} basis${names}`, columns: [text(''), ...columns], rows, netIncome: ni[0] };
}

function filterLabel(db, f) {
  const parts = [];
  if (f.customer_id) parts.push(db.get('SELECT display_name AS n FROM customers WHERE id = ?', Number(f.customer_id))?.n);
  if (f.vendor_id) parts.push(db.get('SELECT display_name AS n FROM vendors WHERE id = ?', Number(f.vendor_id))?.n);
  return parts.filter(Boolean).length ? ` · ${parts.filter(Boolean).join(', ')}` : '';
}

/** Net income (accrual) for a date range, in cents (positive = profit). */
export function netIncome(db, companyId, from, to) {
  const r = db.get(`SELECT COALESCE(SUM(j.credit - j.debit),0) AS ni FROM journal_lines j JOIN accounts a ON a.id = j.account_id
    WHERE j.company_id = ? AND j.date >= ? AND j.date <= ? AND a.type IN ('income','cost_of_goods_sold','expense','other_income','other_expense')`, companyId, from, to);
  return r.ni;
}

export function balanceSheet(db, company, q) {
  const { asof, compare, show_change = '1', show_pct = '1', show_zero } = q;
  const byId = accountsById(db, company.id);
  const dates = compare ? [asof, compareAsOf(asof, compare)] : [asof];
  const re = systemAccount(db, company.id, 'RETAINED_EARNINGS');
  const per = dates.map((d) => {
    const fy = fiscalYearStart(company, d);
    return { cum: netByAccount(db, company.id, null, d), priorNI: netIncome(db, company.id, '0000-01-01', addDays(fy, -1)), curNI: netIncome(db, company.id, fy, d) };
  });
  const sum = (...arrs) => dates.map((_, i) => arrs.reduce((s, a) => s + a[i], 0));
  const of = (types) => sortAccounts([...byId.values()].filter((a) => types.includes(a.type)), byId);
  const rows = [];
  const blank = dates.map(() => null);
  const sec = (types, label, totalLabel, depth, withRe = false) => {
    const vals = per.map((p) => {
      const m = new Map([...p.cum].filter(([id]) => types.includes(byId.get(id)?.type)).map(([id, v]) => [id, signed(byId.get(id).type, Math.max(v, 0), Math.max(-v, 0))]));
      if (withRe) m.set(re.id, (m.get(re.id) ?? 0) + p.priorNI);
      return m;
    });
    const r = sectionRows(of(types), vals, byId, { label, totalLabel, depth, showZero: show_zero === '1' });
    rows.push(...r.rows);
    return r.totals;
  };
  rows.push({ cells: ['ASSETS', ...blank], kind: 'section', depth: 0 });
  rows.push({ cells: ['Current Assets', ...blank], kind: 'section', depth: 1 });
  const bank = sec(['bank'], 'Bank Accounts', 'Total Bank Accounts', 2);
  const ar = sec(['accounts_receivable'], 'Accounts Receivable', 'Total Accounts Receivable', 2);
  const oca = sec(['other_current_asset'], 'Other Current Assets', 'Total Other Current Assets', 2);
  rows.push({ cells: ['Total Current Assets', ...sum(bank, ar, oca)], kind: 'subtotal', depth: 1 });
  const fa = sec(['fixed_asset'], 'Fixed Assets', 'Total Fixed Assets', 1);
  const oa = sec(['other_asset'], 'Other Assets', 'Total Other Assets', 1);
  const assets = sum(bank, ar, oca, fa, oa);
  rows.push({ cells: ['TOTAL ASSETS', ...assets], kind: 'grand', depth: 0 });
  rows.push({ cells: ['LIABILITIES AND EQUITY', ...blank], kind: 'section', depth: 0 });
  rows.push({ cells: ['Liabilities', ...blank], kind: 'section', depth: 1 });
  rows.push({ cells: ['Current Liabilities', ...blank], kind: 'section', depth: 2 });
  const ap = sec(['accounts_payable'], 'Accounts Payable', 'Total Accounts Payable', 3);
  const cc = sec(['credit_card'], 'Credit Cards', 'Total Credit Cards', 3);
  const ocl = sec(['other_current_liability'], 'Other Current Liabilities', 'Total Other Current Liabilities', 3);
  rows.push({ cells: ['Total Current Liabilities', ...sum(ap, cc, ocl)], kind: 'subtotal', depth: 2 });
  const ltl = sec(['long_term_liability'], 'Long-Term Liabilities', 'Total Long-Term Liabilities', 2);
  const liab = sum(ap, cc, ocl, ltl);
  rows.push({ cells: ['Total Liabilities', ...liab], kind: 'subtotal', depth: 1 });
  const eq = sec(['equity'], 'Equity', 'Total Equity', 1, true);
  if (rows.at(-1).cells[0] !== 'Total Equity') rows.push({ cells: ['Equity', ...blank], kind: 'section', depth: 1 }, { cells: ['Total Equity', ...dates.map(() => 0)], kind: 'subtotal', depth: 1 });
  const curNI = per.map((p) => p.curNI);
  rows.splice(rows.length - 1, 0, { cells: ['Net Income', ...curNI], kind: 'row', depth: 2 });
  const eqTotal = sum(eq, curNI);
  rows[rows.length - 1].cells = ['Total Equity', ...eqTotal];
  const le = sum(liab, eqTotal);
  rows.push({ cells: ['TOTAL LIABILITIES AND EQUITY', ...le], kind: 'grand', depth: 0 });
  const labels = dates.map((d, i) => (i === 0 ? (compare ? fmtShort(d) : 'Total') : `${fmtShort(d)} (${compare === 'prior_year' ? 'PY' : 'PP'})`));
  const columns = decorate(rows, { labels, compare: !!compare, change: show_change === '1', pct: show_pct === '1' });
  return { title: 'Balance Sheet', subtitle: `As of ${fmtDate(asof)}`, columns: [text(''), ...columns], rows, check: { assets: assets[0], liabilitiesAndEquity: le[0] } };
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

export const GL_COLUMNS = {
  date: date('Date'), type: text('Transaction Type'), num: text('Num'), name: text('Name'), memo: text('Memo/Description'),
  split: text('Split'), debit: money('Debit'), credit: money('Credit'), amount: money('Amount'), balance: money('Balance'),
};
export const GL_DEFAULT_COLUMNS = ['date', 'type', 'num', 'name', 'memo', 'split', 'debit', 'credit', 'balance'];

export function generalLedger(db, company, q) {
  const { from, to, customer_id, vendor_id, sort = 'date', hide_empty } = q;
  const ids = String(q.account_id ?? '').split(',').map(Number).filter(Boolean);
  const keys = String(q.cols || GL_DEFAULT_COLUMNS.join(',')).split(',').filter((k) => GL_COLUMNS[k]);
  if (!keys.length) keys.push(...GL_DEFAULT_COLUMNS);
  const filter = { customer_id, vendor_id };
  const nf = nameFilter(filter);
  const byId = accountsById(db, company.id);
  const accounts = sortAccounts([...byId.values()].filter((a) => !ids.length || ids.includes(a.id)), byId);
  const fy = fiscalYearStart(company, from);
  const before = netByAccount(db, company.id, null, addDays(from, -1), filter);
  const beforePnl = netByAccount(db, company.id, fy, addDays(from, -1), filter);

  // "Split": the other account(s) on the same transaction.
  const splits = new Map();
  for (const r of db.all(`SELECT j.id, j.transaction_id, a.name, a.number FROM journal_lines j JOIN accounts a ON a.id = j.account_id
      WHERE j.transaction_id IN (SELECT DISTINCT transaction_id FROM journal_lines WHERE company_id = ? AND date >= ? AND date <= ?)`, company.id, from, to)) {
    if (!splits.has(r.transaction_id)) splits.set(r.transaction_id, []);
    splits.get(r.transaction_id).push(r);
  }
  const splitFor = (l) => {
    const others = [...new Set((splits.get(l.transaction_id) ?? []).filter((o) => o.id !== l.id && o.name !== byId.get(l.account_id).name).map((o) => `${o.number ? o.number + ' ' : ''}${o.name}`))];
    return others.length === 1 ? others[0] : others.length ? '-Split-' : '';
  };
  const project = (vals, label) => keys.map((k, i) => (i === 0 && label !== undefined ? label : vals[k] ?? null));
  const sorters = {
    date: null,
    num: (a, b) => String(a.number ?? '').localeCompare(String(b.number ?? ''), undefined, { numeric: true }),
    name: (a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')),
    amount: (a, b) => Math.abs(b.debit - b.credit) - Math.abs(a.debit - a.credit),
  };

  const rows = [];
  let gd = 0, gc = 0;
  for (const a of accounts) {
    const begNet = isPnl(a.type) ? beforePnl.get(a.id) ?? 0 : before.get(a.id) ?? 0;
    let lines = db.all(`SELECT j.*, t.type, t.number, t.memo AS txn_memo, COALESCE(c.display_name, v.display_name) AS name
      FROM journal_lines j JOIN transactions t ON t.id = j.transaction_id LEFT JOIN customers c ON c.id = j.customer_id LEFT JOIN vendors v ON v.id = j.vendor_id
      WHERE j.account_id = ? AND j.date >= ? AND j.date <= ?${nf.sql} ORDER BY j.date, j.transaction_id, j.id`, a.id, from, to, ...nf.p);
    const hideEmpty = hide_empty === undefined ? ids.length !== 1 : hide_empty === '1';
    if (!lines.length && (hideEmpty || (!begNet && ids.length !== 1))) continue;
    const sgn = (net) => (isDebitNormal(a.type) ? net : -net);
    let bal = sgn(begNet);
    const label = `${a.number ? a.number + ' ' : ''}${a.name}`;
    rows.push({ cells: project({}, label), kind: 'section', depth: 0, account_id: a.id });
    rows.push({ cells: project({ balance: bal }, 'Beginning Balance'), kind: 'row', depth: 1 });
    let td = 0, tc = 0;
    for (const l of lines) { bal += sgn(l.debit - l.credit); l.running = bal; td += l.debit; tc += l.credit; }
    if (sorters[sort]) lines = [...lines].sort(sorters[sort]);
    for (const l of lines) {
      rows.push({ cells: project({ date: l.date, type: TXN_TYPES[l.type]?.label ?? l.type, num: l.number, name: l.name, memo: l.memo ?? l.txn_memo, split: splitFor(l), debit: l.debit || null, credit: l.credit || null, amount: l.debit - l.credit, balance: sorters[sort] ? null : l.running }), kind: 'row', depth: 1, txn_id: l.transaction_id });
    }
    gd += td; gc += tc;
    rows.push({ cells: project({ debit: td, credit: tc, amount: td - tc, balance: bal }, `Total for ${a.name}`), kind: 'subtotal', depth: 0 });
  }
  if (accounts.length > 1) rows.push({ cells: project({ debit: gd, credit: gc, amount: gd - gc }, 'TOTAL'), kind: 'grand', depth: 0 });
  const single = ids.length === 1 ? byId.get(ids[0]) : null;
  return { title: single ? `Account QuickReport: ${single.name}` : 'General Ledger', subtitle: fmtRange(from, to) + filterLabel(db, filter) + (ids.length > 1 ? ` · ${ids.length} accounts` : ''), columns: keys.map((k) => GL_COLUMNS[k]), rows };
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
  const period = PERIODS[q.period] ? q.period : null;
  const resolved = period ? resolvePeriod(company, period, t) : null;
  const from = resolved?.from ?? (isDate(q.from) ? q.from : fiscalYearStart(company, t));
  const to = resolved?.to ?? (isDate(q.to) ? q.to : t);
  const asof = resolved?.to ?? (isDate(q.asof) ? q.asof : t);
  if (from > to) throw bad('Start date must be on or before end date');
  for (const k of ['compare']) if (q[k] && !['prior_year', 'prior_period'].includes(q[k])) throw bad(`Invalid ${k}`);
  const args = { ...q, from, to, asof, year: q.year };
  const fn = {
    profit_and_loss: profitAndLoss, balance_sheet: balanceSheet, cash_flow: cashFlow, trial_balance: trialBalance,
    general_ledger: generalLedger, journal: journalReport, transaction_list: transactionList, account_list: accountList,
    ar_aging: (d, c, a) => aging(d, c, { ...a, side: 'ar' }), ar_aging_detail: (d, c, a) => aging(d, c, { ...a, side: 'ar', detail: true }),
    ap_aging: (d, c, a) => aging(d, c, { ...a, side: 'ap' }), ap_aging_detail: (d, c, a) => aging(d, c, { ...a, side: 'ap', detail: true }),
    sales_by_customer: salesByCustomer, sales_by_item: salesByItem, expenses_by_vendor: expensesByVendor, vendor_1099: vendor1099, sales_tax: salesTax,
  }[name];
  const r = fn(db, company, args);
  const { format: _f, saved: _s, ...rest } = q;
  return { ...r, name, company: company.name, params: { ...rest, period: period ?? '', from, to, asof, basis: q.basis ?? 'accrual', columns: q.columns ?? 'total', account_id: q.account_id ?? '', year: q.year ?? t.slice(0, 4) } };
}

export function dashboard(db, company) {
  const t = today();
  const fy = fiscalYearStart(company, t);
  const banks = db.all(`SELECT a.id, a.name, a.type, COALESCE(SUM(j.debit),0) AS d, COALESCE(SUM(j.credit),0) AS c,
      (SELECT COUNT(*) FROM bank_feed f WHERE f.account_id = a.id AND f.status='review') AS to_review,
      (SELECT MAX(r.statement_date) FROM reconciliations r WHERE r.account_id = a.id) AS last_reconciled,
      (SELECT MAX(i.at) FROM bank_imports i WHERE i.account_id = a.id) AS last_import_at,
      (SELECT MAX(f.date) FROM bank_feed f WHERE f.account_id = a.id) AS data_through
    FROM accounts a LEFT JOIN journal_lines j ON j.account_id = a.id
    WHERE a.company_id = ? AND a.type IN ('bank','credit_card') AND a.is_active = 1 GROUP BY a.id ORDER BY a.type, a.name`, company.id)
    .map((a) => ({ id: a.id, name: a.name, type: a.type, balance: signed(a.type, a.d, a.c), to_review: a.to_review, last_reconciled: a.last_reconciled, last_import_at: a.last_import_at, data_through: a.data_through }));
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
  for (const r of report.rows) lines.push(r.cells.map((v, i) => (report.columns[i]?.type === 'money' && typeof v === 'number' ? (v / 100).toFixed(2) : report.columns[i]?.type === 'percent' && typeof v === 'number' ? `${v}%` : (i === 0 ? '  '.repeat(r.depth ?? 0) : '') + (v ?? ''))));
  return lines.map((l) => l.map(esc).join(',')).join('\r\n') + '\r\n';
}

function fmtDate(iso) { const [y, m, d] = iso.split('-'); return `${new Date(Date.UTC(+y, +m - 1, +d)).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })} ${+d}, ${y}`; }
function fmtShort(iso) { const [y, m, d] = iso.split('-'); return `${new Date(Date.UTC(+y, +m - 1, +d)).toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })} ${+d}, ${y}`; }
function fmtShortRange(a, b) { return a === b ? fmtShort(a) : `${fmtShort(a)} – ${fmtShort(b)}`; }
function fmtRange(a, b) { return `${fmtDate(a)} – ${fmtDate(b)}`; }
