// Reading spreadsheet-like uploads: CSV text or Excel .xlsx (first worksheet). No dependencies.
import { inflateRawSync } from 'node:zlib';
import { bad } from '../util.js';

export function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"' && s[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

// --- Minimal ZIP + XLSX reader ---------------------------------------------

function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw bad('That file is not a valid Excel workbook (.xlsx). Older .xls files must be re-saved as .xlsx or CSV.');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    files.set(name, { method, csize, off });
    p += 46 + nlen + elen + clen;
  }
  return (name) => {
    const f = files.get(name);
    if (!f) return null;
    const start = f.off + 30 + buf.readUInt16LE(f.off + 26) + buf.readUInt16LE(f.off + 28);
    const data = buf.subarray(start, start + f.csize);
    if (f.method === 0) return data.toString('utf8');
    if (f.method === 8) return inflateRawSync(data).toString('utf8');
    throw bad('Unsupported compression in workbook');
  };
}

const xmlText = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&amp;/g, '&');
const allT = (s) => [...s.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => xmlText(m[1])).join('');
const colIndex = (ref) => { let n = 0; for (const ch of ref.replace(/\d+/g, '')) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };

export function readXlsx(buf) {
  const get = unzip(buf);
  const shared = [];
  const ss = get('xl/sharedStrings.xml');
  if (ss) for (const m of ss.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) shared.push(allT(m[1]));
  // First sheet listed in the workbook.
  let sheetPath = 'xl/worksheets/sheet1.xml';
  const wb = get('xl/workbook.xml'), rels = get('xl/_rels/workbook.xml.rels');
  const rid = wb?.match(/<sheet\b[^>]*r:id="([^"]+)"/)?.[1];
  let target = null;
  if (rid && rels) {
    const rel = [...rels.matchAll(/<Relationship\b([^>]*)\/?>/g)].map((m) => m[1]).find((a) => a.includes(`Id="${rid}"`));
    target = rel?.match(/Target="([^"]+)"/)?.[1] ?? null;
  }
  if (target) sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
  const sheet = get(sheetPath);
  if (!sheet) throw bad('Could not find a worksheet in that workbook');
  const rows = [];
  for (const rm of sheet.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const r = [];
    for (const cm of rm[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1], inner = cm[2] ?? '';
      const ref = attrs.match(/\br="([A-Z]+)\d+"/)?.[1];
      const t = attrs.match(/\bt="([^"]+)"/)?.[1];
      const v = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      let val = '';
      if (t === 's') val = shared[Number(v)] ?? '';
      else if (t === 'inlineStr') val = allT(inner);
      else if (t === 'b') val = v === '1' ? 'TRUE' : 'FALSE';
      else val = v !== undefined ? xmlText(v) : '';
      const idx = ref ? colIndex(ref) : r.length;
      while (r.length < idx) r.push('');
      r[idx] = val;
    }
    if (r.some((c) => String(c).trim() !== '')) rows.push(r);
  }
  return rows;
}

/**
 * Turn an uploaded file into rows. Body shape: { content: "<csv text>" } or { data_base64, file_name }.
 * Returns { rows, format } where format is 'csv' | 'xlsx' | 'ofx'.
 */
export function readUpload(body) {
  if (body.data_base64) {
    const buf = Buffer.from(String(body.data_base64), 'base64');
    if (buf.length > 8 * 1024 * 1024) throw bad('File is too large');
    if (buf[0] === 0x50 && buf[1] === 0x4b) return { rows: readXlsx(buf), format: 'xlsx' };
    if (buf[0] === 0xd0 && buf[1] === 0xcf) throw bad('Old-style .xls files aren’t supported. In Excel choose File → Save As → Excel Workbook (.xlsx) or CSV.');
    return readText(buf.toString('utf8'));
  }
  if (typeof body.content !== 'string' || !body.content.trim()) throw bad('No file content');
  return readText(body.content);
}

function readText(text) {
  if (/<OFX>|<STMTTRN>/i.test(text)) return { rows: null, format: 'ofx', text };
  return { rows: parseCsv(text), format: 'csv' };
}

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/[^\w #/&().-]/g, '');

/**
 * Find the header row (within the first 25 rows) that contains the required columns.
 * spec: { key: [synonyms...] }, required: keys that must be present. Returns { index, cols: {key: colIndex|-1} }.
 */
export function findHeader(rows, spec, required) {
  for (let i = 0; i < Math.min(rows.length, 25); i++) {
    const cells = rows[i].map(norm);
    const cols = Object.fromEntries(Object.entries(spec).map(([k, syn]) => [k, cells.findIndex((c) => syn.includes(c))]));
    if (required.every((k) => cols[k] >= 0)) return { index: i, cols };
  }
  return null;
}

/** Excel serial date or text date → ISO yyyy-mm-dd, or null. */
export function toIsoDate(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (n > 20000 && n < 80000) return new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 86400000).toISOString().slice(0, 10);
  }
  let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return iso(+m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/))) { let y = +m[3]; if (y < 100) y += y < 70 ? 2000 : 1900; return iso(y, +m[1], +m[2]); }
  if ((m = s.match(/^(\d{4})(\d{2})(\d{2})/))) return iso(+m[1], +m[2], +m[3]);
  const t = Date.parse(s);
  if (!Number.isNaN(t) && /[a-z]{3}/i.test(s)) { const d = new Date(t); return iso(d.getFullYear(), d.getMonth() + 1, d.getDate()); }
  return null;
}
function iso(y, mo, d) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1) return null;
  return dt.toISOString().slice(0, 10);
}
