import { readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, normalize, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from './router.js';
import { AppError, bad, forbidden } from './util.js';
import * as auth from './auth.js';
import * as tasks from './services/tasks.js';
import * as google from './services/google.js';
import * as settings from './services/settings.js';
import { syncAll, syncSoon } from './services/sync.js';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json' };
const MAX_BODY = 1024 * 1024;
const COOKIE = 'taskboard_session';
const CSRF = 'taskboard';

export function buildRouter(db) {
  const r = new Router();
  const id = (ctx) => Number(ctx.params.id);

  // --- Auth (public) ---
  r.get('/api/auth/status', (ctx) => ({ needs_setup: auth.needsSetup(db), user: ctx.user }), { public: true });
  r.post('/api/auth/setup', (ctx) => { const s = auth.setupOwner(db, ctx.body); ctx.setSession(s); return { user: s.user }; }, { public: true });
  r.post('/api/auth/login', (ctx) => { const s = auth.login(db, ctx.body, ctx.ip); ctx.setSession(s); return { user: s.user }; }, { public: true });
  r.post('/api/auth/logout', (ctx) => { auth.logout(db, ctx.token); ctx.clearSession(); return { ok: true }; }, { public: true });

  r.get('/api/meta', () => ({ version: VERSION, columns: tasks.COLUMNS }));

  // --- Tasks (changes go to Google Tasks a few seconds later) ---
  const thenSync = (v) => { syncSoon(db); return v; };
  r.get('/api/board', () => ({ ...tasks.board(db), accounts: google.listAccounts(db) }));
  r.post('/api/tasks', (ctx) => thenSync(tasks.createTask(db, ctx.body)));
  r.get('/api/tasks/:id', (ctx) => tasks.getTask(db, id(ctx)));
  r.put('/api/tasks/:id', (ctx) => thenSync(tasks.updateTask(db, id(ctx), ctx.body)));
  r.delete('/api/tasks/:id', (ctx) => thenSync(tasks.deleteTask(db, id(ctx))));

  // --- Settings & Google accounts ---
  r.get('/api/settings', (ctx) => ({ ...settings.publicSettings(db), redirect_uri: google.redirectUri(ctx.origin), sync_choices: settings.SYNC_CHOICES }));
  r.put('/api/settings', (ctx) => ({ ...settings.saveSettings(db, ctx.body), redirect_uri: google.redirectUri(ctx.origin) }));
  r.get('/api/accounts', () => google.listAccounts(db));
  r.put('/api/accounts/:id', (ctx) => google.updateAccount(db, id(ctx), ctx.body));
  r.delete('/api/accounts/:id', (ctx) => google.disconnect(db, id(ctx)));
  r.post('/api/google/connect', (ctx) => google.startConnect(db, ctx.origin, ctx.body.login_hint ? String(ctx.body.login_hint) : null));
  r.post('/api/sync', () => syncAll(db));
  return r;
}

function parseCookies(h = '') {
  return Object.fromEntries(h.split(';').map((p) => p.trim().split('=')).filter(([k]) => k).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

export function createHandler(db, { secureCookies = process.env.NODE_ENV === 'production' } = {}) {
  const router = buildRouter(db);
  const cookieFlags = `HttpOnly; Path=/; SameSite=Strict${secureCookies ? '; Secure' : ''}`;
  return async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const send = (status, body, headers = {}) => { res.writeHead(status, { ...SECURITY_HEADERS, 'Cache-Control': 'no-store', ...headers }); res.end(body); };
    const json = (status, obj, headers = {}) => send(status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', ...headers });

    const origin = `${req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted ? 'https' : 'http'}://${req.headers.host ?? 'localhost'}`;
    if (url.pathname === '/oauth/callback' && req.method === 'GET') return oauthCallback(db, url, send);
    if (!url.pathname.startsWith('/api/')) return serveStatic(url.pathname, send);
    const m = router.match(req.method, url.pathname);
    if (!m) return json(404, { error: 'Not found' });
    if (m.methodNotAllowed) return json(405, { error: 'Method not allowed' });

    const token = parseCookies(req.headers.cookie)[COOKIE];
    const setCookies = [];
    const ctx = {
      params: m.params, query: Object.fromEntries(url.searchParams), body: {}, token, origin,
      ip: req.socket.remoteAddress ?? '',
      user: auth.userFromToken(db, token),
      setSession: (s) => setCookies.push(`${COOKIE}=${s.token}; ${cookieFlags}; Max-Age=${s.maxAge}`),
      clearSession: () => setCookies.push(`${COOKIE}=; ${cookieFlags}; Max-Age=0`),
    };
    const headers = () => (setCookies.length ? { 'Set-Cookie': setCookies } : {});
    try {
      const { opts, handler: fn } = m.route;
      if (req.method !== 'GET') {
        // CSRF defense: browsers won't send this custom header cross-site without a CORS preflight we never grant.
        if (req.headers['x-requested-with'] !== CSRF) throw forbidden('Missing request header');
        ctx.body = await readJson(req, opts.maxBody ?? MAX_BODY);
      }
      if (!opts.public && !ctx.user) throw new AppError(401, 'Please sign in');
      const result = await fn(ctx);
      return json(200, result ?? { ok: true }, headers());
    } catch (e) {
      if (e instanceof AppError || (e.status && e.status < 500)) return json(e.status, { error: e.message, details: e.details }, headers());
      console.error(e);
      return json(500, { error: 'Something went wrong. The error has been logged.' }, headers());
    }
  };
}

/**
 * Google sends the browser back here after sign-in. The session cookie is SameSite=Strict, so it isn't sent on this
 * cross-site redirect; the single-use `state` (only handed out to a signed-in user) is what proves the request is ours.
 */
async function oauthCallback(db, url, send) {
  let to;
  try {
    const r = await google.finishConnect(db, Object.fromEntries(url.searchParams));
    syncSoon(db, 1000);
    to = `/#/settings?connected=${encodeURIComponent(r.email)}`;
  } catch (e) {
    if (!(e instanceof AppError)) console.error(e);
    to = `/#/settings?error=${encodeURIComponent(e instanceof AppError ? e.message : 'Connecting the Google account failed. The error has been logged.')}`;
  }
  return send(302, '', { Location: to });
}

function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new AppError(413, 'Request too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(v && typeof v === 'object' ? v : {}); }
      catch { reject(bad('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

async function serveStatic(pathname, send) {
  let rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  if (rel === '/' || !extname(rel)) rel = '/index.html'; // SPA fallback
  const file = join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) return send(403, 'Forbidden');
  try {
    const s = await stat(file);
    if (!s.isFile()) throw new Error('not a file');
    return send(200, await readFile(file), { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
  } catch {
    return send(404, 'Not found', { 'Content-Type': 'text/plain' });
  }
}
