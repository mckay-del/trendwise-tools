import { bad, str } from '../util.js';
import { audit } from './audit.js';

/** Firm-wide branding used on client report packages. Stored as JSON in schema_meta. */
export const DEFAULT_FIRM = {
  name: 'Trendwise Business Services',
  tagline: '',
  contact: '',
  logo: null, // data:image/png|jpeg|svg+xml;base64,...
  accent: '#0f766e',
  footer: 'Prepared from the books and records of the company without audit, review, or compilation. No assurance is provided on these financial statements.',
};

const MAX_LOGO = 400 * 1024; // characters of data URL (~300 KB image)

export function getFirm(db) {
  const row = db.get("SELECT value FROM schema_meta WHERE key = 'firm'");
  return { ...DEFAULT_FIRM, ...(row ? JSON.parse(row.value) : {}) };
}

export function saveFirm(db, body, userId) {
  const cur = getFirm(db);
  const next = {
    name: str(body.name ?? cur.name, 120) ?? DEFAULT_FIRM.name,
    tagline: str(body.tagline ?? cur.tagline, 200) ?? '',
    contact: str(body.contact ?? cur.contact, 500) ?? '',
    footer: str(body.footer ?? cur.footer, 1000) ?? '',
    accent: body.accent === undefined ? cur.accent : String(body.accent),
    logo: body.logo === undefined ? cur.logo : body.logo || null,
  };
  if (!/^#[0-9a-fA-F]{6}$/.test(next.accent)) throw bad('Accent color must look like #0f766e');
  if (next.logo) {
    if (typeof next.logo !== 'string' || !/^data:image\/(png|jpeg|svg\+xml|webp);base64,[A-Za-z0-9+/=]+$/.test(next.logo)) throw bad('Logo must be a PNG, JPEG, WebP or SVG image');
    if (next.logo.length > MAX_LOGO) throw bad('Logo is too large (max about 300 KB)');
  }
  db.run("INSERT INTO schema_meta (key, value) VALUES ('firm', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify(next));
  audit(db, { userId, action: 'update', entity: 'firm', summary: 'Firm branding updated' });
  return next;
}
