export function audit(db, { companyId = null, userId = null, action, entity, entityId = null, summary = null }) {
  db.run('INSERT INTO audit_log (company_id, user_id, action, entity, entity_id, summary) VALUES (?,?,?,?,?,?)',
    companyId, userId, action, entity, entityId, summary);
}

export function listAudit(db, companyId, { limit = 200 } = {}) {
  return db.all(`SELECT l.*, u.name AS user_name FROM audit_log l LEFT JOIN users u ON u.id = l.user_id
    WHERE l.company_id = ? ORDER BY l.id DESC LIMIT ?`, companyId, Math.min(Number(limit) || 200, 2000));
}
