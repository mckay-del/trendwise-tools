import { api } from '../api.js';
import { html, raw, on, modal, field, toast } from '../ui.js';
import { setUser } from '../app.js';

function authCard(title, body) {
  return html`<div class="auth-page"><div class="auth-card"><div class="brand big"><span class="logo">TL</span><span>Trendwise Ledger</span></div><h1>${title}</h1>${raw(body)}</div></div>`;
}

export async function login(ctx) {
  const s = await api.get('/api/auth/status');
  if (s.needs_setup) return ctx.navigate('setup');
  if (s.user) { setUser(s.user); return ctx.navigate('companies'); }
  document.title = 'Sign in · Trendwise Ledger';
  ctx.el.innerHTML = authCard('Sign in', html`<form class="stack" data-form="login">
    ${raw(field('Email', '<input name="email" type="email" autocomplete="username" required autofocus>'))}
    ${raw(field('Password', '<input name="password" type="password" autocomplete="current-password" required>'))}
    <div class="form-error" hidden></div>
    <button class="btn btn-primary btn-block">Sign in</button></form>`);
  on(ctx.el, 'submit', '[data-form=login]', async (e, f) => {
    e.preventDefault();
    try {
      const r = await api.post('/api/auth/login', { email: f.email.value, password: f.password.value });
      setUser(r.user);
      let last = null; try { last = localStorage.getItem('ledger.company'); } catch { /* ignore */ }
      ctx.navigate(last ? `c/${last}/dashboard` : 'companies');
    } catch (err) { const b = f.querySelector('.form-error'); b.textContent = err.message; b.hidden = false; }
  });
}

export async function setup(ctx) {
  const s = await api.get('/api/auth/status');
  if (!s.needs_setup) return ctx.navigate('login');
  document.title = 'Set up · Trendwise Ledger';
  ctx.el.innerHTML = authCard('Create the administrator account', html`<p class="muted">This is the first run. The account you create here can add other users and companies.</p>
    <form class="stack" data-form="setup">
    ${raw(field('Your name', '<input name="name" required autofocus autocomplete="name">'))}
    ${raw(field('Email', '<input name="email" type="email" required autocomplete="username">'))}
    ${raw(field('Password', '<input name="password" type="password" minlength="10" required autocomplete="new-password">', { hint: 'At least 10 characters' }))}
    <div class="form-error" hidden></div>
    <button class="btn btn-primary btn-block">Create account</button></form>`);
  on(ctx.el, 'submit', '[data-form=setup]', async (e, f) => {
    e.preventDefault();
    try {
      const r = await api.post('/api/auth/setup', Object.fromEntries(new FormData(f)));
      setUser(r.user);
      ctx.navigate('companies');
    } catch (err) { const b = f.querySelector('.form-error'); b.textContent = err.message; b.hidden = false; }
  });
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function companyForm(c = {}) {
  return html`<div class="form-grid">
    ${raw(field('Company name', html`<input name="name" required value="${c.name ?? ''}" autofocus>`, { cls: 'span-2' }))}
    ${raw(field('Legal name', html`<input name="legal_name" value="${c.legal_name ?? ''}">`))}
    ${raw(field('EIN', html`<input name="ein" value="${c.ein ?? ''}" placeholder="12-3456789">`))}
    ${raw(field('Email', html`<input name="email" type="email" value="${c.email ?? ''}">`))}
    ${raw(field('Phone', html`<input name="phone" value="${c.phone ?? ''}">`))}
    ${raw(field('Address', html`<textarea name="address" rows="3">${c.address ?? ''}</textarea>`, { cls: 'span-2' }))}
    ${raw(field('First month of fiscal year', html`<select name="fiscal_year_start_month">${raw(MONTHS.map((m, i) => html`<option value="${i + 1}" ${(c.fiscal_year_start_month ?? 1) === i + 1 ? raw('selected') : ''}>${m}</option>`).join(''))}</select>`))}
  </div>`;
}

export async function companies(ctx) {
  document.title = 'Companies · Trendwise Ledger';
  const list = await api.get('/api/companies');
  const isAdmin = ctx.user.role === 'admin';
  const body = html`<div class="page narrow">
    <div class="page-head"><h1>Your companies</h1>${isAdmin ? raw('<button class="btn btn-primary" data-action="add-company">＋ New company</button>') : ''}</div>
    ${list.length ? raw(html`<div class="company-list">${raw(list.map((c) => html`<a class="company-card" href="#/c/${c.id}/dashboard"><strong>${c.name}</strong><span class="muted">${c.legal_name ?? ''}${c.ein ? ` · EIN ${c.ein}` : ''}</span></a>`).join(''))}</div>`)
      : raw(html`<div class="empty"><p>No companies yet.</p>${isAdmin ? raw('<button class="btn btn-primary" data-action="add-company">Create your first company</button>') : raw('<p>Ask an administrator to add one.</p>')}</div>`)}
  </div>`;
  ctx.el.innerHTML = (body);
  on(ctx.el, 'click', '[data-action=add-company]', () => modal({
    title: 'New company', body: companyForm(), submitLabel: 'Create company',
    onSubmit: async (data) => { const c = await api.post('/api/companies', data); toast('Company created with a standard chart of accounts'); ctx.navigate(`c/${c.id}/dashboard`); },
  }));
}
