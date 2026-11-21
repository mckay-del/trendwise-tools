import { api } from '../api.js';
import { html, raw, on, field } from '../ui.js';
import { setUser, APP_NAME } from '../app.js';

function authCard(title, body) {
  return html`<div class="auth-page"><div class="auth-card"><div class="brand big"><img class="brand-logo" src="/img/trendwise-logo.png" alt="TrendWise Business Services"><span class="brand-app">${APP_NAME}</span></div><h1>${title}</h1>${raw(body)}</div></div>`;
}

const showError = (f, err) => { const b = f.querySelector('.form-error'); b.textContent = err.message; b.hidden = false; };

export async function login(ctx) {
  const s = await api.get('/api/auth/status');
  if (s.needs_setup) return ctx.navigate('setup');
  if (s.user) { setUser(s.user); return ctx.navigate('board'); }
  document.title = `Sign in · ${APP_NAME}`;
  ctx.el.innerHTML = authCard('Sign in', html`<form class="stack" data-form="login">
    ${raw(field('Email', '<input name="email" type="email" autocomplete="username" required autofocus>'))}
    ${raw(field('Password', '<input name="password" type="password" autocomplete="current-password" required>'))}
    <div class="form-error" hidden></div>
    <button class="btn btn-primary btn-block">Sign in</button></form>`);
  on(ctx.el, 'submit', '[data-form=login]', async (e, f) => {
    e.preventDefault();
    try { setUser((await api.post('/api/auth/login', { email: f.email.value, password: f.password.value })).user); ctx.navigate('board'); }
    catch (err) { showError(f, err); }
  });
}

export async function setup(ctx) {
  const s = await api.get('/api/auth/status');
  if (!s.needs_setup) return ctx.navigate('login');
  document.title = `Set up · ${APP_NAME}`;
  ctx.el.innerHTML = authCard('Create your login', html`<p class="muted">First run. This login protects your board and, later, the Google accounts you connect.</p>
    <form class="stack" data-form="setup">
    ${raw(field('Your name', '<input name="name" required autofocus autocomplete="name">'))}
    ${raw(field('Email', '<input name="email" type="email" required autocomplete="username">'))}
    ${raw(field('Password', '<input name="password" type="password" minlength="10" required autocomplete="new-password">', { hint: 'At least 10 characters' }))}
    <div class="form-error" hidden></div>
    <button class="btn btn-primary btn-block">Create login</button></form>`);
  on(ctx.el, 'submit', '[data-form=setup]', async (e, f) => {
    e.preventDefault();
    try { setUser((await api.post('/api/auth/setup', Object.fromEntries(new FormData(f)))).user); ctx.navigate('board'); }
    catch (err) { showError(f, err); }
  });
}
