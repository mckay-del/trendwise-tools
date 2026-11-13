/** Application error carrying an HTTP status. */
export class AppError extends Error {
  constructor(status, message, details) { super(message); this.status = status; this.details = details; }
}
export const bad = (msg, details) => new AppError(400, msg, details);
export const notFound = (what = 'Record') => new AppError(404, `${what} not found`);
export const forbidden = (msg = 'Not allowed') => new AppError(403, msg);

/** Parse a user-supplied money value (number of dollars or string like "$1,234.50") into integer cents. */
export function toCents(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw bad('Invalid amount');
    return Math.round(v * 100);
  }
  let s = String(v).trim();
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/[$,\s]/g, '');
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); }
  if (!/^\d*(\.\d+)?$/.test(s) || s === '' || s === '.') throw bad(`Invalid amount: ${v}`);
  const [whole, frac = ''] = s.split('.');
  const cents = Number(whole || 0) * 100 + Math.round(Number(('0.' + frac) || 0) * 100);
  return neg ? -cents : cents;
}

export const fmtMoney = (c) => (c < 0 ? '-' : '') + '$' + (Math.abs(c) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

const ISO = /^\d{4}-\d{2}-\d{2}$/;
export function isDate(s) {
  if (typeof s !== 'string' || !ISO.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
export function requireDate(s, field = 'date') {
  if (!isDate(s)) throw bad(`${field} must be a valid date (YYYY-MM-DD)`);
  return s;
}
export function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}
export const today = () => new Date().toISOString().slice(0, 10);

export function str(v, max = 500) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s.slice(0, max);
}
export function intOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n)) throw bad(`Invalid id: ${v}`);
  return n;
}
