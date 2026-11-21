import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.TASKBOARD_KEY_FILE = join(mkdtempSync(join(tmpdir(), 'tbkey-')), 'secret.key');
process.env.TASKBOARD_RETRY_MS = '0';

const { Db } = await import('../server/db.js');
const { encrypt, decrypt } = await import('../server/crypto.js');
const google = await import('../server/services/google.js');
const { saveSettings, publicSettings } = await import('../server/services/settings.js');
const { syncAll } = await import('../server/services/sync.js');
const tasks = await import('../server/services/tasks.js');
const { stripMarker, withMarker } = await import('../server/services/gtasks.js');
const { FakeGoogle } = await import('./fake-google.js');

let db, g;
beforeEach(() => {
  db = new Db(':memory:');
  g = new FakeGoogle();
  google.http.fetch = g.fetch;
  google.forgetTokens();
  saveSettings(db, { google_client_id: 'abc.apps.googleusercontent.com', google_client_secret: 'shh' });
});

async function connect(email, origin = 'http://127.0.0.1:3100') {
  if (!g.users.has(email)) g.addUser(email);
  const { url } = google.startConnect(db, origin);
  const q = new URL(url).searchParams;
  assert.equal(q.get('redirect_uri'), `${origin}/oauth/callback`);
  assert.equal(q.get('access_type'), 'offline');
  return google.finishConnect(db, { state: q.get('state'), code: g.issueCode(email) });
}

const card = (title) => db.get('SELECT * FROM tasks WHERE title = ?', title);

test('secrets are encrypted at rest and the key file is private', () => {
  const blob = encrypt('refresh-token-123');
  assert.doesNotMatch(blob, /refresh-token-123/);
  assert.equal(decrypt(blob), 'refresh-token-123');
  assert.throws(() => decrypt(blob.slice(0, -4) + 'AAAA'));
  assert.equal(readFileSync(process.env.TASKBOARD_KEY_FILE, 'utf8').trim().length, 44);
  const stored = db.get(`SELECT value FROM settings WHERE key = 'google_client_secret_enc'`).value;
  assert.doesNotMatch(stored, /shh/);
  assert.equal(publicSettings(db).google_client_configured, true);
});

test('connecting accounts from different domains', async () => {
  const a = await connect('mckay@kmlarsenco.example');
  const b = await connect('mckay@trendwise.example');
  const accts = google.listAccounts(db);
  assert.deepEqual(accts.map((x) => x.domain), ['kmlarsenco.example', 'trendwise.example']);
  assert.notEqual(accts[0].color, accts[1].color);
  assert.equal(publicSettings(db).primary_account_id, a.id, 'first account becomes primary');
  const row = db.get('SELECT refresh_token_enc FROM accounts WHERE id = ?', b.id);
  assert.doesNotMatch(row.refresh_token_enc, /rt-/);

  // Reconnecting the same account updates it rather than adding another.
  await connect('mckay@trendwise.example');
  assert.equal(google.listAccounts(db).length, 2);

  // State is single use; unticked permissions are refused.
  const { url } = google.startConnect(db, 'http://127.0.0.1:3100');
  const state = new URL(url).searchParams.get('state');
  g.grantScopes = 'openid email https://www.googleapis.com/auth/tasks';
  await assert.rejects(google.finishConnect(db, { state, code: g.issueCode('mckay@trendwise.example') }), /tick every box/);
  await assert.rejects(google.finishConnect(db, { state, code: 'x' }), /expired/);
});

test('two-way Google Tasks sync', async () => {
  const email = 'mckay@kmlarsenco.example';
  const lists = g.addUser(email);
  const phone = g.addRemote(email, 'default', { title: 'Pick up 1099 forms', due: '2000-01-01T00:00:00.000Z' });
  g.addRemote(email, 'default', { title: 'Old finished thing', status: 'completed' });
  const manual = tasks.createTask(db, { title: 'Call the bank', col: 'week' });
  await connect(email);

  let [r] = await syncAll(db);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.tasks.imported, 1);
  assert.equal(r.tasks.created, 1);
  // Phone task came in (overdue → Today); completed ones were left behind.
  assert.equal(card('Pick up 1099 forms').col, 'today');
  assert.equal(card('Pick up 1099 forms').origin, 'gtasks');
  assert.equal(card('Old finished thing'), undefined);
  // Board task went to the Taskboard list with its column noted.
  const tb = g.taskList(email, 'Taskboard');
  const pushed = [...tb.tasks.values()].find((t) => t.title === 'Call the bank');
  assert.equal(pushed.notes, '[Taskboard: This week]');
  assert.equal(card('Call the bank').gtask_dirty, 0);

  // Nothing changed: the next sync writes nothing.
  g.calls = [];
  [r] = await syncAll(db);
  assert.ok(!g.calls.some((c) => /^(POST|PATCH|DELETE)/.test(c)), g.calls.join(', '));

  // Completed on the phone → done on the board.
  g.edit(email, 'default', phone.id, { status: 'completed', completed: g.now() });
  // Renamed on the phone → renamed here.
  g.edit(email, tb.id, pushed.id, { title: 'Call the bank re: wire' });
  [r] = await syncAll(db);
  assert.equal(card('Pick up 1099 forms').status, 'done');
  assert.ok(card('Call the bank re: wire'));

  // Edited and completed on the board → pushed.
  const c = card('Call the bank re: wire');
  tasks.updateTask(db, c.id, { col: 'today', notes: 'Ask for Dana' });
  await syncAll(db);
  assert.equal(pushed.notes, 'Ask for Dana\n\n[Taskboard: Today]');
  tasks.updateTask(db, c.id, { status: 'done' });
  await syncAll(db);
  assert.equal(pushed.status, 'completed');

  // Edited on both sides: board wins, but a completion in Google still completes.
  const both = tasks.createTask(db, { title: 'Both sides' });
  await syncAll(db);
  const remote = [...tb.tasks.values()].find((t) => t.title === 'Both sides');
  g.edit(email, tb.id, remote.id, { title: 'Phone title', status: 'completed' });
  tasks.updateTask(db, both.id, { title: 'Board title' });
  await syncAll(db);
  assert.equal(card('Board title').status, 'done');
  assert.equal(remote.title, 'Board title');

  // Deleted on the board → deleted in Google. Deleted in Google → off the board.
  const gone = tasks.createTask(db, { title: 'Delete me' });
  await syncAll(db);
  const goneRemote = [...tb.tasks.values()].find((t) => t.title === 'Delete me');
  tasks.deleteTask(db, gone.id);
  await syncAll(db);
  assert.equal(goneRemote.deleted, true);
  const phone2 = g.addRemote(email, 'default', { title: 'Phone then deleted' });
  await syncAll(db);
  assert.equal(card('Phone then deleted').status, 'open');
  g.edit(email, 'default', phone2.id, { deleted: true });
  await syncAll(db);
  assert.equal(card('Phone then deleted').status, 'dismissed');

  // "Not a task" removes it from Google too.
  const dis = tasks.createTask(db, { title: 'Dismiss me' });
  await syncAll(db);
  const disRemote = [...tb.tasks.values()].find((t) => t.title === 'Dismiss me');
  tasks.updateTask(db, dis.id, { status: 'dismissed' });
  await syncAll(db);
  assert.equal(disRemote.deleted, true);
  assert.equal(card('Dismiss me').gtask_id, null);
  assert.ok(lists.size >= 2);
});

test('a revoked account is flagged for reconnecting and others keep syncing', async () => {
  await connect('a@one.example');
  await connect('b@two.example');
  tasks.createTask(db, { title: 'Goes to A' });
  g.users.get('a@one.example').refresh = 'rotated'; // Google no longer accepts the saved token
  google.forgetTokens();
  const results = await syncAll(db);
  assert.equal(results[0].ok, false);
  assert.equal(results[0].reconnect, true);
  assert.equal(results[1].ok, true);
  assert.equal(google.listAccounts(db)[0].needs_reconnect, true);
  assert.equal((await syncAll(db)).length, 1, 'flagged accounts are skipped until reconnected');
  await connect('a@one.example');
  assert.equal(google.listAccounts(db)[0].needs_reconnect, false);
});

test('disconnect revokes the token and keeps the tasks', async () => {
  const a = await connect('a@one.example');
  const b = await connect('b@two.example');
  g.addRemote('a@one.example', 'default', { title: 'From A' });
  await syncAll(db);
  await google.disconnect(db, a.id);
  assert.deepEqual(g.revoked, ['rt-a@one.example']);
  const t = card('From A');
  assert.equal(t.status, 'open');
  assert.equal(t.origin, 'manual');
  assert.equal(t.gtask_id, null);
  assert.equal(publicSettings(db).primary_account_id, b.id);
});

test('notes marker round-trips', () => {
  assert.equal(withMarker(null, 'waiting'), '[Taskboard: Waiting]');
  assert.equal(stripMarker(withMarker('Line 1\nLine 2', 'today')), 'Line 1\nLine 2');
  assert.equal(stripMarker('[Taskboard: Later]'), null);
  assert.equal(stripMarker('Keep [brackets] here'), 'Keep [brackets] here');
});
