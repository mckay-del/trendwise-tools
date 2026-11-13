import { api, companyApi } from './api.js';
import { html, raw, $, on, toast, esc } from './ui.js';
import * as authViews from './views/auth.js';
import * as dashboard from './views/dashboard.js';
import * as lists from './views/lists.js';
import * as forms from './views/forms.js';
import * as banking from './views/banking.js';
import * as accounting from './views/accounting.js';
import * as reports from './views/reports.js';
import * as settings from './views/settings.js';
import * as pkg from './views/package.js';

const state = { user: null, meta: null, company: null, capi: null, companies: [] };

const NAV = [
  { href: 'dashboard', label: 'Dashboard', icon: '◧' },
  { href: 'banking', label: 'Banking', icon: '⌂', children: [['banking', 'Bank transactions'], ['banking/rules', 'Rules'], ['reconcile', 'Reconcile']] },
  { href: 'sales', label: 'Sales', icon: '↗', children: [['sales', 'All sales'], ['invoices', 'Invoices'], ['customers', 'Customers'], ['items', 'Products & services']] },
  { href: 'expenses', label: 'Expenses', icon: '↘', children: [['expenses', 'Expenses'], ['bills', 'Bills'], ['vendors', 'Vendors']] },
  { href: 'reports', label: 'Reports', icon: '▤' },
  { href: 'accounts', label: 'Accounting', icon: '≡', children: [['accounts', 'Chart of accounts'], ['transactions', 'All transactions'], ['reconcile', 'Reconcile']] },
  { href: 'settings', label: 'Settings', icon: '⚙' },
];

const NEW_MENU = [
  ['Customers', [['invoice', 'Invoice'], ['payment', 'Receive payment'], ['sales_receipt', 'Sales receipt'], ['credit_memo', 'Credit memo']]],
  ['Vendors', [['expense', 'Expense'], ['check', 'Check'], ['bill', 'Bill'], ['bill_payment', 'Pay bills'], ['vendor_credit', 'Vendor credit']]],
  ['Other', [['deposit', 'Bank deposit'], ['transfer', 'Transfer'], ['journal_entry', 'Journal entry']]],
];

const ROUTES = [
  ['login', authViews.login, { public: true }],
  ['setup', authViews.setup, { public: true }],
  ['companies', authViews.companies],
  ['users', settings.users],
  ['c/:cid/dashboard', dashboard.view],
  ['c/:cid/banking', banking.feed],
  ['c/:cid/banking/rules', banking.rules],
  ['c/:cid/reconcile', accounting.reconcileStart],
  ['c/:cid/reconcile/:id', accounting.reconcile],
  ['c/:cid/sales', (ctx) => lists.transactions(ctx, { side: 'sales', title: 'Sales transactions' })],
  ['c/:cid/invoices', (ctx) => lists.transactions(ctx, { type: 'invoice', title: 'Invoices' })],
  ['c/:cid/expenses', (ctx) => lists.transactions(ctx, { type: 'expense,check,bill_payment,vendor_credit', title: 'Expense transactions' })],
  ['c/:cid/bills', (ctx) => lists.transactions(ctx, { type: 'bill', title: 'Bills' })],
  ['c/:cid/transactions', (ctx) => lists.transactions(ctx, { title: 'All transactions' })],
  ['c/:cid/customers', (ctx) => lists.parties(ctx, 'customers')],
  ['c/:cid/customers/:id', (ctx) => lists.partyDetail(ctx, 'customers')],
  ['c/:cid/vendors', (ctx) => lists.parties(ctx, 'vendors')],
  ['c/:cid/vendors/:id', (ctx) => lists.partyDetail(ctx, 'vendors')],
  ['c/:cid/items', lists.items],
  ['c/:cid/new/:type', forms.view],
  ['c/:cid/txn/:id', forms.view],
  ['c/:cid/print/:id', forms.print, { bare: true }],
  ['c/:cid/accounts', accounting.chart],
  ['c/:cid/reports', reports.index],
  ['c/:cid/reports/:name', reports.view],
  ['c/:cid/package', pkg.setup],
  ['c/:cid/package/print', pkg.print, { bare: true }],
  ['c/:cid/settings', settings.company],
  ['c/:cid/audit', settings.audit],
];

function parseHash() {
  const h = location.hash.replace(/^#\/?/, '') || 'companies';
  const [path, q = ''] = h.split('?');
  return { path: path.replace(/\/$/, ''), query: Object.fromEntries(new URLSearchParams(q)) };
}

function matchRoute(path) {
  for (const [pattern, fn, opts = {}] of ROUTES) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    const m = path.match(re);
    if (m) return { fn, opts, params: Object.fromEntries(keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
  }
  return null;
}

export function navigate(path, query) {
  const q = query ? '?' + new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString() : '';
  location.hash = `#/${path}${q === '?' ? '' : q}`;
}

/** Path within the current company, e.g. cpath('invoices'). */
export const cpath = (p) => `c/${state.company.id}/${p}`;
export const chref = (p) => `#/${cpath(p)}`;

async function ensureCompany(cid) {
  if (state.company?.id === Number(cid)) return;
  state.company = await api.get(`/api/c/${cid}`);
  state.capi = companyApi(state.company.id);
  try { localStorage.setItem('ledger.company', String(state.company.id)); } catch { /* ignore */ }
}

/** Reload company settings (e.g. after changing the closing date) and re-render the current page. */
export async function refreshCompany() {
  state.company = await api.get(`/api/c/${state.company.id}`);
  shellFor = null;
  await render();
}

let renderSeq = 0;
async function render() {
  const seq = ++renderSeq;
  const { path, query } = parseHash();
  const route = matchRoute(path);
  const root = $('#app');
  if (!route) { root.innerHTML = html`<div class="center-page"><h1>Page not found</h1><a href="#/companies">Go home</a></div>`; return; }
  try {
    if (!state.user && !route.opts.public) {
      const s = await api.get('/api/auth/status');
      if (s.needs_setup) return navigate('setup');
      if (!s.user) return navigate('login');
      state.user = s.user;
    }
    if (state.user && !state.meta) state.meta = await api.get('/api/meta');
    if (route.params.cid) await ensureCompany(route.params.cid);
    else state.company = null;
    if (seq !== renderSeq) return;

    let main;
    if (route.opts.public || route.opts.bare || !state.company) {
      shellFor = null;
      root.innerHTML = '<main id="main" class="bare"></main>';
      main = $('#main');
      if (!route.opts.public && !route.opts.bare) main.prepend(topbarOnly());
    } else {
      renderShell();
      main = $('#main');
      highlightNav(path);
    }
    // Each render gets a brand-new host element so delegated listeners from earlier views never pile up.
    main.querySelector(':scope > .view')?.remove();
    const host = document.createElement('div');
    host.className = 'view';
    host.innerHTML = '<div class="loading">Loading…</div>';
    main.append(host);
    const ctx = { params: route.params, query, el: host, ...state, state, navigate, cpath, chref, setTitle, reload: render };
    await route.fn(ctx);
    if (seq === renderSeq) main.focus?.({ preventScroll: true });
  } catch (e) {
    console.error(e);
    const main = $('#main .view') ?? $('#main') ?? root;
    main.innerHTML = html`<div class="error-page"><h2>Couldn't load this page</h2><p>${e.message}</p><a href="#/companies" class="btn">Back to companies</a></div>`;
  }
}

function setTitle(t) { document.title = `${t} · ${state.company?.name ?? 'Trendwise Ledger'}`; }

function topbarOnly() {
  const div = document.createElement('div');
  div.className = 'mini-top';
  div.innerHTML = html`<strong>Trendwise Ledger</strong><span class="spacer"></span><span>${state.user?.name ?? ''}</span>${state.user?.role === 'admin' ? raw('<a href="#/users" class="btn btn-ghost">Users</a>') : ''}<button class="btn btn-ghost" data-action="logout">Sign out</button>`;
  return div;
}

let shellFor = null;
function renderShell(force = false) {
  if (!force && shellFor === state.company.id && $('#main')) return;
  shellFor = state.company.id;
  const c = state.company;
  $('#app').innerHTML = html`
    <div class="shell">
      <aside class="sidebar" aria-label="Main navigation">
        <div class="brand"><span class="logo">TL</span><span>Trendwise<br><small>Ledger</small></span></div>
        <div class="new-wrap">
          <button class="btn btn-new" data-action="new-menu" aria-haspopup="true" aria-expanded="false">＋ New</button>
          <div class="new-menu" hidden>${raw(NEW_MENU.map(([g, items]) => html`<div class="new-col"><h4>${g}</h4>${raw(items.map(([t, l]) => html`<a href="${chref('new/' + t)}">${l}</a>`).join(''))}</div>`).join(''))}</div>
        </div>
        <nav>${raw(NAV.map((n) => html`<div class="nav-group"><a class="nav-link" data-nav="${n.href}" href="${chref(n.href)}"><span class="nav-icon" aria-hidden="true">${n.icon}</span>${n.label}</a>${n.children ? raw(html`<div class="nav-children">${raw(n.children.map(([h, l]) => html`<a data-nav="${h}" href="${chref(h)}">${l}</a>`).join(''))}</div>`) : ''}</div>`).join(''))}</nav>
      </aside>
      <div class="content">
        <header class="topbar">
          <button class="icon-btn menu-toggle" data-action="toggle-nav" aria-label="Menu">☰</button>
          <a class="company-name" href="#/companies" title="Switch company">${c.name} <span aria-hidden="true">▾</span></a>
          ${c.closing_date ? raw(html`<span class="pill" title="Books closed through this date">Closed through ${c.closing_date}</span>`) : ''}
          <form class="search" data-action="search" role="search"><input name="q" type="search" placeholder="Search transactions, amounts, names" aria-label="Search"></form>
          <span class="spacer"></span>
          <span class="user">${state.user.name} <small>(${state.user.role})</small></span>
          <button class="btn btn-ghost" data-action="logout">Sign out</button>
        </header>
        <main id="main" tabindex="-1"></main>
      </div>
    </div>`;
}

function highlightNav(path) {
  const rest = path.split('/').slice(2).join('/');
  document.querySelectorAll('[data-nav]').forEach((a) => {
    const n = a.dataset.nav;
    a.classList.toggle('active', rest === n || (rest.startsWith(n + '/') && !document.querySelector(`[data-nav="${rest}"]`)));
  });
  document.querySelectorAll('.nav-group').forEach((g) => g.classList.toggle('open', !!g.querySelector('.active')));
}

// Global event handling
document.addEventListener('click', (e) => {
  const menu = document.querySelector('.new-menu');
  if (menu && !e.target.closest('.new-wrap')) { menu.hidden = true; document.querySelector('[data-action=new-menu]')?.setAttribute('aria-expanded', 'false'); }
  if (e.target.closest('.new-menu a')) menu.hidden = true;
  if (e.target.closest('.sidebar a')) document.body.classList.remove('nav-open');
});
on(document, 'click', '[data-action=new-menu]', (e, b) => { const m = document.querySelector('.new-menu'); m.hidden = !m.hidden; b.setAttribute('aria-expanded', String(!m.hidden)); });
on(document, 'click', '[data-action=toggle-nav]', () => document.body.classList.toggle('nav-open'));
on(document, 'click', '[data-action=logout]', async () => {
  await api.post('/api/auth/logout').catch(() => {});
  state.user = null; state.company = null; shellFor = null;
  navigate('login');
});
on(document, 'submit', '[data-action=search]', (e, f) => {
  e.preventDefault();
  navigate(cpath('transactions'), { search: f.q.value.trim() });
});
on(document, 'click', '[data-href]', (e, el) => {
  if (e.target.closest('a,button,input,select,label')) return;
  location.hash = el.dataset.href;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('tr[data-href]')) location.hash = e.target.dataset.href;
});

window.addEventListener('hashchange', render);
window.addEventListener('unhandledrejection', (e) => { toast(e.reason?.message ?? 'Unexpected error', 'error'); });

export function setUser(u) { state.user = u; }
export { state, esc };

render();
