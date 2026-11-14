import { api } from '../api.js';
import { html, raw, on, options, field, fmtDate } from '../ui.js';
import { reportTable } from './reports.js';

const KEY = (cid) => `ledger.package.${cid}`;
const load = (cid) => { try { return JSON.parse(localStorage.getItem(KEY(cid)) ?? '{}'); } catch { return {}; } };
const store = (cid, v) => { try { localStorage.setItem(KEY(cid), JSON.stringify(v)); } catch { /* ignore */ } };

const DEFAULTS = { period: 'last_month', basis: 'accrual', compare: '', pl_columns: 'total', include: 'cover,pl,bs', note: '' };

/** Setup screen: choose period and contents, then open the print-ready package. */
export async function setup(ctx) {
  ctx.setTitle('Client report package');
  const o = { ...DEFAULTS, ...load(ctx.company.id) };
  const inc = new Set(o.include.split(','));
  const periods = Object.entries(ctx.meta.periods).filter(([k]) => k !== 'today');
  const firm = await api.get('/api/firm');
  ctx.el.innerHTML = html`<div class="page narrow">
    <div class="crumbs"><a href="${ctx.chref('reports')}">Reports</a> ›</div>
    <div class="page-head"><h1>Client report package</h1></div>
    <p class="muted">Builds a branded, print-ready set of financial statements for <b>${ctx.company.name}</b>. Use your browser's <b>Save as PDF</b> to send it. Branding comes from Settings → Firm branding${firm.logo ? '' : ' (using the built-in Trendwise logo)'}.</p>
    <form class="card stack" data-form="pkg">
      <div class="form-grid">
        ${raw(field('Period', html`<select name="period" data-period>${raw(options(periods.map(([id, n]) => ({ id, name: n })), o.period, { blank: 'Custom dates' }))}</select>`))}
        ${raw(field('Accounting method', html`<select name="basis">${raw(options([{ id: 'accrual', name: 'Accrual' }, { id: 'cash', name: 'Cash' }], o.basis))}</select>`))}
        ${raw(field('From', html`<input type="date" name="from" value="${o.from ?? ''}">`, { cls: 'custom' }))}
        ${raw(field('To', html`<input type="date" name="to" value="${o.to ?? ''}">`, { cls: 'custom' }))}
        ${raw(field('Compare to', html`<select name="compare">${raw(options([{ id: '', name: 'No comparison' }, { id: 'prior_year', name: 'Same period last year' }, { id: 'prior_period', name: 'Previous period' }], o.compare))}</select>`))}
        ${raw(field('P&L columns', html`<select name="pl_columns">${raw(options([{ id: 'total', name: 'Total only' }, { id: 'months', name: 'By month' }, { id: 'quarters', name: 'By quarter' }], o.pl_columns))}</select>`, { hint: 'Comparison applies to “Total only”' }))}
      </div>
      <fieldset class="inline-checks"><legend>Include</legend>
        ${raw([['cover', 'Cover page'], ['pl', 'Profit and Loss'], ['bs', 'Balance Sheet'], ['gl', 'General Ledger'], ['ar', 'A/R Aging Summary'], ['ap', 'A/P Aging Summary']].map(([k, l]) => html`<label class="check"><input type="checkbox" name="inc" value="${k}" ${inc.has(k) ? raw('checked') : ''}> ${l}</label>`).join(''))}
      </fieldset>
      ${raw(field('Note to client (optional, printed on the cover)', html`<textarea name="note" rows="3" placeholder="e.g. Revenue was up 12% over last October, mainly from new maintenance contracts…">${o.note}</textarea>`))}
      <div class="btn-row"><button class="btn btn-primary">Build package</button></div>
    </form></div>`;
  const form = ctx.el.querySelector('[data-form=pkg]');
  const sync = () => ctx.el.querySelectorAll('.custom').forEach((el) => { el.hidden = !!form.period.value; });
  sync(); form.period.addEventListener('change', sync);
  on(ctx.el, 'submit', '[data-form=pkg]', (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(form));
    const opts = { period: d.period, from: d.from, to: d.to, basis: d.basis, compare: d.compare, pl_columns: d.pl_columns, note: d.note, include: [...form.querySelectorAll('[name=inc]:checked')].map((c) => c.value).join(',') };
    if (!opts.include.replace('cover', '').replace(/,/g, '')) { alert('Choose at least one report.'); return; }
    if (!opts.period && (!opts.from || !opts.to)) { alert('Enter both custom dates.'); return; }
    store(ctx.company.id, opts);
    ctx.navigate(ctx.cpath('package/print'), { ...opts, note: undefined });
  });
}

/** Print-ready package. Each statement starts on a new page. */
export async function print(ctx) {
  const q = { ...DEFAULTS, ...ctx.query };
  const note = load(ctx.company.id).note ?? '';
  const inc = new Set(String(q.include).split(','));
  const range = q.period ? { period: q.period } : { from: q.from, to: q.to };
  const cmp = q.compare && q.pl_columns === 'total' ? { compare: q.compare } : {};
  const jobs = [];
  if (inc.has('pl')) jobs.push(['pl', 'profit_and_loss', { ...range, basis: q.basis, columns: q.pl_columns, ...cmp }]);
  if (inc.has('bs')) jobs.push(['bs', 'balance_sheet', { ...(q.period ? { period: q.period } : { asof: q.to }), ...(q.compare ? { compare: q.compare } : {}) }]);
  if (inc.has('ar')) jobs.push(['ar', 'ar_aging', { ...(q.period ? { period: q.period } : { asof: q.to }) }]);
  if (inc.has('ap')) jobs.push(['ap', 'ap_aging', { ...(q.period ? { period: q.period } : { asof: q.to }) }]);
  if (inc.has('gl')) jobs.push(['gl', 'general_ledger', { ...range, cols: 'date,type,num,name,memo,split,amount,balance' }]);
  const [firm, ...reps] = await Promise.all([api.get('/api/firm'), ...jobs.map(([, n, p]) => ctx.capi.get(`/reports/${n}`, p))]);
  const first = reps[0]?.params;
  const from = first?.from, to = first?.to ?? first?.asof;
  const c = ctx.company;
  document.title = `${c.name} — Financial statements ${to ?? ''}`;
  const periodText = from && to ? (from.slice(0, 7) === to.slice(0, 7) && from.endsWith('-01') ? `For the month ended ${longDate(to)}` : `For the period ${longDate(from)} through ${longDate(to)}`) : '';
  const logo = html`<img src="${firm.logo || '/img/trendwise-logo.png'}" alt="${firm.name}" class="pkg-logo">`;
  const pageHead = (title, sub) => html`<header class="pkg-head"><div>${raw(logo)}</div><div class="pkg-head-text"><div class="pkg-client">${c.legal_name ?? c.name}</div><h2>${title}</h2><div class="muted">${sub}</div></div></header>`;
  const pageFoot = html`<footer class="pkg-foot"><span>${firm.footer}</span><span>Prepared by ${firm.name}</span></footer>`;

  ctx.el.innerHTML = html`<div class="pkg" style="--firm:${firm.accent}">
    <div class="no-print pkg-toolbar"><a class="btn" href="${ctx.chref('package')}">← Change options</a><span class="spacer"></span><span class="muted">Use “Save as PDF” as the destination to create a PDF.</span><button class="btn btn-primary" data-action="print">Print / Save as PDF</button></div>
    ${inc.has('cover') ? raw(html`<section class="pkg-page pkg-cover">
      <div class="pkg-cover-brand">${raw(logo)}${firm.tagline ? raw(html`<div class="muted">${firm.tagline}</div>`) : ''}</div>
      <div class="pkg-cover-main">
        <div class="pkg-rule"></div>
        <h1>${c.legal_name ?? c.name}</h1>
        <h2>Financial Statements</h2>
        <p class="pkg-period">${periodText}${q.basis === 'cash' ? ' · Cash basis' : ''}</p>
        <ol class="pkg-toc">${raw(reps.map((r) => html`<li>${r.title}</li>`).join(''))}</ol>
        ${note ? raw(html`<div class="pkg-note"><h4>Notes from your accountant</h4><p class="pre">${note}</p></div>`) : ''}
      </div>
      <div class="pkg-cover-foot"><div>Prepared by <b>${firm.name}</b> on ${longDate(new Date().toISOString().slice(0, 10))}</div>${firm.contact ? raw(html`<div class="pre muted">${firm.contact}</div>`) : ''}<p class="muted small">${firm.footer}</p></div>
    </section>`) : ''}
    ${raw(reps.map((r) => html`<section class="pkg-page">${raw(pageHead(r.title, r.subtitle))}<div class="report">${raw(reportTable(ctx, r, { links: false }))}</div>${raw(pageFoot)}</section>`).join(''))}
  </div>`;
  on(ctx.el, 'click', '[data-action=print]', () => window.print());
  void fmtDate;
}

function longDate(iso) { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }); }
