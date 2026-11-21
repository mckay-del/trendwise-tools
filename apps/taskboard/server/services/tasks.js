import { bad, notFound, str, isDate, addDays, today as todayIn } from '../util.js';

export const COLUMNS = [
  { id: 'today', label: 'Today' },
  { id: 'week', label: 'This week' },
  { id: 'later', label: 'Later' },
  { id: 'waiting', label: 'Waiting' },
];
const COL_IDS = COLUMNS.map((c) => c.id);
const STATUSES = ['open', 'done', 'dismissed'];

const SELECT = `SELECT t.*, a.email AS account_email, a.color AS account_color, s.kind AS source_kind, s.link AS source_link
  FROM tasks t LEFT JOIN accounts a ON a.id = t.account_id LEFT JOIN sources s ON s.id = t.source_id`;

export const getTask = (db, id) => {
  const t = db.get(`${SELECT} WHERE t.id = ?`, id);
  if (!t) throw notFound('Task');
  return t;
};

/** Open tasks grouped by column, plus the most recent done tasks. */
export function board(db, { doneLimit = 30 } = {}) {
  const open = db.all(`${SELECT} WHERE t.status = 'open' ORDER BY t.position, t.id`);
  const columns = COLUMNS.map((c) => ({ ...c, tasks: open.filter((t) => t.col === c.id) }));
  const done = db.all(`${SELECT} WHERE t.status = 'done' ORDER BY t.completed_at DESC, t.id DESC LIMIT ?`, doneLimit);
  return { today: todayIn(), columns, done };
}

/** Suggested column for a due date: overdue/today -> today, within 7 days -> week, otherwise later. */
export function columnForDue(due, now = todayIn()) {
  if (!due) return 'later';
  if (due <= now) return 'today';
  if (due <= addDays(now, 7)) return 'week';
  return 'later';
}

export const endPosition = (db, col) => (db.get(`SELECT MAX(position) AS p FROM tasks WHERE status = 'open' AND col = ?`, col)?.p ?? 0) + 1;

function cleanDue(v) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  if (!isDate(v)) throw bad('Due date must be a valid date (YYYY-MM-DD)');
  return v;
}

export function createTask(db, body) {
  const title = str(body.title, 300);
  if (!title) throw bad('Give the task a title');
  const due = cleanDue(body.due_date) ?? null;
  const col = body.col === undefined ? columnForDue(due) : body.col;
  if (!COL_IDS.includes(col)) throw bad('Unknown column');
  const id = db.insert(`INSERT INTO tasks (title, notes, col, due_date, position, origin, pinned, gtask_dirty) VALUES (?,?,?,?,?,?,?,1)`,
    title, str(body.notes, 5000), col, due, endPosition(db, col), 'manual', body.col !== undefined && body.col !== columnForDue(due));
  return getTask(db, id);
}

/**
 * Edit a task. A column change made here is a person's choice, so the card is pinned and the agent leaves it alone.
 * `before_id` places the card just above another card in the target column (drag and drop); omitted = bottom.
 */
export function updateTask(db, id, body) {
  const t = getTask(db, id);
  return db.tx(() => {
    const title = body.title === undefined ? t.title : str(body.title, 300);
    if (!title) throw bad('Give the task a title');
    const notes = body.notes === undefined ? t.notes : str(body.notes, 5000);
    const due = cleanDue(body.due_date);
    const status = body.status ?? t.status;
    if (!STATUSES.includes(status)) throw bad('Unknown status');
    const col = body.col ?? t.col;
    if (!COL_IDS.includes(col)) throw bad('Unknown column');

    let position = t.position;
    const moving = body.col !== undefined || body.before_id !== undefined;
    if (moving) position = placeBefore(db, col, body.before_id, t.id);
    const pinned = t.pinned || (body.col !== undefined && body.col !== t.col);
    const completedAt = status === 'done' ? (t.status === 'done' ? t.completed_at : new Date().toISOString()) : null;
    if (status === 'open' && t.status !== 'open' && !moving) position = endPosition(db, col);

    const dueDate = due === undefined ? t.due_date : due;
    // Anything Google Tasks shows (the column is written into the notes) needs pushing on the next sync.
    const dirty = t.gtask_dirty || title !== t.title || notes !== t.notes || dueDate !== t.due_date || status !== t.status || col !== t.col;
    db.run(`UPDATE tasks SET title=?, notes=?, due_date=?, status=?, col=?, position=?, pinned=?, completed_at=?, gtask_dirty=?, updated_at=strftime('%Y-%m-%d %H:%M:%f','now') WHERE id=?`,
      title, notes, dueDate, status, col, position, pinned, completedAt, dirty, id);
    return getTask(db, id);
  });
}

function placeBefore(db, col, beforeId, selfId) {
  if (beforeId === undefined || beforeId === null) return endPosition(db, col);
  const target = db.get(`SELECT id, position FROM tasks WHERE id = ? AND status = 'open' AND col = ?`, Number(beforeId), col);
  if (!target) return endPosition(db, col);
  const prev = db.get(`SELECT position FROM tasks WHERE status = 'open' AND col = ? AND position < ? AND id != ? ORDER BY position DESC LIMIT 1`, col, target.position, selfId);
  const lo = prev?.position ?? target.position - 1;
  if (target.position - lo > 1e-6) return (lo + target.position) / 2;
  renumber(db, col);
  return placeBefore(db, col, beforeId, selfId);
}

function renumber(db, col) {
  db.all(`SELECT id FROM tasks WHERE status = 'open' AND col = ? ORDER BY position, id`, col)
    .forEach((r, i) => db.run('UPDATE tasks SET position = ? WHERE id = ?', i + 1, r.id));
}

export function deleteTask(db, id) {
  const t = getTask(db, id);
  db.tx(() => {
    if (t.gtask_id && t.account_id) db.run('INSERT INTO gtask_deletes (account_id, list_id, gtask_id) VALUES (?,?,?)', t.account_id, t.gtask_list_id, t.gtask_id);
    db.run('DELETE FROM tasks WHERE id = ?', id);
  });
  return { ok: true };
}

/**
 * Daily roll-forward: as due dates arrive, unpinned cards move toward Today (Later -> This week -> Today).
 * Cards are never moved backward, Waiting is left alone, and pinned cards stay where they were put.
 */
export function rollForward(db, now = todayIn()) {
  const rank = { later: 0, week: 1, today: 2 };
  let moved = 0;
  db.tx(() => {
    for (const t of db.all(`SELECT id, col, due_date FROM tasks WHERE status = 'open' AND pinned = 0 AND due_date IS NOT NULL AND col IN ('later','week')`)) {
      const want = columnForDue(t.due_date, now);
      if (rank[want] > rank[t.col]) {
        db.run(`UPDATE tasks SET col = ?, position = ?, gtask_dirty = 1, updated_at = strftime('%Y-%m-%d %H:%M:%f','now') WHERE id = ?`, want, endPosition(db, want), t.id);
        moved++;
      }
    }
  });
  return { moved };
}
