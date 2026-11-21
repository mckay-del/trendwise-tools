/** Application error carrying an HTTP status. */
export class AppError extends Error {
  constructor(status, message, details) { super(message); this.status = status; this.details = details; }
}
export const bad = (msg, details) => new AppError(400, msg, details);
export const notFound = (what = 'Record') => new AppError(404, `${what} not found`);
export const forbidden = (msg = 'Not allowed') => new AppError(403, msg);

const ISO = /^\d{4}-\d{2}-\d{2}$/;
export function isDate(s) {
  if (typeof s !== 'string' || !ISO.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
export function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Today's date (YYYY-MM-DD) in the board's time zone, so "Today" flips at local midnight, not UTC. */
export const TZ = process.env.TASKBOARD_TZ || 'America/Los_Angeles';
export const today = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

export function str(v, max = 500) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s.slice(0, max);
}
