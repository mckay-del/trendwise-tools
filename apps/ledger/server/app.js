import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from './router.js';
import { AppError, bad, forbidden, intOrNull } from './util.js';
import * as auth from './auth.js';
import { listAccounts, createAccount, updateAccount, getAccount, ACCOUNT_TYPES } from './services/accounts.js';
import * as names from './services/names.js';
import * as txns from './services/transactions.js';
import * as bank from './services/banking.js';
import * as reports from './services/reports.js';
import { listAudit } from './services/audit.js';
import * as saved from './services/saved.js';
import { getFirm, saveFirm } from './services/firm.js';
import { createBackup, lastBackup } from './backup.js';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
const MAX_BODY = 10 * 1024 * 1024;
const COOKIE = 'ledger_session';

export function buildRouter(db) {
  const r = new Router();
  const company = (ctx) => names.getCompany(db, Number(ctx.params.cid));
  const cid = (ctx) => company(ctx).id;
  const id = (ctx) => Number(ctx.params.id);
  const uid = (ctx) => ctx.user.id;

  // --- Auth (public) ---
  r.get('/api/auth/status', (ctx) => ({ needs_setup: auth.needsSetup(db), user: ctx.user }), { public: true });
  r.post('/api/auth/setup', (ctx) => {
    const user = auth.setupFirstUser(db, ctx.body);
    const s = auth.login(db, { email: user.email, password: ctx.body.password }, ctx.ip);
    ctx.setSession(s);
    return { user };
  }, { public: true });
  r.post('/api/auth/login', (ctx) => { const s = auth.login(db, ctx.body, ctx.ip); ctx.setSession(s); return { user: s.user }; }, { public: true });
  r.post('/api/auth/logout', (ctx) => { auth.logout(db, ctx.token); ctx.clearSession(); return { ok: true }; }, { public: true });

  // --- Users (admin) ---
  r.get('/api/users', () => auth.listUsers(db), { admin: true });
  r.post('/api/users', (ctx) => auth.createUser(db, ctx.body, uid(ctx)), { admin: true });
  r.put('/api/users/:id', (ctx) => auth.updateUser(db, id(ctx), ctx.body, ctx.user), { admin: true });

  // --- Meta ---
  r.get('/api/meta', () => ({ account_types: ACCOUNT_TYPES, txn_types: txns.TXN_TYPES, reports: reports.REPORTS, periods: reports.PERIODS, gl_columns: reports.GL_COLUMNS, gl_default_columns: reports.GL_DEFAULT_COLUMNS }));

  // --- Firm branding & backups ---
  r.get('/api/firm', () => getFirm(db));
  r.put('/api/firm', (ctx) => saveFirm(db, ctx.body, uid(ctx)), { admin: true });
  r.get('/api/backup', () => ({ last_backup: lastBackup(db) }), { admin: true });
  r.post('/api/backup', (ctx) => {
    const bytes = createBackup(db, ctx.body.passphrase);
    return { __raw: bytes, type: 'application/octet-stream', filename: `ledger-backup-${new Date().toISOString().slice(0, 10)}.twlbak` };
  }, { admin: true });

  // --- Companies ---
  r.get('/api/companies', () => names.listCompanies(db));
  r.post('/api/companies', (ctx) => names.createCompany(db, ctx.body, uid(ctx)), { admin: true });
  r.get('/api/c/:cid', (ctx) => company(ctx));
  r.put('/api/c/:cid', (ctx) => {
    const c = company(ctx);
    if (ctx.body.closing_date !== undefined && ctx.body.closing_date !== c.closing_date && !auth.can.closeBooks(ctx.user)) throw forbidden('Only admins and accountants can change the closing date');
    return names.updateCompany(db, c.id, ctx.body, uid(ctx));
  });
  r.get('/api/c/:cid/dashboard', (ctx) => reports.dashboard(db, company(ctx)));
  r.get('/api/c/:cid/audit', (ctx) => listAudit(db, cid(ctx), ctx.query));

  // --- Chart of accounts ---
  r.get('/api/c/:cid/accounts', (ctx) => listAccounts(db, cid(ctx), { includeInactive: ctx.query.inactive === '1' }));
  r.post('/api/c/:cid/accounts', (ctx) => createAccount(db, cid(ctx), ctx.body));
  r.get('/api/c/:cid/accounts/:id', (ctx) => getAccount(db, cid(ctx), id(ctx)));
  r.put('/api/c/:cid/accounts/:id', (ctx) => updateAccount(db, cid(ctx), id(ctx), ctx.body));

  // --- Customers / vendors / items / tax ---
  for (const table of ['customers', 'vendors']) {
    r.get(`/api/c/:cid/${table}`, (ctx) => names.listParties(db, cid(ctx), table, { includeInactive: ctx.query.inactive === '1' }));
    r.post(`/api/c/:cid/${table}`, (ctx) => names.saveParty(db, cid(ctx), table, ctx.body, null, uid(ctx)));
    r.get(`/api/c/:cid/${table}/:id`, (ctx) => names.getParty(db, cid(ctx), table, id(ctx)));
    r.put(`/api/c/:cid/${table}/:id`, (ctx) => names.saveParty(db, cid(ctx), table, ctx.body, id(ctx), uid(ctx)));
  }
  r.get('/api/c/:cid/items', (ctx) => names.listItems(db, cid(ctx), { includeInactive: ctx.query.inactive === '1' }));
  r.post('/api/c/:cid/items', (ctx) => names.saveItem(db, cid(ctx), ctx.body, null, uid(ctx)));
  r.put('/api/c/:cid/items/:id', (ctx) => names.saveItem(db, cid(ctx), ctx.body, id(ctx), uid(ctx)));
  r.get('/api/c/:cid/tax-rates', (ctx) => names.listTaxRates(db, cid(ctx)));
  r.post('/api/c/:cid/tax-rates', (ctx) => names.saveTaxRate(db, cid(ctx), ctx.body, null, uid(ctx)));
  r.put('/api/c/:cid/tax-rates/:id', (ctx) => names.saveTaxRate(db, cid(ctx), ctx.body, id(ctx), uid(ctx)));

  // --- Transactions ---
  r.get('/api/c/:cid/transactions', (ctx) => txns.listTransactions(db, cid(ctx), ctx.query));
  r.post('/api/c/:cid/transactions', (ctx) => txns.createTransaction(db, cid(ctx), ctx.body, uid(ctx)));
  r.get('/api/c/:cid/transactions/:id', (ctx) => txns.getTransaction(db, cid(ctx), id(ctx)));
  r.put('/api/c/:cid/transactions/:id', (ctx) => txns.updateTransaction(db, cid(ctx), id(ctx), ctx.body, uid(ctx)));
  r.delete('/api/c/:cid/transactions/:id', (ctx) => txns.deleteTransaction(db, cid(ctx), id(ctx), uid(ctx)));
  r.post('/api/c/:cid/transactions/:id/void', (ctx) => txns.voidTransaction(db, cid(ctx), id(ctx), uid(ctx)));
  r.get('/api/c/:cid/open-documents', (ctx) => txns.openDocuments(db, cid(ctx), { type: ctx.query.type === 'bill' ? 'bill' : 'invoice', customer_id: ctx.query.customer_id, vendor_id: ctx.query.vendor_id, exclude_source_id: ctx.query.exclude }));
  r.get('/api/c/:cid/undeposited', (ctx) => txns.undepositedFunds(db, cid(ctx), Number(ctx.query.exclude) || 0));

  // --- Banking ---
  r.post('/api/c/:cid/bank/import', (ctx) => bank.importStatement(db, cid(ctx), ctx.body, uid(ctx)));
  r.get('/api/c/:cid/bank/feed', (ctx) => bank.listFeed(db, cid(ctx), ctx.query));
  r.put('/api/c/:cid/bank/feed/:id', (ctx) => bank.updateFeedSuggestion(db, cid(ctx), id(ctx), ctx.body));
  r.post('/api/c/:cid/bank/feed/:id/add', (ctx) => bank.addFromFeed(db, cid(ctx), id(ctx), ctx.body, uid(ctx)));
  r.post('/api/c/:cid/bank/feed/:id/match', (ctx) => bank.matchFeed(db, cid(ctx), id(ctx), ctx.body, uid(ctx)));
  r.post('/api/c/:cid/bank/feed/:id/exclude', (ctx) => bank.excludeFeed(db, cid(ctx), id(ctx), uid(ctx)));
  r.post('/api/c/:cid/bank/feed/:id/undo', (ctx) => bank.undoFeed(db, cid(ctx), id(ctx), uid(ctx)));
  r.get('/api/c/:cid/bank/rules', (ctx) => bank.listRules(db, cid(ctx)));
  r.post('/api/c/:cid/bank/rules', (ctx) => bank.saveRule(db, cid(ctx), ctx.body, null, uid(ctx)));
  r.put('/api/c/:cid/bank/rules/:id', (ctx) => bank.saveRule(db, cid(ctx), ctx.body, id(ctx), uid(ctx)));
  r.delete('/api/c/:cid/bank/rules/:id', (ctx) => bank.deleteRule(db, cid(ctx), id(ctx)));
  r.post('/api/c/:cid/bank/rules/apply', (ctx) => bank.applyRules(db, cid(ctx), { account_id: intOrNull(ctx.body.account_id) }, uid(ctx)));

  // --- Reconcile ---
  r.get('/api/c/:cid/reconcile/:id', (ctx) => bank.reconcileState(db, cid(ctx), id(ctx), ctx.query.statement_date || null));
  r.put('/api/c/:cid/reconcile/:id', (ctx) => bank.saveClearedFlags(db, cid(ctx), id(ctx), ctx.body));
  r.post('/api/c/:cid/reconcile/:id/finish', (ctx) => bank.finishReconciliation(db, cid(ctx), id(ctx), ctx.body, uid(ctx)), { closeBooks: false });
  r.post('/api/c/:cid/reconcile/:id/undo', (ctx) => bank.undoLastReconciliation(db, cid(ctx), id(ctx), uid(ctx)), { closeBooks: true });

  // --- Saved reports ---
  r.get('/api/c/:cid/saved-reports', (ctx) => saved.listSaved(db, cid(ctx)));
  r.post('/api/c/:cid/saved-reports', (ctx) => saved.saveReport(db, cid(ctx), ctx.body, null, uid(ctx)));
  r.put('/api/c/:cid/saved-reports/:id', (ctx) => saved.saveReport(db, cid(ctx), ctx.body, id(ctx), uid(ctx)));
  r.delete('/api/c/:cid/saved-reports/:id', (ctx) => saved.deleteSaved(db, cid(ctx), id(ctx), uid(ctx)));

  // --- Reports ---
  r.get('/api/c/:cid/reports/:name', (ctx) => {
    const rep = reports.runReport(db, company(ctx), ctx.params.name, ctx.query);
    if (ctx.query.format === 'csv') return { __raw: reports.toCsv(rep), type: 'text/csv; charset=utf-8', filename: `${ctx.params.name}.csv` };
    return rep;
  });
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
  return async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { ...SECURITY_HEADERS, 'Cache-Control': 'no-store', ...headers });
      res.end(body);
    };
    const json = (status, obj, headers = {}) => send(status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', ...headers });

    if (!url.pathname.startsWith('/api/')) return serveStatic(url.pathname, send);

    const m = router.match(req.method, url.pathname);
    if (!m) return json(404, { error: 'Not found' });
    if (m.methodNotAllowed) return json(405, { error: 'Method not allowed' });

    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[COOKIE];
    const setCookies = [];
    const ctx = {
      params: m.params,
      query: Object.fromEntries(url.searchParams),
      body: {},
      token,
      ip: req.socket.remoteAddress ?? '',
      user: auth.userFromToken(db, token),
      setSession: (s) => setCookies.push(`${COOKIE}=${s.token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${s.maxAge}${secureCookies ? '; Secure' : ''}`),
      clearSession: () => setCookies.push(`${COOKIE}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0${secureCookies ? '; Secure' : ''}`),
    };
    try {
      const { opts, handler: fn } = m.route;
      const mutating = req.method !== 'GET';
      if (mutating) {
        // CSRF defense: browsers won't send this custom header cross-site without a CORS preflight we never grant.
        if (req.headers['x-requested-with'] !== 'ledger') throw forbidden('Missing request header');
        ctx.body = await readJson(req);
      }
      if (!opts.public && !ctx.user) throw new AppError(401, 'Please sign in');
      if (opts.admin && !auth.can.admin(ctx.user)) throw forbidden('Admins only');
      if (opts.closeBooks && !auth.can.closeBooks(ctx.user)) throw forbidden('Only admins and accountants can do this');
      if (mutating && !opts.public && !auth.can.write(ctx.user)) throw forbidden('Your role is read-only');
      const result = await fn(ctx);
      const headers = setCookies.length ? { 'Set-Cookie': setCookies } : {};
      if (result && result.__raw !== undefined) return send(200, result.__raw, { 'Content-Type': result.type, 'Content-Disposition': `attachment; filename="${result.filename}"`, ...headers });
      return json(200, result ?? { ok: true }, headers);
    } catch (e) {
      const headers = setCookies.length ? { 'Set-Cookie': setCookies } : {};
      if (e instanceof AppError || (e.status && e.status < 500)) return json(e.status, { error: e.message, details: e.details }, headers);
      if (/UNIQUE constraint failed/.test(e.message)) return json(400, { error: 'That name or number is already in use' }, headers);
      if (/FOREIGN KEY constraint failed/.test(e.message)) return json(400, { error: 'This record is in use and cannot be removed' }, headers);
      console.error(e);
      return json(500, { error: 'Something went wrong. The error has been logged.' }, headers);
    }
  };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(new AppError(413, 'Request too large')); req.destroy(); } else chunks.push(c); });
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
    const body = await readFile(file);
    return send(200, body, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
  } catch {
    return send(404, 'Not found', { 'Content-Type': 'text/plain' });
  }
}
