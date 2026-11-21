// Single-owner login (adapted from Trendwise Ledger's auth.js, without roles).
import { scryptSync, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { bad, forbidden, str, AppError } from './util.js';

const SESSION_DAYS = 30;
const SCRYPT = { N: 16384, r: 8, p: 1 };

export function hashPassword(pw) {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${scryptSync(pw, salt, 64, SCRYPT).toString('hex')}`;
}
export function verifyPassword(pw, stored) {
  const [alg, saltHex, hashHex] = String(stored).split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  return timingSafeEqual(expected, scryptSync(pw, Buffer.from(saltHex, 'hex'), expected.length, SCRYPT));
}

const tokenHash = (t) => createHash('sha256').update(t).digest('hex');
const publicUser = (u) => u && ({ id: u.id, email: u.email, name: u.name });

export const needsSetup = (db) => !db.get('SELECT 1 FROM users LIMIT 1');

export function setupOwner(db, body) {
  if (!needsSetup(db)) throw forbidden('Setup has already been completed');
  const email = str(body.email, 200)?.toLowerCase();
  const name = str(body.name, 120);
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('A valid email is required');
  if (!name) throw bad('Name is required');
  if (typeof body.password !== 'string' || body.password.length < 10) throw bad('Password must be at least 10 characters');
  db.insert('INSERT INTO users (email, name, password_hash) VALUES (?,?,?)', email, name, hashPassword(body.password));
  return login(db, { email, password: body.password });
}

// In-memory login throttle: 10 failures per email+ip per 15 minutes.
const failures = new Map();
const WINDOW = 15 * 60_000;
export function login(db, { email, password }, ip = '') {
  const key = `${String(email).toLowerCase()}|${ip}`;
  const f = failures.get(key);
  if (f && f.count >= 10 && Date.now() - f.first < WINDOW) throw new AppError(429, 'Too many failed attempts. Try again in 15 minutes.');
  const u = db.get('SELECT * FROM users WHERE email = ?', String(email ?? '').toLowerCase());
  if (!u || !verifyPassword(String(password ?? ''), u.password_hash)) {
    failures.set(key, f && Date.now() - f.first < WINDOW ? { ...f, count: f.count + 1 } : { count: 1, first: Date.now() });
    throw bad('Incorrect email or password');
  }
  failures.delete(key);
  const token = randomBytes(32).toString('base64url');
  db.run('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)', tokenHash(token), u.id, new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString());
  db.run('DELETE FROM sessions WHERE expires_at < ?', new Date().toISOString());
  return { token, user: publicUser(u), maxAge: SESSION_DAYS * 86400 };
}

export function logout(db, token) {
  if (token) db.run('DELETE FROM sessions WHERE token_hash = ?', tokenHash(token));
}

export function userFromToken(db, token) {
  if (!token) return null;
  return publicUser(db.get('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?', tokenHash(token), new Date().toISOString()));
}
