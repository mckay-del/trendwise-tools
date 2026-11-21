import { api } from './api.js';
import { html, $, on, toast } from './ui.js';
import * as authViews from './views/auth.js';
import * as board from './views/board.js';

export const APP_NAME = "McKay's Taskboard";
const state = { user: null, meta: null };

const ROUTES = {
  login: [authViews.login, { public: true }],
  setup: [authViews.setup, { public: true }],
  board: [board.view],
};

export function navigate(path) { location.hash = `#/${path}`; }
export function setUser(u) { state.user = u; }

let renderSeq = 0;
async function render() {
  const seq = ++renderSeq;
  const path = location.hash.replace(/^#\/?/, '').split('?')[0].replace(/\/$/, '') || 'board';
  const [fn, opts = {}] = ROUTES[path] ?? [];
  const root = $('#app');
  if (!fn) { root.innerHTML = html`<div class="center-page"><h1>Page not found</h1><a href="#/board">Go to the board</a></div>`; return; }
  try {
    if (!state.user && !opts.public) {
      const s = await api.get('/api/auth/status');
      if (s.needs_setup) return navigate('setup');
      if (!s.user) return navigate('login');
      state.user = s.user;
    }
    if (state.user && !state.meta) state.meta = await api.get('/api/meta');
    if (seq !== renderSeq) return;
    root.innerHTML = opts.public ? '<main id="main" class="bare"></main>' : shell();
    // A brand-new host per render so delegated listeners from earlier views never pile up.
    const host = document.createElement('div');
    host.className = 'view';
    host.innerHTML = '<div class="loading">Loading…</div>';
    $('#main').append(host);
    await fn({ el: host, state, navigate, reload: render });
  } catch (e) {
    console.error(e);
    ($('#main .view') ?? root).innerHTML = html`<div class="error-page"><h2>Couldn't load this page</h2><p>${e.message}</p><a href="#/board" class="btn">Back to the board</a></div>`;
  }
}

function shell() {
  return html`<div class="tb-shell">
    <header class="topbar">
      <img class="tb-logo" src="/img/trendwise-logo.png" alt="TrendWise Business Services">
      <strong class="tb-name">${APP_NAME}</strong>
      <span class="spacer"></span>
      <span class="user">${state.user.name}</span>
      <button class="btn btn-ghost" data-action="logout">Sign out</button>
    </header>
    <main id="main" tabindex="-1"></main>
    <footer class="tb-footer">v${state.meta?.version ?? ''}</footer>
  </div>`;
}

on(document, 'click', '[data-action=logout]', async () => {
  await api.post('/api/auth/logout').catch(() => {});
  state.user = null;
  navigate('login');
});

window.addEventListener('hashchange', render);
window.addEventListener('unhandledrejection', (e) => toast(e.reason?.message ?? 'Unexpected error', 'error'));
render();
