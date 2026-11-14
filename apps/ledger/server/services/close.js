// Month-end close checklist. Automatic checks are computed live from the books; manual sign-offs and notes are stored.
import { bad, str, addDays } from '../util.js';
import { signed, systemAccount } from './accounts.js';
import { fiscalYearStart, openItemsAsOf } from './reports.js';
import { audit } from './audit.js';

export const MANUAL_CHECKS = [
  ['review_pl', 'Reviewed the Profit and Loss for unusual or misclassified items'],
  ['review_bs', 'Reviewed the Balance Sheet (loans, credit cards, equity look right)'],
  ['review_ar_ap', 'Reviewed A/R and A/P aging with the client'],
  ['filings', 'Sales tax, payroll and other filings for the month are handled (or not applicable)'],
  ['package_sent', 'Sent the client their report package'],
];

const monthEnd = (period) => { const [y, m] = period.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
const validPeriod = (p) => /^\d{4}-(0[1-9]|1[0-2])$/.test(p ?? '');
const prevPeriod = (p) => { const [y, m] = p.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; };
const nextPeriod = (p) => { const [y, m] = p.split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`; };

/** The month you'd normally be closing now: the one after the closing date, or last month. */
export function defaultPeriod(company, today = new Date().toISOString().slice(0, 10)) {
  const lastMonth = prevPeriod(today.slice(0, 7));
  if (company.closing_date) { const n = nextPeriod(company.closing_date.slice(0, 7)); return n <= lastMonth ? n : lastMonth; }
  return lastMonth;
}

function stored(db, companyId, period) {
  const r = db.get('SELECT * FROM close_periods WHERE company_id = ? AND period = ?', companyId, period);
  return r ? { ...r, checks: JSON.parse(r.checks) } : { checks: {}, notes: null, closed_at: null };
}

export function closeStatus(db, company, period) {
  if (!validPeriod(period)) throw bad('Period must look like 2026-10');
  const end = monthEnd(period);
  const start = `${period}-01`;
  const cid = company.id;
  const items = [];

  // 1. Every bank and card account with activity is reconciled through month end.
  const accts = db.all(`SELECT a.id, a.name, a.type,
      (SELECT MAX(statement_date) FROM reconciliations r WHERE r.account_id = a.id) AS last_rec,
      (SELECT COUNT(*) FROM journal_lines j WHERE j.account_id = a.id AND j.date <= ?) AS n,
      (SELECT COALESCE(SUM(debit),0) FROM journal_lines j WHERE j.account_id = a.id AND j.date <= ?) AS d,
      (SELECT COALESCE(SUM(credit),0) FROM journal_lines j WHERE j.account_id = a.id AND j.date <= ?) AS c
    FROM accounts a WHERE a.company_id = ? AND a.type IN ('bank','credit_card') AND a.is_active = 1 ORDER BY a.type, a.name`, end, end, end, cid).filter((a) => a.n > 0);
  const unrec = accts.filter((a) => !a.last_rec || a.last_rec < end);
  items.push({ key: 'reconciled', required: true, status: unrec.length ? 'todo' : 'ok', title: 'Bank and credit card accounts reconciled through month end',
    detail: accts.length ? accts.map((a) => ({ text: `${a.name}: ${a.last_rec ? `reconciled through ${a.last_rec}` : 'never reconciled'}`, ok: !!a.last_rec && a.last_rec >= end, link: `reconcile/${a.id}` })) : [{ text: 'No bank or card activity yet', ok: true }] });

  // 2. Nothing left to review in the bank feed for the month.
  const feed = db.all(`SELECT f.account_id, a.name, COUNT(*) AS n FROM bank_feed f JOIN accounts a ON a.id = f.account_id WHERE f.company_id = ? AND f.status = 'review' AND f.date <= ? GROUP BY f.account_id`, cid, end);
  items.push({ key: 'feed', required: true, status: feed.length ? 'todo' : 'ok', title: 'Bank feed: nothing left "For review" through month end',
    detail: feed.map((f) => ({ text: `${f.name}: ${f.n} to review`, ok: false, link: `banking?account=${f.account_id}` })) });

  // 3. Uncategorized income/expense cleared for the fiscal year to date.
  const fy = fiscalYearStart(company, end);
  const unc = ['UNCATEGORIZED_EXPENSE', 'UNCATEGORIZED_INCOME'].map((k) => systemAccount(db, cid, k)).map((a) => ({ a, bal: db.get('SELECT COALESCE(SUM(debit - credit),0) AS b FROM journal_lines WHERE account_id = ? AND date >= ? AND date <= ?', a.id, fy, end).b })).filter((x) => x.bal !== 0);
  items.push({ key: 'uncategorized', required: true, status: unc.length ? 'todo' : 'ok', title: 'Nothing left in Uncategorized Income or Expense',
    detail: unc.map((x) => ({ text: `${x.a.name}: ${(Math.abs(x.bal) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })}`, ok: false, link: `reports/general_ledger?account_id=${x.a.id}&from=${fy}&to=${end}` })) });

  // 4. Undeposited funds received by month end have been deposited.
  const uf = systemAccount(db, cid, 'UNDEPOSITED');
  const ufBal = db.get('SELECT COALESCE(SUM(debit - credit),0) AS b FROM journal_lines WHERE account_id = ? AND date <= ?', uf.id, end).b;
  items.push({ key: 'undeposited', required: false, status: ufBal ? 'warn' : 'ok', title: 'Undeposited Funds deposited',
    detail: ufBal ? [{ text: `${(ufBal / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })} received but not yet deposited as of ${end}. Fine if it was deposited after month end.`, ok: false, link: 'new/deposit' }] : [] });

  // 5. No negative bank balances.
  const neg = accts.filter((a) => a.type === 'bank' && signed(a.type, a.d, a.c) < 0);
  items.push({ key: 'negative_bank', required: false, status: neg.length ? 'warn' : 'ok', title: 'No bank account below zero at month end',
    detail: neg.map((a) => ({ text: `${a.name} is negative — usually a missing deposit or a duplicate expense`, ok: false, link: `reports/general_ledger?account_id=${a.id}&from=${start}&to=${end}` })) });

  // 6. Opening Balance Equity cleared (informational).
  const obe = systemAccount(db, cid, 'OPENING_EQUITY');
  const obeBal = db.get('SELECT COALESCE(SUM(credit - debit),0) AS b FROM journal_lines WHERE account_id = ? AND date <= ?', obe.id, end).b;
  items.push({ key: 'obe', required: false, status: obeBal ? 'warn' : 'ok', title: 'Opening Balance Equity is zero (moved to owner\'s equity / retained earnings)',
    detail: obeBal ? [{ text: `Balance ${(obeBal / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })}. Close it to the right equity account with a journal entry once opening balances are final.`, ok: false, link: 'new/journal_entry' }] : [] });

  // 7. Aging facts for the manual review.
  const ar = openItemsAsOf(db, cid, 'ar', end).filter((i) => i.type === 'invoice');
  const ap = openItemsAsOf(db, cid, 'ap', end).filter((i) => i.type === 'bill');
  const usd = (c) => (c / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  const facts = {
    ar_open: ar.reduce((s, i) => s + i.open, 0), ar_overdue: ar.filter((i) => i.days > 0).reduce((s, i) => s + i.open, 0), ar_over_90: ar.filter((i) => i.days > 90).length,
    ap_open: ap.reduce((s, i) => s + i.open, 0), ap_overdue: ap.filter((i) => i.days > 0).reduce((s, i) => s + i.open, 0),
  };

  const st = stored(db, cid, period);
  const manual = MANUAL_CHECKS.map(([key, title]) => ({ key, title, done: !!st.checks[key]?.done, by: st.checks[key]?.by ?? null, at: st.checks[key]?.at ?? null,
    hint: key === 'review_ar_ap' ? `A/R ${usd(facts.ar_open)} open (${usd(facts.ar_overdue)} overdue${facts.ar_over_90 ? `, ${facts.ar_over_90} over 90 days` : ''}) · A/P ${usd(facts.ap_open)} open (${usd(facts.ap_overdue)} overdue)` : null }));
  const required = items.filter((i) => i.required);
  const doneCount = required.filter((i) => i.status === 'ok').length + manual.filter((m) => m.done).length;
  const totalCount = required.length + manual.length;
  const closedThrough = company.closing_date;
  return {
    period, start, end, items, manual, notes: st.notes ?? '',
    closed: !!closedThrough && closedThrough >= end, closed_at: st.closed_at, closing_date: closedThrough,
    ready: required.every((i) => i.status === 'ok') && manual.every((m) => m.done),
    progress: { done: doneCount, total: totalCount }, facts,
    prev: prevPeriod(period), next: nextPeriod(period),
  };
}

export function saveCloseChecks(db, company, period, body, user) {
  if (!validPeriod(period)) throw bad('Invalid period');
  const st = stored(db, company.id, period);
  const checks = { ...st.checks };
  for (const [key] of MANUAL_CHECKS) {
    if (body.checks?.[key] === undefined) continue;
    checks[key] = body.checks[key] ? { done: true, by: user.name, at: new Date().toISOString() } : { done: false };
  }
  const notes = body.notes === undefined ? st.notes : str(body.notes, 5000);
  db.run(`INSERT INTO close_periods (company_id, period, checks, notes) VALUES (?,?,?,?)
    ON CONFLICT(company_id, period) DO UPDATE SET checks = excluded.checks, notes = excluded.notes`, company.id, period, JSON.stringify(checks), notes);
  return closeStatus(db, db.get('SELECT * FROM companies WHERE id = ?', company.id), period);
}

/** Close the month: sets the company closing date to month end (never moves it backwards). */
export function closePeriod(db, company, period, { override = false } = {}, user) {
  const s = closeStatus(db, company, period);
  if (s.closed) throw bad(`The books are already closed through ${company.closing_date}`);
  if (!s.ready && !override) throw bad('Some checklist items are still open. Finish them, or confirm closing anyway.');
  db.tx(() => {
    db.run('UPDATE companies SET closing_date = ? WHERE id = ?', s.end, company.id);
    db.run(`INSERT INTO close_periods (company_id, period, checks, closed_at, closed_by, prev_closing_date) VALUES (?,?,?,datetime('now'),?,?)
      ON CONFLICT(company_id, period) DO UPDATE SET closed_at = datetime('now'), closed_by = excluded.closed_by, prev_closing_date = excluded.prev_closing_date`, company.id, period, '{}', user.id, company.closing_date ?? null);
    audit(db, { companyId: company.id, userId: user.id, action: 'close', entity: 'closing_date', summary: `Closed ${period}${!s.ready ? ' with open checklist items' : ''}; closing date ${company.closing_date ?? 'none'} → ${s.end}` });
  });
  return closeStatus(db, db.get('SELECT * FROM companies WHERE id = ?', company.id), period);
}

/** Reopen a closed month: moves the closing date back to the end of the previous month. */
export function reopenPeriod(db, company, period, user) {
  const end = monthEnd(period);
  if (!company.closing_date || company.closing_date < end) throw bad('That month is not closed');
  if (company.closing_date > end) throw bad(`Later months are closed too (through ${company.closing_date}). Reopen the latest month first.`);
  // Restore the closing date from before this month was closed; if it was set by hand, step back one month.
  const rec = db.get('SELECT prev_closing_date, closed_at FROM close_periods WHERE company_id = ? AND period = ?', company.id, period);
  const restore = rec?.closed_at ? rec.prev_closing_date : addDays(`${period}-01`, -1);
  db.tx(() => {
    db.run('UPDATE companies SET closing_date = ? WHERE id = ?', restore ?? null, company.id);
    db.run('UPDATE close_periods SET closed_at = NULL WHERE company_id = ? AND period = ?', company.id, period);
    audit(db, { companyId: company.id, userId: user.id, action: 'reopen', entity: 'closing_date', summary: `Reopened ${period}; closing date ${company.closing_date} → ${restore ?? 'none'}` });
  });
  return closeStatus(db, db.get('SELECT * FROM companies WHERE id = ?', company.id), period);
}

/** One line per company for the companies page: where each client's close stands. */
export function closeOverview(db) {
  return db.all('SELECT * FROM companies ORDER BY name').map((c) => {
    const period = defaultPeriod(c);
    try {
      const s = closeStatus(db, c, period);
      return { company_id: c.id, period, closing_date: c.closing_date, closed: s.closed, ready: s.ready, progress: s.progress };
    } catch { return { company_id: c.id, period, closing_date: c.closing_date }; }
  });
}

