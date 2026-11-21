// Google sign-in (OAuth 2.0 for a web app) and an authenticated fetch for Google's REST APIs.
// No Google SDK: plain fetch against the documented endpoints, like Ledger's GoHighLevel client.
import { randomBytes } from 'node:crypto';
import { AppError, bad, notFound } from '../util.js';
import { encrypt, decrypt } from '../crypto.js';
import { googleClient, getSetting, setSetting } from './settings.js';

/** Swappable for tests. */
export const http = { fetch: (...a) => globalThis.fetch(...a) };

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

// Read-only mail and calendar; read/write tasks (the only thing the app changes in Google).
export const SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/tasks',
];
const REQUIRED = SCOPES.slice(2);
const SCOPE_NAMES = { 'https://www.googleapis.com/auth/gmail.readonly': 'read your email', 'https://www.googleapis.com/auth/calendar.readonly': 'see your calendars', 'https://www.googleapis.com/auth/tasks': 'manage your tasks' };
const COLORS = ['#b08d57', '#3d5a80', '#2e6b3e', '#7a3e6b', '#a8321f', '#3f7f86', '#8a5a00', '#5c5c5c'];

/** Where Google sends the browser back to: TASKBOARD_PUBLIC_URL, or the address the app was opened at. */
export function redirectUri(origin) {
  return `${(process.env.TASKBOARD_PUBLIC_URL || origin).replace(/\/$/, '')}/oauth/callback`;
}

// Pending sign-ins: state -> { redirect, expires }. Single use, 10 minutes.
const pending = new Map();

export function startConnect(db, origin, loginHint = null) {
  const client = googleClient(db);
  if (!client) throw bad('Add your Google OAuth client ID and secret first (Settings → Google app).');
  const now = Date.now();
  for (const [k, v] of pending) if (v.expires < now) pending.delete(k);
  const state = randomBytes(24).toString('base64url');
  const redirect = redirectUri(origin);
  pending.set(state, { redirect, expires: now + 10 * 60_000 });
  const q = new URLSearchParams({
    client_id: client.id, redirect_uri: redirect, response_type: 'code', scope: SCOPES.join(' '), state,
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', ...(loginHint ? { login_hint: loginHint } : {}),
  });
  return { url: `${AUTH_URL}?${q}`, redirect_uri: redirect };
}

async function postForm(url, params) {
  const res = await http.fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString(), signal: AbortSignal.timeout(30_000) });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

/** Handle Google's redirect: check state, swap the code for tokens, save the account. Returns { email }. */
export async function finishConnect(db, query) {
  const p = pending.get(String(query.state ?? ''));
  pending.delete(String(query.state ?? ''));
  if (!p || p.expires < Date.now()) throw bad('That sign-in link expired. Start again from Settings.');
  if (query.error) throw bad(query.error === 'access_denied' ? 'Google sign-in was cancelled.' : `Google said: ${query.error}`);
  const client = googleClient(db);
  if (!client) throw bad('The Google app settings are missing.');

  const tok = await postForm(TOKEN_URL, { code: String(query.code ?? ''), client_id: client.id, client_secret: client.secret, redirect_uri: p.redirect, grant_type: 'authorization_code' });
  if (!tok.ok) throw bad(`Google did not accept the sign-in (${tok.data.error_description || tok.data.error || tok.status}).`);
  const granted = String(tok.data.scope ?? '').split(/\s+/);
  const missing = REQUIRED.filter((s) => !granted.includes(s));
  if (missing.length) throw bad(`Please connect again and tick every box. The board needs permission to ${missing.map((s) => SCOPE_NAMES[s]).join(' and ')}.`);
  if (!tok.data.refresh_token) throw bad('Google did not return a long-lived token. Remove "McKay\'s Taskboard" at myaccount.google.com/permissions and connect again.');

  const ui = await http.fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${tok.data.access_token}` }, signal: AbortSignal.timeout(30_000) });
  const info = await ui.json().catch(() => ({}));
  if (!ui.ok || !info.email) throw bad('Could not read the Google account email.');
  const email = String(info.email).toLowerCase();

  const existing = db.get('SELECT id FROM accounts WHERE email = ?', email);
  const enc = encrypt(tok.data.refresh_token);
  let id;
  if (existing) {
    id = existing.id;
    db.run('UPDATE accounts SET refresh_token_enc = ?, scopes = ?, needs_reconnect = 0 WHERE id = ?', enc, granted.join(' '), id);
  } else {
    const n = db.get('SELECT COUNT(*) AS n FROM accounts').n;
    id = db.insert('INSERT INTO accounts (email, domain, color, refresh_token_enc, scopes) VALUES (?,?,?,?,?)', email, email.split('@')[1], COLORS[n % COLORS.length], enc, granted.join(' '));
    if (!getSetting(db, 'primary_account_id')) setSetting(db, 'primary_account_id', id);
  }
  tokens.set(id, { token: tok.data.access_token, expires: Date.now() + (Number(tok.data.expires_in) || 3600) * 1000 });
  return { id, email };
}

// Access tokens live in memory only.
const tokens = new Map();
export const forgetTokens = () => tokens.clear();

/** Raised when Google no longer accepts an account's refresh token (password change, revoked, removed). */
export class ReconnectNeeded extends AppError {
  constructor(email) { super(409, `${email} needs to be reconnected`); }
}

export async function accessToken(db, account, { force = false } = {}) {
  const c = tokens.get(account.id);
  if (!force && c && c.expires - 60_000 > Date.now()) return c.token;
  const client = googleClient(db);
  if (!client) throw bad('The Google app settings are missing.');
  if (!account.refresh_token_enc) throw new ReconnectNeeded(account.email);
  const r = await postForm(TOKEN_URL, { client_id: client.id, client_secret: client.secret, refresh_token: decrypt(account.refresh_token_enc), grant_type: 'refresh_token' });
  if (!r.ok) {
    if (r.data.error === 'invalid_grant' || r.data.error === 'unauthorized_client') {
      db.run('UPDATE accounts SET needs_reconnect = 1 WHERE id = ?', account.id);
      throw new ReconnectNeeded(account.email);
    }
    throw new AppError(502, `Google sign-in refresh failed for ${account.email} (${r.data.error || r.status})`);
  }
  tokens.set(account.id, { token: r.data.access_token, expires: Date.now() + (Number(r.data.expires_in) || 3600) * 1000 });
  return r.data.access_token;
}

/**
 * Call a Google API as an account. JSON in and out; retries once on an expired token, and once after a short wait
 * on rate limits and server errors. Returns null for 204/empty bodies.
 */
export async function gfetch(db, account, url, { method = 'GET', body } = {}) {
  let lastStatus = 0;
  for (let attempt = 0; ; attempt++) {
    const token = await accessToken(db, account, { force: lastStatus === 401 });
    const res = await http.fetch(url, {
      method, signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    lastStatus = res.status;
    if (res.ok) {
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    }
    const retryable = res.status === 401 || res.status === 429 || res.status >= 500;
    if (retryable && attempt === 0) {
      if (res.status !== 401) await new Promise((r) => setTimeout(r, Number(process.env.TASKBOARD_RETRY_MS ?? 2000)));
      continue;
    }
    const err = await res.json().catch(() => ({}));
    const e = new AppError(res.status === 404 ? 404 : 502, `Google ${method} ${new URL(url).pathname} failed (${res.status}${err.error?.message ? `: ${err.error.message}` : ''})`);
    e.googleStatus = res.status;
    throw e;
  }
}

const publicAccount = (a) => ({
  id: a.id, email: a.email, domain: a.domain, color: a.color, needs_reconnect: !!a.needs_reconnect,
  last_sync_at: a.last_sync_at, last_result: a.last_result ? JSON.parse(a.last_result) : null,
  open_tasks: a.open_tasks ?? 0,
});

export const listAccounts = (db) => db.all(`SELECT a.*, (SELECT COUNT(*) FROM tasks t WHERE t.account_id = a.id AND t.status = 'open') AS open_tasks FROM accounts a ORDER BY a.id`).map(publicAccount);

export function getAccount(db, id) {
  const a = db.get('SELECT * FROM accounts WHERE id = ?', id);
  if (!a) throw notFound('Account');
  return a;
}

export function updateAccount(db, id, body) {
  getAccount(db, id);
  if (body.color !== undefined) {
    if (!/^#[0-9a-f]{6}$/i.test(String(body.color))) throw bad('Pick a color');
    db.run('UPDATE accounts SET color = ? WHERE id = ?', body.color, id);
  }
  return listAccounts(db).find((a) => a.id === id);
}

/** Stop syncing an account: revoke Google access (best effort) and forget its token. Its tasks stay on the board. */
export async function disconnect(db, id) {
  const a = getAccount(db, id);
  if (a.refresh_token_enc) {
    try { await http.fetch(REVOKE_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: decrypt(a.refresh_token_enc) }).toString(), signal: AbortSignal.timeout(15_000) }); }
    catch { /* revoking is a courtesy; the token is deleted here either way */ }
  }
  tokens.delete(id);
  db.tx(() => {
    db.run(`UPDATE tasks SET origin = CASE WHEN origin = 'gtasks' THEN 'manual' ELSE origin END, gtask_id = NULL, gtask_list_id = NULL, gtask_updated = NULL WHERE account_id = ?`, id);
    db.run('DELETE FROM accounts WHERE id = ?', id);
    if (Number(getSetting(db, 'primary_account_id')) === id) setSetting(db, 'primary_account_id', db.get('SELECT id FROM accounts ORDER BY id LIMIT 1')?.id ?? null);
  });
  return { ok: true };
}
