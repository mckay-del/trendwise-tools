// Files attached to transactions. Stored in the database (so backups and restores include them).
// The file type is decided from the file's actual bytes, not its name, and only safe document/image types are accepted.
import { createHash } from 'node:crypto';
import { bad, notFound, str } from '../util.js';
import { audit } from './audit.js';

export const MAX_ATTACHMENT = 10 * 1024 * 1024; // 10 MB per file

const startsWith = (buf, bytes, offset = 0) => bytes.every((b, i) => buf[offset + i] === b);

/** Detect the real type of an upload. Returns { mime, inline } or null. */
export function detectType(buf, fileName = '') {
  const ext = (fileName.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();
  if (startsWith(buf, [0x25, 0x50, 0x44, 0x46])) return { mime: 'application/pdf', inline: true };                    // %PDF
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mime: 'image/png', inline: true };
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return { mime: 'image/jpeg', inline: true };
  if (buf.subarray(0, 6).toString('latin1').match(/^GIF8[79]a$/)) return { mime: 'image/gif', inline: true };
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return { mime: 'image/webp', inline: true };
  if (buf.subarray(4, 8).toString('latin1') === 'ftyp' && /^(heic|heix|mif1|msf1|heim|heis)$/.test(buf.subarray(8, 12).toString('latin1'))) return { mime: 'image/heic', inline: false };
  if (startsWith(buf, [0x50, 0x4b, 0x03, 0x04])) { // zip container: only Office documents
    if (ext === 'xlsx') return { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', inline: false };
    if (ext === 'docx') return { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', inline: false };
    return null;
  }
  if (['csv', 'txt'].includes(ext) && !buf.includes(0) && Buffer.from(buf.toString('utf8'), 'utf8').equals(buf)) return { mime: ext === 'csv' ? 'text/csv' : 'text/plain', inline: false };
  return null;
}

function txnInCompany(db, companyId, txnId) {
  const t = db.get('SELECT id, type, number FROM transactions WHERE id = ? AND company_id = ?', txnId, companyId);
  if (!t) throw notFound('Transaction');
  return t;
}

export function listAttachments(db, companyId, txnId) {
  txnInCompany(db, companyId, txnId);
  return db.all(`SELECT a.id, a.file_name, a.mime, a.size, a.created_at, u.name AS uploaded_by_name FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by
    WHERE a.transaction_id = ? ORDER BY a.id`, txnId);
}

export function addAttachment(db, companyId, txnId, body, userId) {
  const t = txnInCompany(db, companyId, txnId);
  const name = (str(body.file_name, 200) ?? 'file').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');
  if (!body.data_base64) throw bad('Choose a file');
  const buf = Buffer.from(String(body.data_base64), 'base64');
  if (!buf.length) throw bad('That file is empty');
  if (buf.length > MAX_ATTACHMENT) throw bad(`"${name}" is larger than 10 MB. Save a smaller copy (e.g. a lower-resolution scan) and try again.`);
  const type = detectType(buf, name);
  if (!type) throw bad(`"${name}" isn't a supported file. Attach PDFs, photos (JPG, PNG, HEIC), or Excel, Word or CSV files.`);
  const sha = createHash('sha256').update(buf).digest('hex');
  const dup = db.get('SELECT id FROM attachments WHERE transaction_id = ? AND sha256 = ?', txnId, sha);
  if (dup) throw bad(`"${name}" is already attached to this transaction`);
  const id = db.insert('INSERT INTO attachments (company_id, transaction_id, file_name, mime, size, sha256, data, uploaded_by) VALUES (?,?,?,?,?,?,?,?)',
    companyId, txnId, name, type.mime, buf.length, sha, buf, userId);
  audit(db, { companyId, userId, action: 'attach', entity: t.type, entityId: txnId, summary: `${name} (${Math.ceil(buf.length / 1024)} KB)` });
  return db.get('SELECT id, file_name, mime, size, created_at FROM attachments WHERE id = ?', id);
}

export function getAttachmentFile(db, companyId, id) {
  const a = db.get('SELECT * FROM attachments WHERE id = ? AND company_id = ?', id, companyId);
  if (!a) throw notFound('Attachment');
  const inline = ['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(a.mime);
  return { data: Buffer.from(a.data), mime: a.mime, file_name: a.file_name, inline };
}

export function deleteAttachment(db, companyId, id, userId) {
  const a = db.get('SELECT id, transaction_id, file_name FROM attachments WHERE id = ? AND company_id = ?', id, companyId);
  if (!a) throw notFound('Attachment');
  db.run('DELETE FROM attachments WHERE id = ?', id);
  const t = db.get('SELECT type FROM transactions WHERE id = ?', a.transaction_id);
  audit(db, { companyId, userId, action: 'detach', entity: t?.type ?? 'transaction', entityId: a.transaction_id, summary: a.file_name });
  return { ok: true };
}
