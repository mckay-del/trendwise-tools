import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Db } from '../server/db.js';
import { createHandler } from '../server/app.js';
import { createTask, updateTask, board, rollForward, columnForDue } from '../server/services/tasks.js';

const order = (db, col) => board(db).columns.find((c) => c.id === col).tasks.map((t) => t.title);

test('columnForDue picks Today / This week / Later', () => {
  assert.equal(columnForDue(null, '2026-11-21'), 'later');
  assert.equal(columnForDue('2026-11-20', '2026-11-21'), 'today');
  assert.equal(columnForDue('2026-11-21', '2026-11-21'), 'today');
  assert.equal(columnForDue('2026-11-28', '2026-11-21'), 'week');
  assert.equal(columnForDue('2026-11-29', '2026-11-21'), 'later');
});

test('create, reorder, move (pins), complete, reopen', () => {
  const db = new Db(':memory:');
  const due = '2000-01-01'; // overdue, so the suggested column is Today
  const a = createTask(db, { title: 'A', due_date: due });
  const b = createTask(db, { title: 'B', due_date: due });
  const c = createTask(db, { title: 'C', due_date: due });
  assert.deepEqual(order(db, 'today'), ['A', 'B', 'C']);
  assert.equal(a.pinned, 0, 'following the due date is not a manual placement');
  assert.equal(createTask(db, { title: 'Chosen', col: 'later', due_date: due }).pinned, 1, 'picking a different column pins');

  updateTask(db, c.id, { col: 'today', before_id: a.id });
  assert.deepEqual(order(db, 'today'), ['C', 'A', 'B']);
  assert.equal(board(db).columns[0].tasks[0].pinned, 0, 'reordering within a column does not pin');

  const moved = updateTask(db, b.id, { col: 'waiting' });
  assert.equal(moved.col, 'waiting');
  assert.equal(moved.pinned, 1);

  const done = updateTask(db, a.id, { status: 'done' });
  assert.ok(done.completed_at);
  assert.deepEqual(order(db, 'today'), ['C']);
  assert.equal(board(db).done[0].title, 'A');
  const back = updateTask(db, a.id, { status: 'open' });
  assert.equal(back.completed_at, null);
  assert.deepEqual(order(db, 'today'), ['C', 'A']);

  assert.throws(() => createTask(db, { title: '' }), /title/);
  assert.throws(() => createTask(db, { title: 'x', due_date: '2026-02-30' }), /Due date/);
  assert.throws(() => updateTask(db, a.id, { col: 'someday' }), /column/);
  db.close();
});

test('repeated inserts at the same spot keep a stable order', () => {
  const db = new Db(':memory:');
  const first = createTask(db, { title: 'first', col: 'later' });
  const last = createTask(db, { title: 'last', col: 'later' });
  for (let i = 0; i < 60; i++) updateTask(db, createTask(db, { title: `n${i}`, col: 'later' }).id, { col: 'later', before_id: last.id });
  const titles = order(db, 'later');
  assert.equal(titles[0], first.title);
  assert.equal(titles.at(-1), last.title);
  assert.equal(titles.length, 62);
  db.close();
});

test('roll-forward moves unpinned cards toward Today only', () => {
  const db = new Db(':memory:');
  const t = createTask(db, { title: 'Send W-9', due_date: '2026-12-10' });
  assert.equal(t.col, 'later');
  const pinned = createTask(db, { title: 'Pinned', due_date: '2026-12-10' });
  updateTask(db, pinned.id, { col: 'later' });
  db.run('UPDATE tasks SET pinned = 1 WHERE id = ?', pinned.id);
  const waiting = createTask(db, { title: 'Waiting on client', col: 'waiting', due_date: '2026-12-01' });

  assert.deepEqual(rollForward(db, '2026-12-04'), { moved: 1 });
  assert.equal(board(db).columns.find((c) => c.id === 'week').tasks[0].title, 'Send W-9');
  rollForward(db, '2026-12-10');
  assert.deepEqual(order(db, 'today'), ['Send W-9']);
  assert.deepEqual(order(db, 'later'), ['Pinned']);
  assert.deepEqual(order(db, 'waiting'), [waiting.title]);
  db.close();
});

let server, base, db;
before(async () => {
  db = new Db(':memory:');
  server = createServer(createHandler(db));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); db.close(); });

const call = async (method, path, body, cookie, csrf = true) => {
  const headers = { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(csrf && method !== 'GET' ? { 'X-Requested-With': 'taskboard' } : {}) };
  const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null), cookie: res.headers.get('set-cookie')?.split(';')[0] };
};

test('HTTP: setup, auth required, CSRF header, task API', async () => {
  assert.equal((await call('GET', '/api/board')).status, 401);
  assert.equal((await call('GET', '/api/auth/status')).json.needs_setup, true);
  const setup = await call('POST', '/api/auth/setup', { name: 'McKay', email: 'm@x.test', password: 'long-enough-pw' });
  assert.equal(setup.status, 200);
  const cookie = setup.cookie;
  assert.match(cookie, /^taskboard_session=/);
  assert.equal((await call('POST', '/api/auth/setup', { name: 'X', email: 'x@x.test', password: 'long-enough-pw' })).status, 403);

  assert.equal((await call('POST', '/api/tasks', { title: 'no csrf' }, cookie, false)).status, 403);
  const created = await call('POST', '/api/tasks', { title: 'Call the bank', col: 'today' }, cookie);
  assert.equal(created.status, 200);
  const b = await call('GET', '/api/board', null, cookie);
  assert.deepEqual(b.json.columns.map((c) => c.label), ['Today', 'This week', 'Later', 'Waiting']);
  assert.equal(b.json.columns[0].tasks[0].title, 'Call the bank');
  assert.equal((await call('PUT', `/api/tasks/${created.json.id}`, { status: 'done' }, cookie)).json.status, 'done');
  assert.equal((await call('DELETE', `/api/tasks/${created.json.id}`, null, cookie)).status, 200);
  assert.equal((await call('GET', `/api/tasks/${created.json.id}`, null, cookie)).status, 404);

  const bad = await call('POST', '/api/auth/login', { email: 'm@x.test', password: 'wrong' });
  assert.equal(bad.status, 400);
  const page = await fetch(base + '/');
  assert.match(await page.text(), /McKay's Taskboard/);
});
