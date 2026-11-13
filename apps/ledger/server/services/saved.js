import { bad, notFound, str } from '../util.js';
import { REPORTS } from './reports.js';
import { audit } from './audit.js';

// Only these query keys are persisted; anything else (e.g. format=csv) is dropped.
const ALLOWED = ['period', 'from', 'to', 'asof', 'basis', 'columns', 'compare', 'show_change', 'show_pct', 'pct_income', 'show_zero',
  'customer_id', 'vendor_id', 'account_id', 'cols', 'sort', 'hide_empty', 'year'];

function cleanParams(params) {
  if (!params || typeof params !== 'object') return {};
  const out = {};
  for (const k of ALLOWED) if (params[k] !== undefined && params[k] !== null && params[k] !== '') out[k] = String(params[k]).slice(0, 500);
  // A relative period wins over fixed dates so the report stays current.
  if (out.period) { delete out.from; delete out.to; delete out.asof; }
  return out;
}

const view = (r) => ({ ...r, params: JSON.parse(r.params), report_title: REPORTS[r.report]?.title ?? r.report });

export function listSaved(db, companyId) {
  return db.all('SELECT s.*, u.name AS created_by_name FROM saved_reports s LEFT JOIN users u ON u.id = s.created_by WHERE s.company_id = ? ORDER BY s.name COLLATE NOCASE', companyId).map(view);
}

export function saveReport(db, companyId, body, id = null, userId = null) {
  const existing = id ? db.get('SELECT * FROM saved_reports WHERE id = ? AND company_id = ?', id, companyId) : null;
  if (id && !existing) throw notFound('Saved report');
  const name = str(body.name ?? existing?.name, 100);
  if (!name) throw bad('Give the report a name');
  const report = body.report ?? existing?.report;
  if (!REPORTS[report]) throw bad('Unknown report');
  if (db.get('SELECT 1 FROM saved_reports WHERE company_id = ? AND name = ? AND id != ?', companyId, name, id ?? 0)) throw bad(`A saved report named "${name}" already exists`);
  const params = JSON.stringify(body.params === undefined ? JSON.parse(existing.params) : cleanParams(body.params));
  if (existing) db.run("UPDATE saved_reports SET name=?, report=?, params=?, updated_at=datetime('now') WHERE id=?", name, report, params, id);
  else id = db.insert('INSERT INTO saved_reports (company_id, name, report, params, created_by) VALUES (?,?,?,?,?)', companyId, name, report, params, userId);
  audit(db, { companyId, userId, action: existing ? 'update' : 'create', entity: 'saved_report', entityId: id, summary: name });
  return view(db.get('SELECT * FROM saved_reports WHERE id = ?', id));
}

export function deleteSaved(db, companyId, id, userId = null) {
  const r = db.get('SELECT * FROM saved_reports WHERE id = ? AND company_id = ?', id, companyId);
  if (!r) throw notFound('Saved report');
  db.run('DELETE FROM saved_reports WHERE id = ?', id);
  audit(db, { companyId, userId, action: 'delete', entity: 'saved_report', entityId: id, summary: r.name });
  return { ok: true };
}
