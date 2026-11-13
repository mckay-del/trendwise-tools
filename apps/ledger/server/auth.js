import { scryptSync, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { bad, notFound, forbidden, str, AppError } from './util.js';
import { audit } from './services/audit.js';

const SESSION_DAYS = 14;
export const ROLES = ['admin', 'accountant', 'standard', 'viewer'];
const SCRYPT = { N: 16384, r: 8, p: 1 };

export function hashPassword(pw) {
  const salt = randomBytes(16);
  const hash = scryptSync(pw, salt, 64, SCRYPT);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(pw, stored) {
  const [alg, saltHex, hashHex] = String(stored).split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(pw, Buffer.from(saltHex, 'hex'), expected.length, SCRYPT);
  return timingSafeEqual(expected, actual);
}

const tokenHash = (t) => createHash('sha256').update(t).digest('hex');
const publicUser = (u) => u && ({ id: u.id, email: u.email, name: u.name, role: u.role, is_active: u.is_active, created_at: u.created_at });

function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 10) throw bad('Password must be at least 10 characters');
}

export const needsSetup = (db) => !db.get('SELECT 1 FROM users LIMIT 1');

export function setupFirstUser(db, body) {
  if (!needsSetup(db)) throw forbidden('Setup has already been completed');
  return createUser(db, { ...body, role: 'admin' });
}

export function createUser(db, body, actorId = null) {
  const email = str(body.email, 200)?.toLowerCase();
  const name = str(body.name, 120);
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('A valid email is required');
  if (!name) throw bad('Name is required');
  validatePassword(body.password);
  const role = ROLES.includes(body.role) ? body.role : 'standard';
  if (db.get('SELECT 1 FROM users WHERE email = ?', email)) throw bad('A user with that email already exists');
  const id = db.insert('INSERT INTO users (email, name, password_hash, role) VALUES (?,?,?,?)', email, name, hashPassword(body.password), role);
  audit(db, { userId: actorId ?? id, action: 'create', entity: 'user', entityId: id, summary: `${email} (${role})` });
  return publicUser(db.get('SELECT * FROM users WHERE id = ?', id));
}

export function updateUser(db, id, body, actor) {
  const u = db.get('SELECT * FROM users WHERE id = ?', id);
  if (!u) throw notFound('User');
  const role = body.role === undefined ? u.role : body.role;
  if (!ROLES.includes(role)) throw bad('Invalid role');
  const active = body.is_active === undefined ? u.is_active : body.is_active ? 1 : 0;
  if (u.id === actor.id && (role !== 'admin' || !active)) throw bad("You can't remove your own admin access");
  if (body.password) validatePassword(body.password);
  db.run('UPDATE users SET name=?, role=?, is_active=?, password_hash=? WHERE id=?', str(body.name, 120) ?? u.name, role, active, body.password ? hashPassword(body.password) : u.password_hash, id);
  if (!active || body.password) db.run('DELETE FROM sessions WHERE user_id = ? AND user_id != ?', id, actor.id);
  audit(db, { userId: actor.id, action: 'update', entity: 'user', entityId: id, summary: `${u.email}: role ${role}${active ? '' : ', deactivated'}${body.password ? ', password reset' : ''}` });
  return publicUser(db.get('SELECT * FROM users WHERE id = ?', id));
}

export const listUsers = (db) => db.all('SELECT * FROM users ORDER BY name').map(publicUser);

// In-memory login throttle: 10 failures per email+ip per 15 minutes.
const failures = new Map();
const WINDOW = 15 * 60_000;
export function login(db, { email, password }, ip = '') {
  const key = `${String(email).toLowerCase()}|${ip}`;
  const f = failures.get(key);
  if (f && f.count >= 10 && Date.now() - f.first < WINDOW) throw new AppError(429, 'Too many failed attempts. Try again in 15 minutes.');
  const u = db.get('SELECT * FROM users WHERE email = ? AND is_active = 1', String(email ?? '').toLowerCase());
  if (!u || !verifyPassword(String(password ?? ''), u.password_hash)) {
    failures.set(key, f && Date.now() - f.first < WINDOW ? { ...f, count: f.count + 1 } : { count: 1, first: Date.now() });
    throw bad('Incorrect email or password');
  }
  failures.delete(key);
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
  db.run('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)', tokenHash(token), u.id, expires);
  db.run('DELETE FROM sessions WHERE expires_at < ?', new Date().toISOString());
  return { token, user: publicUser(u), maxAge: SESSION_DAYS * 86400 };
}

export function logout(db, token) {
  if (token) db.run('DELETE FROM sessions WHERE token_hash = ?', tokenHash(token));
}

export function userFromToken(db, token) {
  if (!token) return null;
  const row = db.get('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND u.is_active = 1', tokenHash(token), new Date().toISOString());
  return publicUser(row);
}

/** Role capabilities. viewer = read only; standard = day-to-day entry; accountant = + close books; admin = + users. */
export const can = {
  write: (u) => !!u && u.role !== 'viewer',
  closeBooks: (u) => !!u && (u.role === 'admin' || u.role === 'accountant'),
  admin: (u) => !!u && u.role === 'admin',
};
