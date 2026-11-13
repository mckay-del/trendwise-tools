import { html, raw, esc, money, num, parseMoney, fmtDate, today, on, $, $$, options, field, toast, modal, dataTable, confirmDialog } from '../ui.js';

const DETAIL_TYPES = {
  bank: ['Checking', 'Savings', 'Money Market', 'Cash on hand'],
  other_current_asset: ['Prepaid Expenses', 'Inventory', 'Loans to Others', 'Employee Cash Advances', 'Other Current Assets'],
  fixed_asset: ['Furniture & Fixtures', 'Machinery & Equipment', 'Vehicles', 'Buildings', 'Land', 'Accumulated Depreciation', 'Leasehold Improvements'],
  other_asset: ['Security Deposits', 'Intangible Assets', 'Accumulated Amortization', 'Other Long-term Assets'],
  credit_card: ['Credit Card'],
  other_current_liability: ['Payroll Liabilities', 'Sales Tax Payable', 'Line of Credit', 'Loan Payable', 'Other Current Liabilities'],
  long_term_liability: ['Notes Payable', 'Shareholder Notes Payable', 'Other Long Term Liabilities'],
  equity: ["Owner's Equity", 'Partner Contributions', 'Partner Distributions', 'Common Stock', 'Retained Earnings', 'Opening Balance Equity'],
  income: ['Service/Fee Income', 'Sales of Product Income', 'Discounts/Refunds Given', 'Other Primary Income'],
  cost_of_goods_sold: ['Supplies & Materials - COGS', 'Cost of Labor - COS', 'Shipping, Freight & Delivery - COS'],
  expense: ['Advertising/Promotional', 'Auto', 'Bank Charges', 'Dues & Subscriptions', 'Insurance', 'Legal & Professional Fees', 'Meals', 'Office/General Administrative', 'Payroll Expenses', 'Rent or Lease of Buildings', 'Repair & Maintenance', 'Taxes Paid', 'Travel', 'Utilities', 'Other Business Expenses'],
  other_income: ['Interest Earned', 'Other Miscellaneous Income'],
  other_expense: ['Depreciation', 'Amortization', 'Penalties & Settlements', 'Other Miscellaneous Expense'],
};

function accountForm(ctx, a, accounts) {
  const types = ctx.meta.account_types;
  const type = a.type ?? 'expense';
  const parents = accounts.filter((x) => x.type === type && x.id !== a.id);
  return html`<div class="form-grid">
    ${raw(field('Account type', html`<select name="type" data-type ${a.system_key ? raw('disabled') : ''}>${raw(Object.entries(types).map(([k, v]) => html`<option value="${k}" ${k === type ? raw('selected') : ''}>${v.label}</option>`).join(''))}</select>`))}
    ${raw(field('Detail type', html`<select name="detail_type" data-detail>${raw(options((DETAIL_TYPES[type] ?? []).map((d) => ({ id: d, name: d })), a.detail_type, { blank: '—' }))}</select>`))}
    ${raw(field('Name *', html`<input name="name" required value="${a.name ?? ''}" autofocus>`))}
    ${raw(field('Number', html`<input name="number" value="${a.number ?? ''}">`))}
    ${raw(field('Sub-account of', html`<select name="parent_id" data-parent>${raw(options(parents, a.parent_id, { blank: '— top level —', label: (x) => `${x.number ? x.number + ' ' : ''}${x.name}` }))}</select>`))}
    ${raw(field('Description', html`<input name="description" value="${a.description ?? ''}">`))}
  </div>`;
}

export async function editAccount(ctx, a = {}) {
  const accounts = await ctx.capi.accounts();
  return new Promise((resolve) => {
    const m = modal({
      title: a.id ? `Edit ${a.name}` : 'New account', body: accountForm(ctx, a, accounts), wide: true,
      onSubmit: async (d) => {
        const body = { ...d, parent_id: d.parent_id || null, type: d.type ?? a.type };
        const r = a.id ? await ctx.capi.put(`/accounts/${a.id}`, body) : await ctx.capi.post('/accounts', body);
        toast('Account saved'); resolve(r);
      },
    });
    m.el.querySelector('[data-type]')?.addEventListener('change', (e) => {
      const t = e.target.value;
      m.el.querySelector('[data-detail]').innerHTML = options((DETAIL_TYPES[t] ?? []).map((d) => ({ id: d, name: d })), null, { blank: '—' });
      m.el.querySelector('[data-parent]').innerHTML = options(accounts.filter((x) => x.type === t && x.id !== a.id), null, { blank: '— top level —', label: (x) => x.name });
    });
  });
}

export async function chart(ctx) {
  ctx.setTitle('Chart of accounts');
  const inactive = ctx.query.inactive === '1';
  const rows = await ctx.capi.get('/accounts', { inactive: inactive ? '1' : '' });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const depth = (a) => { let d = 0, p = a.parent_id; while (p && byId.has(p) && d < 5) { d++; p = byId.get(p).parent_id; } return d; };
  const regLink = (a) => (a.cls === 'income' || a.cls === 'expense' ? 'Run report' : 'View register');
  const render = (list) => dataTable(list, [
    { key: 'number', label: 'Number' },
    { key: 'name', label: 'Name', render: (a) => html`<span style="padding-left:${depth(a) * 18}px">${a.name}</span>${a.system_key ? raw(' <span class="badge badge-muted" title="Used automatically by the system">system</span>') : ''}${a.is_active ? '' : raw(' <span class="badge badge-muted">Inactive</span>')}` },
    { key: 'type_label', label: 'Type' }, { key: 'detail_type', label: 'Detail type' },
    { key: 'balance', label: 'Balance', type: 'money', render: (a) => (a.cls === 'income' || a.cls === 'expense' ? '' : esc(money(a.balance))) },
    { key: 'x', label: '', render: (a) => html`<a class="link" href="${ctx.chref('reports/general_ledger')}?account_id=${a.id}">${regLink(a)}</a> · <button class="link" data-edit="${a.id}">Edit</button>${!a.system_key ? raw(html` · <button class="link" data-toggle="${a.id}">${a.is_active ? 'Make inactive' : 'Make active'}</button>`) : ''}${['bank', 'credit_card'].includes(a.type) ? raw(html` · <a class="link" href="${ctx.chref('reconcile/' + a.id)}">Reconcile</a>`) : ''}` },
  ]);
  ctx.el.innerHTML = html`<div class="page">
    <div class="page-head"><h1>Chart of accounts</h1><div class="btn-row"><a class="btn" href="${ctx.chref('reports/account_list')}">Run report</a><button class="btn btn-primary" data-action="new">New account</button></div></div>
    <div class="filters"><input type="search" data-filter placeholder="Filter by name or number" aria-label="Filter"><label class="check"><input type="checkbox" data-inactive ${inactive ? 'checked' : ''}> Include inactive</label></div>
    <div data-list>${raw(render(rows))}</div>
  </div>`;
  on(ctx.el, 'input', '[data-filter]', (e, el) => { const q = el.value.toLowerCase(); $('[data-list]', ctx.el).innerHTML = render(rows.filter((a) => `${a.number ?? ''} ${a.name} ${a.type_label}`.toLowerCase().includes(q))); });
  on(ctx.el, 'change', '[data-inactive]', (e, el) => ctx.navigate(ctx.cpath('accounts'), { inactive: el.checked ? '1' : '' }));
  on(ctx.el, 'click', '[data-action=new]', async () => { await editAccount(ctx); ctx.reload(); });
  on(ctx.el, 'click', '[data-edit]', async (e, b) => { await editAccount(ctx, byId.get(Number(b.dataset.edit))); ctx.reload(); });
  on(ctx.el, 'click', '[data-toggle]', async (e, b) => {
    const a = byId.get(Number(b.dataset.toggle));
    try { await ctx.capi.put(`/accounts/${a.id}`, { is_active: !a.is_active }); toast(a.is_active ? 'Account made inactive' : 'Account made active'); ctx.reload(); }
    catch (ex) { toast(ex.message, 'error'); }
  });
}

// --- Reconcile -----------------------------------------------------------------

export async function reconcileStart(ctx) {
  ctx.setTitle('Reconcile');
  const accounts = (await ctx.capi.accounts()).filter((a) => ['bank', 'credit_card', 'other_current_asset', 'other_current_liability', 'long_term_liability'].includes(a.type) && a.system_key !== 'UNDEPOSITED');
  ctx.el.innerHTML = html`<div class="page narrow">
    <div class="page-head"><h1>Reconcile an account</h1></div>
    <section class="card"><form class="stack" data-form="start">
      ${raw(field('Account', html`<select name="account">${raw(options(accounts, ctx.query.account, { label: (a) => `${a.name} (${money(a.balance)})`, group: (a) => a.type_label }))}</select>`))}
      <button class="btn btn-primary">Continue</button></form></section></div>`;
  on(ctx.el, 'submit', '[data-form=start]', (e, f) => { e.preventDefault(); ctx.navigate(ctx.cpath('reconcile/' + f.account.value)); });
}

export async function reconcile(ctx) {
  const id = Number(ctx.params.id);
  const draftKey = `ledger.recon.${ctx.company.id}.${id}`;
  let draft = {};
  try { draft = JSON.parse(localStorage.getItem(draftKey) ?? '{}'); } catch { /* ignore */ }
  const stmtDate = ctx.query.statement_date ?? draft.statement_date ?? '';
  const ending = ctx.query.ending ?? draft.ending ?? '';
  const st = await ctx.capi.get(`/reconcile/${id}`, stmtDate ? { statement_date: stmtDate } : {});
  ctx.setTitle(`Reconcile ${st.account.name}`);
  const isCard = !st.debit_normal;

  if (!stmtDate || ending === '' || ctx.query.edit) {
    ctx.el.innerHTML = html`<div class="page narrow">
      <div class="crumbs"><a href="${ctx.chref('reconcile')}">Reconcile</a> ›</div>
      <div class="page-head"><h1>Reconcile ${st.account.name}</h1></div>
      <section class="card"><p>Open the statement for this account and enter the following.</p><form class="form-grid" data-form="stmt">
        ${raw(field('Beginning balance', html`<input disabled value="${money(st.beginning_balance)}">`, { hint: 'Ending balance of your last reconciliation' }))}
        ${raw(field('Ending balance *', html`<input name="ending" required inputmode="decimal" value="${ending}">`))}
        ${raw(field('Ending date *', html`<input name="statement_date" type="date" required value="${stmtDate || today()}">`))}
        <div class="span-2"><button class="btn btn-primary">Start reconciling</button></div></form></section>
      ${raw(history(ctx, st))}
    </div>`;
    on(ctx.el, 'submit', '[data-form=stmt]', (e, f) => {
      e.preventDefault();
      try { localStorage.setItem(draftKey, JSON.stringify({ ...draft, statement_date: f.statement_date.value, ending: f.ending.value })); } catch { /* ignore */ }
      ctx.navigate(ctx.cpath('reconcile/' + id), { statement_date: f.statement_date.value, ending: f.ending.value });
    });
    wireHistory(ctx, st, id);
    return;
  }

  const endC = parseMoney(ending);
  const outLabel = isCard ? 'Charges' : 'Payments';
  const inLabel = isCard ? 'Payments' : 'Deposits';
  ctx.el.innerHTML = html`<div class="page">
    <div class="crumbs"><a href="${ctx.chref('reconcile')}">Reconcile</a> › <a href="${ctx.chref('reconcile/' + id)}?edit=1">${st.account.name}</a></div>
    <div class="page-head"><h1>Reconcile ${st.account.name}</h1><span class="muted">Statement ending ${fmtDate(stmtDate)}</span></div>
    <div class="recon-summary" data-summary></div>
    <div class="filters"><label class="check"><input type="checkbox" data-all> Select all</label><span class="spacer"></span><button class="btn" data-action="edit-info">Edit info</button><button class="btn" data-action="later">Save for later</button><button class="btn btn-primary" data-action="finish" disabled>Finish now</button></div>
    ${raw(st.lines.length ? html`<div class="table-wrap"><table class="grid recon"><thead><tr><th>Date</th><th>Type</th><th>Ref no.</th><th>Payee</th><th>Memo</th><th class="num">${outLabel} (out)</th><th class="num">${inLabel} (in)</th><th class="center">✓</th></tr></thead><tbody>
      ${raw(st.lines.map((l) => html`<tr data-line="${l.id}" data-amt="${l.amount}" class="${l.cleared ? 'cleared' : ''}"><td>${fmtDate(l.date)}</td><td><a href="${ctx.chref('txn/' + l.transaction_id)}">${l.type_label}</a></td><td>${l.number ?? ''}</td><td>${l.payee ?? ''}</td><td class="clip">${l.memo ?? ''}</td>
        <td class="num">${l.amount < 0 ? money(-l.amount) : ''}</td><td class="num">${l.amount > 0 ? money(l.amount) : ''}</td><td class="center"><input type="checkbox" data-clear ${l.cleared ? raw('checked') : ''} aria-label="Cleared"></td></tr>`).join(''))}
    </tbody></table></div>` : html`<div class="empty">No uncleared transactions dated on or before ${fmtDate(stmtDate)}.</div>`)}
  </div>`;

  const summary = () => {
    const sel = $$('tr[data-line]', ctx.el).filter((tr) => tr.querySelector('[data-clear]').checked);
    const ins = sel.reduce((s, tr) => s + Math.max(0, Number(tr.dataset.amt)), 0);
    const outs = sel.reduce((s, tr) => s + Math.max(0, -Number(tr.dataset.amt)), 0);
    const cleared = st.beginning_balance + ins - outs;
    const diff = endC - cleared;
    $$('tr[data-line]', ctx.el).forEach((tr) => tr.classList.toggle('cleared', tr.querySelector('[data-clear]').checked));
    $('[data-summary]', ctx.el).innerHTML = html`
      <div><small>Statement ending balance</small><b>${money(endC)}</b></div>
      <div><small>Beginning balance</small><b>${money(st.beginning_balance)}</b></div>
      <div><small>${sel.filter((tr) => Number(tr.dataset.amt) < 0).length} ${outLabel.toLowerCase()}</small><b>-${money(outs)}</b></div>
      <div><small>${sel.filter((tr) => Number(tr.dataset.amt) > 0).length} ${inLabel.toLowerCase()}</small><b>+${money(ins)}</b></div>
      <div><small>Cleared balance</small><b>${money(cleared)}</b></div>
      <div class="${diff === 0 ? 'ok' : 'bad'} diff"><small>Difference</small><b>${money(diff)}</b></div>`;
    $('[data-action=finish]', ctx.el).disabled = diff !== 0;
    return sel.map((tr) => Number(tr.dataset.line));
  };
  summary();
  on(ctx.el, 'change', '[data-clear]', summary);
  on(ctx.el, 'click', 'tr[data-line] td', (e, td) => { if (e.target.closest('a,input')) return; const cb = td.parentElement.querySelector('[data-clear]'); cb.checked = !cb.checked; summary(); });
  on(ctx.el, 'change', '[data-all]', (e, cb) => { $$('[data-clear]', ctx.el).forEach((c) => { c.checked = cb.checked; }); summary(); });
  on(ctx.el, 'click', '[data-action=edit-info]', () => ctx.navigate(ctx.cpath('reconcile/' + id), { edit: '1' }));
  on(ctx.el, 'click', '[data-action=later]', async () => { await ctx.capi.put(`/reconcile/${id}`, { cleared_ids: summary() }); toast('Progress saved'); });
  on(ctx.el, 'click', '[data-action=finish]', async () => {
    try {
      await ctx.capi.post(`/reconcile/${id}/finish`, { statement_date: stmtDate, ending_balance: num(endC), cleared_ids: summary() });
      try { localStorage.removeItem(draftKey); } catch { /* ignore */ }
      toast('Reconciliation complete');
      ctx.navigate(ctx.cpath('reconcile/' + id), { statement_date: '' });
    } catch (ex) { toast(ex.message, 'error'); }
  });
}

function history(ctx, st) {
  if (!st.history.length) return '';
  return html`<h2>History</h2>${raw(dataTable(st.history, [
    { key: 'statement_date', label: 'Statement ending', type: 'date' },
    { key: 'beginning_balance', label: 'Beginning', type: 'money' }, { key: 'ending_balance', label: 'Ending', type: 'money' },
    { key: 'cleared_count', label: 'Items' }, { key: 'completed_at', label: 'Completed', render: (r) => esc(`${fmtDate(r.completed_at)} ${r.completed_by_name ? '· ' + r.completed_by_name : ''}`) },
    { key: 'u', label: '', render: (r) => (r === st.history[0] ? html`<button class="link danger" data-undo-recon>Undo</button>` : '') },
  ]))}`;
}

function wireHistory(ctx, st, id) {
  on(ctx.el, 'click', '[data-undo-recon]', async () => {
    if (!(await confirmDialog('Undo the most recent reconciliation? Its transactions go back to cleared (C) status.', { okLabel: 'Undo reconciliation' }))) return;
    try { await ctx.capi.post(`/reconcile/${id}/undo`); toast('Reconciliation undone'); ctx.reload(); } catch (ex) { toast(ex.message, 'error'); }
  });
}
