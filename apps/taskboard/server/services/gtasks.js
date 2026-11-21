// Two-way sync between the board and Google Tasks, one Google account at a time.
//
// Pull: every task list in the account. New open tasks become cards; edits, completions and deletions made in
//       Google (on the phone) are applied to their cards.
// Push: cards changed here are written back. New cards go to a "Taskboard" list in the card's account
//       (manual cards: the primary account). The column is written at the end of the notes, e.g. [Taskboard: Today].
// Conflicts: if a card changed on both sides since the last sync, the board's version wins, except that a task
//       completed in Google is always completed here.
import { gfetch } from './google.js';
import { getSetting } from './settings.js';
import { COLUMNS, columnForDue, endPosition } from './tasks.js';

const API = 'https://tasks.googleapis.com/tasks/v1';
const LABEL = Object.fromEntries(COLUMNS.map((c) => [c.id, c.label]));
const MARKER = /\s*\[Taskboard: [^\]\n]*\]\s*$/;

export const stripMarker = (notes) => {
  const s = String(notes ?? '').replace(MARKER, '').trim();
  return s === '' ? null : s;
};
export const withMarker = (notes, col) => `${notes ? `${notes}\n\n` : ''}[Taskboard: ${LABEL[col]}]`;
const dueFromGoogle = (due) => (due ? String(due).slice(0, 10) : null);
const dueToGoogle = (due) => (due ? `${due}T00:00:00.000Z` : null);
const enc = encodeURIComponent;

async function allPages(db, account, url, key = 'items') {
  const out = [];
  let pageToken = null;
  do {
    const u = new URL(url);
    if (pageToken) u.searchParams.set('pageToken', pageToken);
    const r = await gfetch(db, account, u.toString());
    out.push(...(r?.[key] ?? []));
    pageToken = r?.nextPageToken;
  } while (pageToken);
  return out;
}

/** The account's list for new cards, found by name or created. */
async function ensureList(db, account, lists) {
  if (account.gtasks_list_id && lists.some((l) => l.id === account.gtasks_list_id)) return account.gtasks_list_id;
  const title = getSetting(db, 'gtasks_list_title', 'Taskboard');
  const found = lists.find((l) => l.title === title) ?? await gfetch(db, account, `${API}/users/@me/lists`, { method: 'POST', body: { title } });
  if (!lists.includes(found)) lists.push(found);
  db.run('UPDATE accounts SET gtasks_list_id = ? WHERE id = ?', found.id, account.id);
  account.gtasks_list_id = found.id;
  return found.id;
}

export async function syncAccount(db, account) {
  const stats = { imported: 0, updated: 0, completed: 0, removed: 0, pushed: 0, created: 0, deleted: 0 };
  const startedAt = new Date().toISOString();
  const lists = await allPages(db, account, `${API}/users/@me/lists?maxResults=100`);
  const listId = await ensureList(db, account, lists);

  // ---- Pull ----
  const since = account.gtasks_synced_at ? new Date(Date.parse(account.gtasks_synced_at) - 2 * 60_000).toISOString() : null;
  for (const list of lists) {
    const u = new URL(`${API}/lists/${enc(list.id)}/tasks`);
    u.searchParams.set('maxResults', '100');
    u.searchParams.set('showHidden', 'true');
    if (since) { u.searchParams.set('updatedMin', since); u.searchParams.set('showCompleted', 'true'); u.searchParams.set('showDeleted', 'true'); }
    else { u.searchParams.set('showCompleted', 'false'); } // first sync: only what's still to do
    for (const r of await allPages(db, account, u.toString())) pullOne(db, account, list.id, r, stats);
  }

  // ---- Push deletions ----
  for (const d of db.all('SELECT * FROM gtask_deletes WHERE account_id = ?', account.id)) {
    try { await gfetch(db, account, `${API}/lists/${enc(d.list_id)}/tasks/${enc(d.gtask_id)}`, { method: 'DELETE' }); stats.deleted++; }
    catch (e) { if (e.googleStatus !== 404) throw e; }
    db.run('DELETE FROM gtask_deletes WHERE id = ?', d.id);
  }

  // ---- Push changes ----
  const primary = Number(getSetting(db, 'primary_account_id')) === account.id;
  const outgoing = db.all(`SELECT * FROM tasks WHERE (account_id = ? OR (account_id IS NULL AND ?))
    AND ((gtask_id IS NULL AND status = 'open') OR (gtask_id IS NOT NULL AND gtask_dirty = 1))`, account.id, primary);
  for (const t of outgoing) await pushOne(db, account, listId, t, stats);

  db.run('UPDATE accounts SET gtasks_synced_at = ? WHERE id = ?', startedAt, account.id);
  return stats;
}

function pullOne(db, account, listId, r, stats) {
  const title = String(r.title ?? '').trim();
  const local = db.get('SELECT * FROM tasks WHERE account_id = ? AND gtask_id = ?', account.id, r.id);
  if (!local) {
    if (r.deleted || r.status === 'completed' || !title) return;
    // Deleted on the board and waiting to be deleted in Google: don't bring it back.
    if (db.get('SELECT 1 FROM gtask_deletes WHERE account_id = ? AND gtask_id = ?', account.id, r.id)) return;
    const due = dueFromGoogle(r.due);
    const col = columnForDue(due);
    db.insert(`INSERT INTO tasks (title, notes, col, due_date, position, origin, account_id, gtask_id, gtask_list_id, gtask_updated)
      VALUES (?,?,?,?,?,'gtasks',?,?,?,?)`, title.slice(0, 300), stripMarker(r.notes), col, due, endPosition(db, col), account.id, r.id, listId, r.updated);
    stats.imported++;
    return;
  }
  if (r.updated && r.updated === local.gtask_updated) return; // our own write coming back

  if (r.deleted) {
    // Deleted in Google: take it off the board (kept as dismissed, unlinked).
    if (local.status === 'open') stats.removed++;
    db.run(`UPDATE tasks SET status = CASE WHEN status = 'open' THEN 'dismissed' ELSE status END, gtask_id = NULL, gtask_list_id = NULL, gtask_updated = NULL, gtask_dirty = 0 WHERE id = ?`, local.id);
    return;
  }
  const remoteDone = r.status === 'completed';
  if (local.gtask_dirty) {
    // Board wins, but completing a task anywhere completes it.
    if (remoteDone && local.status === 'open') {
      db.run(`UPDATE tasks SET status = 'done', completed_at = ? WHERE id = ?`, r.completed ?? new Date().toISOString(), local.id);
      stats.completed++;
    }
    return;
  }
  const due = dueFromGoogle(r.due);
  let col = local.col;
  let position = local.position;
  if (due !== local.due_date && !local.pinned && local.col !== 'waiting') col = columnForDue(due);
  let status = local.status;
  let completedAt = local.completed_at;
  if (remoteDone && local.status !== 'done') { status = 'done'; completedAt = r.completed ?? new Date().toISOString(); stats.completed++; }
  else if (!remoteDone && local.status === 'done') { status = 'open'; completedAt = null; }
  if (col !== local.col || (status === 'open' && local.status !== 'open')) position = endPosition(db, col);
  if (!(remoteDone && local.status !== 'done')) stats.updated++;
  // A new column means the [Taskboard: …] note in Google is out of date, so push it back.
  db.run(`UPDATE tasks SET title = ?, notes = ?, due_date = ?, col = ?, position = ?, status = ?, completed_at = ?, gtask_updated = ?, gtask_list_id = ?, gtask_dirty = ? WHERE id = ?`,
    title ? title.slice(0, 300) : local.title, stripMarker(r.notes), due, col, position, status, completedAt, r.updated ?? null, listId, col !== local.col, local.id);
}

async function pushOne(db, account, listId, t, stats) {
  const clean = (updated) => {
    // Only clear the flag if nobody edited the card while we were talking to Google.
    db.run('UPDATE tasks SET gtask_dirty = 0, gtask_updated = ? WHERE id = ? AND updated_at = ?', updated ?? null, t.id, t.updated_at);
  };
  if (t.status === 'dismissed') {
    try { await gfetch(db, account, `${API}/lists/${enc(t.gtask_list_id)}/tasks/${enc(t.gtask_id)}`, { method: 'DELETE' }); stats.deleted++; }
    catch (e) { if (e.googleStatus !== 404) throw e; }
    db.run('UPDATE tasks SET gtask_id = NULL, gtask_list_id = NULL, gtask_updated = NULL, gtask_dirty = 0 WHERE id = ?', t.id);
    return;
  }
  const body = {
    title: t.title,
    notes: withMarker(t.notes, t.col),
    due: dueToGoogle(t.due_date),
    status: t.status === 'done' ? 'completed' : 'needsAction',
    ...(t.status === 'done' ? {} : { completed: null }),
  };
  if (t.gtask_id) {
    try {
      const r = await gfetch(db, account, `${API}/lists/${enc(t.gtask_list_id)}/tasks/${enc(t.gtask_id)}`, { method: 'PATCH', body });
      clean(r?.updated);
      stats.pushed++;
      return;
    } catch (e) {
      if (e.googleStatus !== 404) throw e; // gone in Google: create it again below
    }
  }
  if (t.status !== 'open') { db.run('UPDATE tasks SET gtask_id = NULL, gtask_list_id = NULL, gtask_dirty = 0 WHERE id = ?', t.id); return; }
  const r = await gfetch(db, account, `${API}/lists/${enc(listId)}/tasks`, { method: 'POST', body });
  db.run('UPDATE tasks SET account_id = ?, gtask_id = ?, gtask_list_id = ? WHERE id = ?', account.id, r.id, listId, t.id);
  clean(r.updated);
  stats.created++;
}
