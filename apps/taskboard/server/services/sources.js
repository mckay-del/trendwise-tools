// Emails and calendar events the assistant looks at. One row per thread / event, per account.

/**
 * Insert or refresh a source. When its content changed (new message in the thread, event edited) it is queued for
 * the assistant again. Returns 'new', 'changed' or 'same'.
 */
export function upsertSource(db, accountId, s) {
  const row = db.get('SELECT id, content_hash FROM sources WHERE account_id = ? AND kind = ? AND external_id = ?', accountId, s.kind, s.external_id);
  const meta = JSON.stringify(s.meta ?? {});
  if (!row) {
    db.insert(`INSERT INTO sources (account_id, kind, external_id, title, snippet, link, content_hash, meta, excerpt, occurred_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`, accountId, s.kind, s.external_id, s.title, s.snippet, s.link, s.content_hash, meta, s.excerpt, s.occurred_at);
    return 'new';
  }
  if (row.content_hash === s.content_hash) return 'same';
  db.run(`UPDATE sources SET title = ?, snippet = ?, link = ?, content_hash = ?, meta = ?, excerpt = ?, occurred_at = ?,
    processed_at = NULL, attempts = 0, last_error = NULL WHERE id = ?`, s.title, s.snippet, s.link, s.content_hash, meta, s.excerpt, s.occurred_at, row.id);
  return 'changed';
}

export const findSource = (db, accountId, kind, externalId) => db.get('SELECT * FROM sources WHERE account_id = ? AND kind = ? AND external_id = ?', accountId, kind, externalId);

/** Plain text for the assistant: collapse whitespace and cap the length. */
export function clip(text, max) {
  const s = String(text ?? '').replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function htmlToText(html) {
  return String(html ?? '')
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
