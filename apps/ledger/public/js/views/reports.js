import { html, raw, esc, money, fmtDate, on, options, field, modal, toast, confirmDialog, $, $$ } from '../ui.js';

const FEATURED = ['profit_and_loss', 'balance_sheet', 'general_ledger'];
const COMPARE = [{ id: '', name: 'None' }, { id: 'prior_year', name: 'Previous year (PY)' }, { id: 'prior_period', name: 'Previous period (PP)' }];

export async function index(ctx) {
  ctx.setTitle('Reports');
  const savedList = await ctx.capi.get('/saved-reports');
  const groups = new Map();
  for (const [k, r] of Object.entries(ctx.meta.reports)) { if (!groups.has(r.group)) groups.set(r.group, []); groups.get(r.group).push([k, r]); }
  const savedHref = (s) => `${ctx.chref('reports/' + s.report)}?${new URLSearchParams({ ...s.params, saved: s.id })}`;
  ctx.el.innerHTML = html`<div class="page">
    <div class="page-head"><h1>Reports</h1><a class="btn btn-primary" href="${ctx.chref('package')}">Client report package</a></div>
    <div class="featured">${raw(FEATURED.map((k) => html`<a class="featured-card" href="${ctx.chref('reports/' + k)}"><strong>${ctx.meta.reports[k].title}</strong><span class="muted">${{ profit_and_loss: 'Income and expenses, with comparisons', balance_sheet: 'What the company owns and owes', general_ledger: 'Every transaction by account' }[k]}</span></a>`).join(''))}</div>
    <section class="card"><h3>Saved reports <small>customized reports you can rerun with one click</small></h3>
      ${savedList.length ? raw(html`<div class="table-wrap"><table class="grid"><thead><tr><th>Name</th><th>Report</th><th>Period</th><th>Saved by</th><th></th></tr></thead><tbody>
        ${raw(savedList.map((s) => html`<tr><td><a href="${savedHref(s)}"><strong>${s.name}</strong></a></td><td>${s.report_title}</td><td>${ctx.meta.periods[s.params.period] ?? (s.params.from ? `${fmtDate(s.params.from)} – ${fmtDate(s.params.to)}` : s.params.asof ? `As of ${fmtDate(s.params.asof)}` : 'Default')}</td><td>${s.created_by_name ?? ''}</td>
          <td class="nowrap"><a class="link" href="${savedHref(s)}">Run</a> · <button class="link" data-rename="${s.id}">Rename</button> · <button class="link danger" data-del="${s.id}">Delete</button></td></tr>`).join(''))}</tbody></table></div>`)
        : raw('<p class="muted">Open a report, click <b>Customize</b>, then <b>Save customization</b>. Choose a relative period like “Last month” so it stays current.</p>')}
    </section>
    <div class="report-groups">${raw([...groups].map(([g, list]) => html`<section class="card"><h3>${g}</h3><ul class="report-links">${raw(list.map(([k, r]) => html`<li><a href="${ctx.chref('reports/' + k)}">${r.title}</a></li>`).join(''))}</ul></section>`).join(''))}</div>
  </div>`;
  on(ctx.el, 'click', '[data-del]', async (e, b) => {
    if (!(await confirmDialog('Delete this saved report?', { okLabel: 'Delete' }))) return;
    await ctx.capi.del(`/saved-reports/${b.dataset.del}`); toast('Deleted'); ctx.reload();
  });
  on(ctx.el, 'click', '[data-rename]', (e, b) => {
    const s = savedList.find((x) => x.id === Number(b.dataset.rename));
    modal({ title: 'Rename saved report', body: field('Name', html`<input name="name" required value="${s.name}" autofocus>`), onSubmit: async (d) => { await ctx.capi.put(`/saved-reports/${s.id}`, { name: d.name }); toast('Renamed'); ctx.reload(); } });
  });
}

/** Render a report object as a table. Shared with the client package view. */
export function reportTable(ctx, rep, { links = true } = {}) {
  const cell = (v, col) => {
    if (v === null || v === undefined || v === '') return '';
    if (col.type === 'money') return typeof v === 'number' ? html`<span class="${v < 0 ? 'neg' : ''}">${money(v)}</span>` : esc(v);
    if (col.type === 'percent') return typeof v === 'number' ? html`<span class="${v < 0 ? 'neg' : ''}">${v.toFixed(1)}%</span>` : esc(v);
    if (col.type === 'date') return /^\d{4}-\d{2}-\d{2}$/.test(v) ? esc(fmtDate(v)) : esc(v);
    return esc(v);
  };
  const p = rep.params;
  const body = rep.rows.map((r) => {
    let link = null;
    if (links && r.txn_id) link = ctx.chref('txn/' + r.txn_id);
    else if (links && r.account_id && rep.name !== 'general_ledger') {
      const isBs = rep.name === 'balance_sheet' || rep.name === 'trial_balance';
      link = `${ctx.chref('reports/general_ledger')}?${new URLSearchParams({ account_id: r.account_id, from: isBs ? p.asof.slice(0, 4) + '-01-01' : p.from, to: isBs ? p.asof : p.to, ...(p.customer_id ? { customer_id: p.customer_id } : {}), ...(p.vendor_id ? { vendor_id: p.vendor_id } : {}) })}`;
    }
    const labelOnly = r.cells.slice(1).every((v) => v === null || v === undefined || v === '');
    if (labelOnly && r.kind !== 'row') return html`<tr class="r-${r.kind}"><td colspan="${rep.columns.length}" style="padding-left:${0.6 + (r.depth ?? 0) * 1.1}rem">${r.cells[0]}</td></tr>`;
    return html`<tr class="r-${r.kind} ${link ? 'clickable' : ''}" ${link ? raw(html`data-href="${link}" tabindex="0"`) : ''}>${raw(r.cells.map((v, i) => html`<td class="${['money', 'percent'].includes(rep.columns[i]?.type) ? 'num' : ''}" ${i === 0 ? raw(`style="padding-left:${0.6 + (r.depth ?? 0) * 1.1}rem"`) : ''}>${raw(cell(v, rep.columns[i] ?? {}))}</td>`).join(''))}</tr>`;
  }).join('');
  if (!rep.rows.length) return '<div class="empty">No data for this period.</div>';
  return html`<div class="table-wrap"><table class="report-table"><thead><tr>${raw(rep.columns.map((c) => html`<th class="${['money', 'percent'].includes(c.type) ? 'num' : ''}">${c.label}</th>`).join(''))}</tr></thead><tbody>${raw(body)}</tbody></table></div>`;
}

export async function view(ctx) {
  const name = ctx.params.name;
  const def = ctx.meta.reports[name];
  if (!def) throw new Error('Unknown report');
  ctx.setTitle(def.title);
  const { saved: savedId, ...query } = ctx.query;
  const [rep, savedList] = await Promise.all([ctx.capi.get(`/reports/${name}`, query), savedId ? ctx.capi.get('/saved-reports') : []]);
  const savedRep = savedList.find((s) => String(s.id) === String(savedId));
  const p = rep.params;
  const range = def.params.includes('range');
  const asofParam = def.params.includes('asof');
  const periods = Object.entries(ctx.meta.periods).filter(([k]) => range || k !== 'last_12_months');

  const summary = customizeSummary(ctx, name, p);
  ctx.el.innerHTML = html`<div class="page">
    <div class="crumbs no-print"><a href="${ctx.chref('reports')}">Reports</a> ›${savedRep ? raw(html` <span>Saved: <b>${savedRep.name}</b></span>`) : ''}</div>
    <form class="filters report-controls" data-form="params">
      ${range || asofParam ? raw(html`<label>${range ? 'Report period' : 'As of'} <select name="period" data-period>${raw(options(periods.map(([id, n]) => ({ id, name: n })), p.period, { blank: 'Custom dates' }))}</select></label>`) : ''}
      ${range ? raw(html`<label data-custom>From <input type="date" name="from" value="${p.from}"></label><label data-custom>To <input type="date" name="to" value="${p.to}"></label>`) : ''}
      ${asofParam ? raw(html`<label data-custom>Date <input type="date" name="asof" value="${p.asof}"></label>`) : ''}
      ${def.params.includes('basis') ? raw(html`<label>Accounting method <select name="basis">${raw(options([{ id: 'accrual', name: 'Accrual' }, { id: 'cash', name: 'Cash' }], p.basis))}</select></label>`) : ''}
      ${def.params.includes('year') ? raw(html`<label>Tax year <input type="number" name="year" min="2000" max="2100" value="${p.year}"></label>`) : ''}
      <button class="btn btn-primary">Run report</button>
      ${def.customize ? raw('<button type="button" class="btn" data-action="customize">Customize</button>') : ''}
      <span class="spacer"></span>
      <button type="button" class="btn" data-action="save">${savedRep ? 'Save changes' : 'Save customization'}</button>
      <a class="btn" href="${ctx.capi.url(`/reports/${name}`, { ...query, format: 'csv' })}" download>Export CSV</a>
      <button type="button" class="btn" data-action="print">Print / PDF</button>
    </form>
    ${summary ? raw(html`<div class="custom-summary no-print">${raw(summary)} <button type="button" class="link" data-action="customize">Edit</button> · <button type="button" class="link" data-action="reset">Reset</button></div>`) : ''}
    <article class="report card">
      <header><h2>${ctx.company.name}</h2><h1>${savedRep?.name ?? rep.title}</h1><p>${rep.subtitle}</p></header>
      ${raw(reportTable(ctx, rep))}
      <footer class="muted">Generated ${new Date().toLocaleString()}</footer>
    </article>
  </div>`;

  const form = $('[data-form=params]', ctx.el);
  const syncCustom = () => $$('[data-custom]', form).forEach((l) => { l.hidden = !!form.period?.value; });
  syncCustom();
  form.period?.addEventListener('change', syncCustom);

  // Current state = everything in the URL plus the visible controls.
  const current = () => {
    const q = { ...query, ...Object.fromEntries(new FormData(form)) };
    if (q.period) { delete q.from; delete q.to; delete q.asof; }
    return Object.fromEntries(Object.entries(q).filter(([, v]) => v !== '' && v !== undefined));
  };
  const go = (q) => ctx.navigate(ctx.cpath('reports/' + name), { ...q, ...(savedId ? { saved: savedId } : {}) });

  form.addEventListener('submit', (e) => { e.preventDefault(); go(current()); });
  on(ctx.el, 'click', '[data-action=print]', () => window.print());
  on(ctx.el, 'click', '[data-action=reset]', () => { const q = current(); for (const k of ['compare', 'show_change', 'show_pct', 'pct_income', 'show_zero', 'customer_id', 'vendor_id', 'account_id', 'cols', 'sort', 'hide_empty', 'columns']) delete q[k]; go(q); });
  on(ctx.el, 'click', '[data-action=customize]', () => customize(ctx, name, p, (extra) => go({ ...current(), ...extra })));
  on(ctx.el, 'click', '[data-action=save]', () => {
    const params = current();
    if (savedRep) {
      return ctx.capi.put(`/saved-reports/${savedRep.id}`, { params }).then(() => toast(`Saved “${savedRep.name}”`), (e) => toast(e.message, 'error'));
    }
    modal({
      title: 'Save customization',
      body: html`${raw(field('Name', html`<input name="name" required autofocus placeholder="e.g. Monthly P&L vs prior year">`))}
        <p class="muted">${params.period ? raw(html`Period is saved as <b>${ctx.meta.periods[params.period]}</b>, so it updates automatically each time you run it.`) : 'Tip: choose a relative report period (like “Last month”) before saving so the dates stay current.'}</p>`,
      onSubmit: async (d) => { const s = await ctx.capi.post('/saved-reports', { name: d.name, report: name, params }); toast('Report saved'); ctx.navigate(ctx.cpath('reports/' + name), { ...s.params, saved: s.id }); },
    });
  });
}

function customizeSummary(ctx, name, p) {
  const bits = [];
  if (p.columns === 'months' || p.columns === 'quarters') bits.push(`Columns by ${p.columns}`);
  if (p.compare) bits.push(`Compared to ${p.compare === 'prior_year' ? 'previous year' : 'previous period'}`);
  if (p.pct_income === '1') bits.push('% of income');
  if (p.customer_id) bits.push('Filtered by customer');
  if (p.vendor_id) bits.push('Filtered by vendor');
  if (p.show_zero === '1') bits.push('All accounts shown');
  if (name === 'general_ledger') {
    const ids = String(p.account_id ?? '').split(',').filter(Boolean);
    if (ids.length) bits.push(`${ids.length} account${ids.length > 1 ? 's' : ''}`);
    if (p.cols) bits.push(`${p.cols.split(',').length} columns`);
    if (p.sort && p.sort !== 'date') bits.push(`Sorted by ${p.sort}`);
  }
  return bits.length ? html`<b>Customized:</b> ${bits.join(' · ')}` : '';
}

async function customize(ctx, name, p, apply) {
  const [customers, vendors, accounts] = await Promise.all([ctx.capi.customers(), ctx.capi.vendors(), name === 'general_ledger' ? ctx.capi.accounts() : []]);
  const yes = (k, dflt = false) => (p[k] === undefined || p[k] === '' ? dflt : p[k] === '1');
  const check = (k, label, dflt = false) => html`<label class="check"><input type="checkbox" name="${k}" value="1" ${yes(k, dflt) ? raw('checked') : ''}> ${label}</label>`;
  const names = html`
    ${raw(field('Customer', html`<select name="customer_id">${raw(options(customers, p.customer_id, { blank: 'All customers', label: (c) => c.display_name }))}</select>`))}
    ${raw(field('Vendor', html`<select name="vendor_id">${raw(options(vendors, p.vendor_id, { blank: 'All vendors', label: (v) => v.display_name }))}</select>`))}`;
  let body = '';
  if (name === 'profit_and_loss') {
    body = html`<div class="custom-grid">
      <fieldset><legend>Rows / columns</legend>
        ${raw(field('Display columns by', html`<select name="columns" data-cols>${raw(options([{ id: 'total', name: 'Total only' }, { id: 'months', name: 'Months' }, { id: 'quarters', name: 'Quarters' }], p.columns))}</select>`))}
        ${raw(check('show_zero', 'Show accounts with no activity'))}
        ${raw(check('pct_income', 'Add % of income column'))}
      </fieldset>
      <fieldset data-compare-box><legend>Compare</legend>
        ${raw(field('Compare to', html`<select name="compare">${raw(options(COMPARE, p.compare ?? ''))}</select>`, { hint: 'Available with “Total only” columns' }))}
        ${raw(check('show_change', '$ change', true))}${raw(check('show_pct', '% change', true))}
      </fieldset>
      <fieldset><legend>Filter</legend>${raw(names)}</fieldset></div>`;
  } else if (name === 'balance_sheet') {
    body = html`<div class="custom-grid">
      <fieldset><legend>Compare</legend>
        ${raw(field('Compare to', html`<select name="compare">${raw(options(COMPARE, p.compare ?? ''))}</select>`, { hint: 'Previous period = end of the prior month' }))}
        ${raw(check('show_change', '$ change', true))}${raw(check('show_pct', '% change', true))}
      </fieldset>
      <fieldset><legend>Rows</legend>${raw(check('show_zero', 'Show accounts with zero balance'))}</fieldset></div>`;
  } else if (name === 'general_ledger') {
    const chosen = new Set(String(p.account_id ?? '').split(',').filter(Boolean).map(Number));
    const cols = String(p.cols || ctx.meta.gl_default_columns.join(',')).split(',');
    const groups = new Map();
    for (const a of accounts) { if (!groups.has(a.type_label)) groups.set(a.type_label, []); groups.get(a.type_label).push(a); }
    body = html`<div class="custom-grid">
      <fieldset class="span-all"><legend>Accounts <button type="button" class="link" data-acct-all>All</button> · <button type="button" class="link" data-acct-none>None</button> · <button type="button" class="link" data-acct-pnl>Income &amp; expense only</button></legend>
        <div class="acct-picker">${raw([...groups].map(([g, list]) => html`<div><h5>${g}</h5>${raw(list.map((a) => html`<label class="check"><input type="checkbox" name="acct" value="${a.id}" data-cls="${a.cls}" ${chosen.has(a.id) ? raw('checked') : ''}> ${a.number ? a.number + ' ' : ''}${a.name}</label>`).join(''))}</div>`).join(''))}</div>
        <small class="muted">Leave all unchecked to include every account.</small>
      </fieldset>
      <fieldset><legend>Columns</legend><div class="col-picker">${raw(Object.entries(ctx.meta.gl_columns).map(([k, c]) => html`<label class="check"><input type="checkbox" name="col" value="${k}" ${cols.includes(k) ? raw('checked') : ''}> ${c.label}</label>`).join(''))}</div></fieldset>
      <fieldset><legend>Sort &amp; rows</legend>
        ${raw(field('Sort lines by', html`<select name="sort">${raw(options([{ id: 'date', name: 'Date (running balance)' }, { id: 'num', name: 'Number' }, { id: 'name', name: 'Name' }, { id: 'amount', name: 'Amount (largest first)' }], p.sort ?? 'date'))}</select>`))}
        ${raw(check('hide_empty', 'Hide accounts with no activity', chosen.size !== 1))}
      </fieldset>
      <fieldset><legend>Filter</legend>${raw(names)}</fieldset></div>`;
  }
  const m = modal({
    title: `Customize ${ctx.meta.reports[name].title}`, wide: true, submitLabel: 'Run report', body,
    onSubmit: (d, f) => {
      const out = { customer_id: d.customer_id ?? '', vendor_id: d.vendor_id ?? '' };
      if (name !== 'general_ledger') Object.assign(out, { compare: d.compare ?? '', show_change: d.show_change ? '1' : '0', show_pct: d.show_pct ? '1' : '0', show_zero: d.show_zero ? '1' : '' });
      if (name === 'profit_and_loss') Object.assign(out, { columns: d.columns, pct_income: d.pct_income ? '1' : '', ...(d.columns !== 'total' ? { compare: '' } : {}) });
      if (name === 'general_ledger') {
        const cols = $$('[name=col]:checked', f).map((c) => c.value);
        if (!cols.length) throw new Error('Pick at least one column');
        Object.assign(out, {
          account_id: $$('[name=acct]:checked', f).map((c) => c.value).join(','),
          cols: cols.join(',') === ctx.meta.gl_default_columns.join(',') ? '' : cols.join(','),
          sort: d.sort === 'date' ? '' : d.sort, hide_empty: d.hide_empty ? '1' : '0',
        });
      }
      apply(out);
    },
  });
  const syncCompare = () => { const box = $('[data-compare-box]', m.el); if (box) box.disabled = m.el.columns?.value !== 'total'; };
  m.el.columns?.addEventListener('change', syncCompare);
  syncCompare();
  on(m.el, 'click', '[data-acct-all]', () => $$('[name=acct]', m.el).forEach((c) => { c.checked = true; }));
  on(m.el, 'click', '[data-acct-none]', () => $$('[name=acct]', m.el).forEach((c) => { c.checked = false; }));
  on(m.el, 'click', '[data-acct-pnl]', () => $$('[name=acct]', m.el).forEach((c) => { c.checked = c.dataset.cls === 'income' || c.dataset.cls === 'expense'; }));
}
