import { html, raw, esc, money, fmtDate, today, on, options, $ } from '../ui.js';

function presets() {
  const t = new Date();
  const y = t.getFullYear(), m = t.getMonth();
  const d = (yy, mm, dd) => `${yy}-${String(mm + 1).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  const last = (yy, mm) => new Date(yy, mm + 1, 0).getDate();
  const q = Math.floor(m / 3);
  return {
    this_month: ['This month', d(y, m, 1), d(y, m, last(y, m))],
    last_month: ['Last month', d(m ? y : y - 1, (m + 11) % 12, 1), d(m ? y : y - 1, (m + 11) % 12, last(m ? y : y - 1, (m + 11) % 12))],
    this_quarter: ['This quarter', d(y, q * 3, 1), d(y, q * 3 + 2, last(y, q * 3 + 2))],
    last_quarter: ['Last quarter', d(q ? y : y - 1, ((q + 3) % 4) * 3, 1), d(q ? y : y - 1, ((q + 3) % 4) * 3 + 2, last(q ? y : y - 1, ((q + 3) % 4) * 3 + 2))],
    this_year: ['This year', d(y, 0, 1), d(y, 11, 31)],
    ytd: ['This year to date', d(y, 0, 1), today()],
    last_year: ['Last year', d(y - 1, 0, 1), d(y - 1, 11, 31)],
  };
}

export async function index(ctx) {
  ctx.setTitle('Reports');
  const groups = new Map();
  for (const [k, r] of Object.entries(ctx.meta.reports)) { if (!groups.has(r.group)) groups.set(r.group, []); groups.get(r.group).push([k, r]); }
  ctx.el.innerHTML = html`<div class="page">
    <div class="page-head"><h1>Reports</h1></div>
    <div class="report-groups">${raw([...groups].map(([g, list]) => html`<section class="card"><h3>${g}</h3><ul class="report-links">${raw(list.map(([k, r]) => html`<li><a href="${ctx.chref('reports/' + k)}">${r.title}</a></li>`).join(''))}</ul></section>`).join(''))}</div>
  </div>`;
}

export async function view(ctx) {
  const name = ctx.params.name;
  const def = ctx.meta.reports[name];
  if (!def) throw new Error('Unknown report');
  ctx.setTitle(def.title);
  const accounts = def.params.includes('account') ? await ctx.capi.accounts() : [];
  const rep = await ctx.capi.get(`/reports/${name}`, ctx.query);
  const p = rep.params;
  const P = presets();
  const range = def.params.includes('range');

  const controls = html`<form class="filters report-controls" data-form="params">
    ${range ? raw(html`<label>Report period <select data-preset>${raw(options(Object.entries(P).map(([k, [l]]) => ({ id: k, name: l })), Object.entries(P).find(([, v]) => v[1] === p.from && v[2] === p.to)?.[0] ?? '', { blank: 'Custom' }))}</select></label>
      <label>From <input type="date" name="from" value="${p.from}"></label><label>To <input type="date" name="to" value="${p.to}"></label>`) : ''}
    ${def.params.includes('asof') ? raw(html`<label>As of <input type="date" name="asof" value="${p.asof}"></label>`) : ''}
    ${def.params.includes('basis') ? raw(html`<label>Accounting method <select name="basis">${raw(options([{ id: 'accrual', name: 'Accrual' }, { id: 'cash', name: 'Cash' }], p.basis))}</select></label>`) : ''}
    ${def.params.includes('columns') ? raw(html`<label>Display columns by <select name="columns">${raw(options([{ id: 'total', name: 'Total only' }, { id: 'months', name: 'Months' }], p.columns))}</select></label>`) : ''}
    ${def.params.includes('account') ? raw(html`<label>Account <select name="account_id">${raw(options(accounts, p.account_id, { blank: 'All accounts', label: (a) => `${a.number ? a.number + ' ' : ''}${a.name}`, group: (a) => a.type_label }))}</select></label>`) : ''}
    ${def.params.includes('year') ? raw(html`<label>Tax year <input type="number" name="year" min="2000" max="2100" value="${p.year}"></label>`) : ''}
    <button class="btn btn-primary">Run report</button>
    <span class="spacer"></span>
    <a class="btn" href="${ctx.capi.url(`/reports/${name}`, { ...ctx.query, format: 'csv' })}" download>Export CSV</a>
    <button type="button" class="btn" data-action="print">Print</button>
  </form>`;

  const cell = (v, col) => {
    if (v === null || v === undefined || v === '') return '';
    if (col.type === 'money') return typeof v === 'number' ? html`<span class="${v < 0 ? 'neg' : ''}">${money(v)}</span>` : esc(v);
    if (col.type === 'date') return esc(fmtDate(v));
    return esc(v);
  };
  const body = rep.rows.map((r) => {
    const link = r.txn_id ? ctx.chref('txn/' + r.txn_id) : r.account_id && name !== 'general_ledger' ? `${ctx.chref('reports/general_ledger')}?account_id=${r.account_id}${p.from ? `&from=${name === 'balance_sheet' || name === 'trial_balance' ? p.asof.slice(0, 4) + '-01-01' : p.from}&to=${name === 'balance_sheet' || name === 'trial_balance' ? p.asof : p.to}` : ''}` : null;
    return html`<tr class="r-${r.kind} ${link ? 'clickable' : ''}" ${link ? raw(html`data-href="${link}" tabindex="0"`) : ''}>${raw(r.cells.map((v, i) => html`<td class="${rep.columns[i].type === 'money' ? 'num' : ''}" ${i === 0 ? raw(`style="padding-left:${0.6 + (r.depth ?? 0) * 1.1}rem"`) : ''}>${raw(cell(v, rep.columns[i]))}</td>`).join(''))}</tr>`;
  }).join('');

  ctx.el.innerHTML = html`<div class="page">
    <div class="crumbs no-print"><a href="${ctx.chref('reports')}">Reports</a> ›</div>
    ${raw(controls)}
    <article class="report card">
      <header><h2>${ctx.company.name}</h2><h1>${rep.title}</h1><p>${rep.subtitle}</p></header>
      ${rep.rows.length ? raw(html`<div class="table-wrap"><table class="report-table"><thead><tr>${raw(rep.columns.map((c) => html`<th class="${c.type === 'money' ? 'num' : ''}">${c.label}</th>`).join(''))}</tr></thead><tbody>${raw(body)}</tbody></table></div>`) : raw('<div class="empty">No data for this period.</div>')}
      <footer class="muted">Generated ${new Date().toLocaleString()}</footer>
    </article>
  </div>`;

  on(ctx.el, 'change', '[data-preset]', (e, sel) => {
    const v = P[sel.value];
    if (v) { $('[name=from]', ctx.el).value = v[1]; $('[name=to]', ctx.el).value = v[2]; }
  });
  on(ctx.el, 'submit', '[data-form=params]', (e, f) => {
    e.preventDefault();
    const q = Object.fromEntries(new FormData(f));
    ctx.navigate(ctx.cpath('reports/' + name), q);
  });
  on(ctx.el, 'click', '[data-action=print]', () => window.print());
}
