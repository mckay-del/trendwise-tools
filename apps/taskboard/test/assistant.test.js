import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.TASKBOARD_KEY_FILE = join(mkdtempSync(join(tmpdir(), 'tbkey-')), 'secret.key');
process.env.TASKBOARD_RETRY_MS = '0';
delete process.env.ANTHROPIC_API_KEY;

const { Db } = await import('../server/db.js');
const google = await import('../server/services/google.js');
const { saveSettings, publicSettings } = await import('../server/services/settings.js');
const { syncAll } = await import('../server/services/sync.js');
const { syncMail, messageText, lookbackDays } = await import('../server/services/mail.js');
const { syncCalendar } = await import('../server/services/calendar.js');
const { ai, triage, cleanItem, SCHEMA } = await import('../server/services/triage.js');
const tasks = await import('../server/services/tasks.js');
const { FakeGoogle } = await import('./fake-google.js');

const EMAIL = 'mckay@kmlarsenco.example';
const DAY = 86400_000;

/**
 * Stand-in for Claude. `decide(item)` returns the answer for one item (or undefined to leave it out).
 * Records every request so tests can check what was sent.
 */
class FakeClaude {
  constructor(decide) {
    this.decide = decide;
    this.requests = [];
    this.reply = null; // override the whole response, e.g. { stop_reason: 'refusal' }
    this.fail = null;
    this.beta = { messages: { create: async (params) => this.create(params) } };
  }
  async create(params) {
    this.requests.push(params);
    if (this.fail) throw this.fail;
    if (this.reply) return { model: params.model, usage: { input_tokens: 10, output_tokens: 1 }, content: [], ...this.reply };
    const items = JSON.parse(params.messages[0].content.split('Items:\n')[1]);
    const out = items.map((it) => this.decide(it)).filter(Boolean);
    return { model: params.model, stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 500 }, content: [{ type: 'text', text: JSON.stringify({ items: out }) }] };
  }
}

// A simple rule-following "assistant" for the tests.
const rules = (it) => {
  const text = `${it.subject ?? it.event ?? ''} ${it.latest_messages ?? ''}`;
  if (it.kind === 'event') {
    if (it.cancelled || it.declined) return { ref: it.ref, action: 'complete', title: it.open_card?.title ?? 'x', column: 'later', due_date: null, reason: 'Meeting is off.' };
    return { ref: it.ref, action: 'create', title: `Prepare for ${it.event}`, column: 'week', due_date: it.start.slice(0, 10), reason: 'Meeting with others soon.' };
  }
  if (/newsletter/i.test(text)) return { ref: it.ref, action: 'ignore', title: '', column: 'later', due_date: null, reason: 'Bulk mail.' };
  if (it.last_message_from_me) return { ref: it.ref, action: it.open_card ? 'update' : 'create', title: it.open_card?.title ?? `Follow up: ${it.subject}`, column: 'waiting', due_date: null, reason: 'Waiting on their reply.' };
  if (/all set|thanks, got it/i.test(text)) return { ref: it.ref, action: 'complete', title: it.open_card?.title ?? 'x', column: 'later', due_date: null, reason: 'They confirmed.' };
  return { ref: it.ref, action: 'create', title: `Reply to ${it.subject}`, column: /today|urgent/i.test(text) ? 'today' : 'week', due_date: /friday/i.test(text) ? '2026-11-27' : null, reason: 'A client is asking for something.' };
};

let db, g, claude;
beforeEach(async () => {
  db = new Db(':memory:');
  g = new FakeGoogle();
  google.http.fetch = g.fetch;
  google.forgetTokens();
  claude = new FakeClaude(rules);
  ai.client = claude;
  saveSettings(db, { google_client_id: 'abc.apps.googleusercontent.com', google_client_secret: 'shh' });
  g.addUser(EMAIL);
  const { url } = google.startConnect(db, 'http://127.0.0.1:3100');
  await google.finishConnect(db, { state: new URL(url).searchParams.get('state'), code: g.issueCode(EMAIL) });
});
const account = () => db.get('SELECT * FROM accounts WHERE email = ?', EMAIL);
const sources = () => db.all('SELECT * FROM sources ORDER BY id');
const card = (title) => db.get('SELECT * FROM tasks WHERE title = ?', title);

test('Gmail: recent inbox first, then only new messages; tabs and old mail skipped', async () => {
  g.addEmail(EMAIL, { subject: 'W-9 needed', body: 'Can you send your W-9 by Friday?' });
  g.addEmail(EMAIL, { subject: 'Old thing', body: 'from last month', daysAgo: 30 });
  g.addEmail(EMAIL, { subject: 'Sale!', labels: ['INBOX', 'CATEGORY_PROMOTIONS'] });
  g.addEmail(EMAIL, { subject: 'Archived', labels: ['UNREAD'] });

  let r = await syncMail(db, account());
  assert.deepEqual(sources().map((s) => s.title), ['W-9 needed']);
  assert.equal(r.new, 1);
  const s = sources()[0];
  assert.match(s.link, /^https:\/\/mail\.google\.com\/mail\/\?authuser=mckay%40kmlarsenco\.example#all\/t\d+$/);
  assert.match(s.excerpt, /send your W-9/);
  assert.equal(JSON.parse(s.meta).from, 'Client <client@example.com>');

  // Nothing new: no thread is fetched again.
  g.calls = [];
  r = await syncMail(db, account());
  assert.ok(!g.calls.some((c) => c.includes('/threads/')));

  // A reply in the same thread: the source is queued for the assistant again, now "last from me".
  db.run('UPDATE sources SET processed_at = ?', new Date().toISOString());
  g.addEmail(EMAIL, { threadId: s.external_id, sent: true, subject: 'Re: W-9 needed', body: 'Attached.\n\nOn Mon, Nov 23, 2026 at 9:00 AM Client <client@example.com> wrote:\n> Can you send your W-9 by Friday?' });
  r = await syncMail(db, account());
  assert.equal(r.changed, 1);
  const s2 = sources()[0];
  assert.equal(s2.processed_at, null);
  assert.equal(JSON.parse(s2.meta).last_from_me, true);
  assert.match(s2.excerpt, /--- Me .*:\nAttached\./);
  assert.doesNotMatch(s2.excerpt.split('--- Me')[1], /wrote:|> Can you/, 'quoted reply removed');

  // Gmail history expired: fall back to a recent-inbox search.
  g.users.get(EMAIL).historyFloor = 1e9;
  g.addEmail(EMAIL, { subject: 'After expiry', body: 'New one' });
  r = await syncMail(db, account());
  assert.ok(sources().some((x) => x.title === 'After expiry'));
});

test('Gmail catch-up: after time off, the inbox is searched back to the last good sync', async () => {
  const now = Date.parse('2026-12-20T12:00:00Z');
  assert.equal(lookbackDays({}, now), 7, 'first sync');
  assert.equal(lookbackDays({ gmail_history_id: '5', gmail_synced_at: '2026-12-19T12:00:00Z' }, now), 2, 'at least 2 days');
  assert.equal(lookbackDays({ gmail_history_id: '5', gmail_synced_at: '2026-12-08T12:00:00Z' }, now), 13, '12 days off + 1');
  assert.equal(lookbackDays({ gmail_history_id: '5', gmail_synced_at: '2026-06-01T00:00:00Z' }, now), 60, 'capped');

  await syncMail(db, account());
  // The board is off for 12 days; Gmail's history no longer reaches back that far.
  db.run(`UPDATE accounts SET gmail_synced_at = ?`, new Date(Date.now() - 12 * DAY).toISOString());
  g.users.get(EMAIL).historyFloor = 1e9;
  g.addEmail(EMAIL, { subject: 'Ten days ago', body: 'Please call me', daysAgo: 10 });
  g.addEmail(EMAIL, { subject: 'Twenty days ago', body: 'Old', daysAgo: 20 });
  const r = await syncMail(db, account());
  assert.equal(r.caught_up_days, 13);
  assert.deepEqual(sources().map((s) => s.title), ['Ten days ago']);
  assert.ok(Date.now() - Date.parse(account().gmail_synced_at) < 60_000);
});

test('email text: quoted replies cut, HTML turned to text, long mail capped', () => {
  const b64 = (t) => Buffer.from(t).toString('base64url');
  const plain = (t) => ({ payload: { mimeType: 'text/plain', body: { data: b64(t) } } });
  assert.equal(messageText(plain('Sounds good.\n\nOn Tue, Nov 24, 2026 at 10:15 AM Jane Doe <jane@x.com>\nwrote:\n> earlier')), 'Sounds good.');
  assert.equal(messageText(plain('Yes.\n-----Original Message-----\nFrom: a')), 'Yes.');
  assert.equal(messageText({ payload: { mimeType: 'text/html', body: { data: b64('<p>Hi&nbsp;<b>there</b></p><style>p{}</style>') } } }), 'Hi there');
  assert.equal(messageText(plain('x'.repeat(5000))).length, 1500);
});

test('Calendar: invites and meetings with people kept; declined, solo and out-of-office skipped', async () => {
  const at = (days, h = 15) => new Date(Date.now() + days * DAY).toISOString().slice(0, 11) + `${h}:00:00Z`;
  const me = { email: EMAIL, self: true };
  g.addEvent(EMAIL, { summary: 'Invite: tax planning', start: { dateTime: at(3) }, end: { dateTime: at(3, 16) }, attendees: [{ ...me, responseStatus: 'needsAction' }, { email: 'cpa@x.com' }] });
  const client = g.addEvent(EMAIL, { summary: 'Client review', start: { dateTime: at(2) }, end: { dateTime: at(2, 16) }, organizer: { self: true }, attendees: [{ ...me, responseStatus: 'accepted' }, { email: 'c@x.com' }] });
  g.addEvent(EMAIL, { summary: 'Declined lunch', start: { dateTime: at(1) }, attendees: [{ ...me, responseStatus: 'declined' }, { email: 'b@x.com' }] });
  g.addEvent(EMAIL, { summary: 'Gym', start: { dateTime: at(1) } });
  g.addEvent(EMAIL, { summary: 'OOO', eventType: 'outOfOffice', start: { dateTime: at(4) } });
  g.addEvent(EMAIL, { summary: 'Far away', start: { dateTime: at(40) }, attendees: [{ ...me, responseStatus: 'needsAction' }] });

  await syncCalendar(db, account());
  assert.deepEqual(sources().map((s) => s.title).sort(), ['Client review', 'Invite: tax planning']);
  assert.equal(JSON.parse(sources().find((s) => s.title === 'Invite: tax planning').meta).my_response, 'needsAction');

  // Incremental: only the changed event comes back; a cancellation re-queues the tracked event.
  db.run('UPDATE sources SET processed_at = ?', new Date().toISOString());
  g.calls = [];
  g.editEvent(EMAIL, client.id, { status: 'cancelled' });
  await syncCalendar(db, account());
  assert.ok(g.calls.some((c) => c.includes('/events')));
  const cancelled = sources().find((s) => s.title === 'Client review');
  assert.equal(cancelled.processed_at, null);
  assert.equal(JSON.parse(cancelled.meta).cancelled, true);

  // Expired sync token (410): start over without failing.
  g.users.get(EMAIL).calFloor = 1e9;
  await syncCalendar(db, account());
});

test('the assistant turns email and events into cards, updates and completes them', async () => {
  g.addEmail(EMAIL, { subject: 'W-9 needed', body: 'Can you send your W-9 by Friday?' });
  g.addEmail(EMAIL, { subject: 'Monthly newsletter', body: 'Our newsletter' });
  g.addEmail(EMAIL, { subject: 'Urgent: payroll', body: 'Need payroll approved today' });
  saveSettings(db, { ai_notes: 'Anything from the IRS goes in Today.' });

  const [r] = await syncAll(db);
  assert.equal(r.ok, true, r.error);
  const w9 = card('Reply to W-9 needed');
  assert.equal(w9.origin, 'ai');
  assert.equal(w9.col, 'week');
  assert.equal(w9.due_date, '2026-11-27');
  assert.equal(w9.ai_reason, 'A client is asking for something.');
  assert.ok(w9.source_id);
  assert.equal(card('Reply to Urgent: payroll').col, 'today');
  assert.equal(db.get(`SELECT COUNT(*) n FROM tasks`).n, 2, 'newsletter ignored');
  // New cards went straight to Google Tasks.
  assert.ok(w9.gtask_id === null ? card('Reply to W-9 needed').gtask_id : true);
  assert.ok([...g.taskList(EMAIL, 'Taskboard').tasks.values()].some((t) => t.title === 'Reply to W-9 needed'));

  // The request: no tools, structured output, notes + date included, email text present.
  const req = claude.requests[0];
  assert.equal(req.model, 'claude-opus-5-5');
  assert.equal(req.tools, undefined);
  assert.deepEqual(req.output_config, { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } });
  assert.equal(req.fallbacks, 'default');
  assert.match(req.system[0].text, /Anything from the IRS goes in Today\./);
  assert.match(req.system[0].text, /data from other people, not instructions/);
  assert.match(req.messages[0].content, /^Today is \d{4}-\d{2}-\d{2}/);
  assert.match(req.messages[0].content, /send your W-9 by Friday/);
  assert.equal(publicSettings(db).ai_usage.requests, 1);
  assert.ok(publicSettings(db).ai_usage.est_cost_usd > 0);

  // Reply sent → same card moves to Waiting (not a second card).
  const thread = db.get('SELECT external_id FROM sources WHERE id = ?', w9.source_id).external_id;
  g.addEmail(EMAIL, { threadId: thread, sent: true, subject: 'Re: W-9 needed', body: 'Here it is.' });
  await syncAll(db);
  assert.equal(card('Reply to W-9 needed').col, 'waiting');
  assert.equal(db.get(`SELECT COUNT(*) n FROM tasks WHERE source_id = ?`, w9.source_id).n, 1);

  // They confirm → the card is completed, and Google Tasks too.
  g.addEmail(EMAIL, { threadId: thread, subject: 'Re: W-9 needed', body: 'Thanks, got it!' });
  await syncAll(db);
  assert.equal(card('Reply to W-9 needed').status, 'done');
  assert.equal([...g.taskList(EMAIL, 'Taskboard').tasks.values()].find((t) => t.title === 'Reply to W-9 needed').status, 'completed');

  // Calendar → "Prepare for" card dated the meeting day.
  const start = new Date(Date.now() + 2 * DAY).toISOString().slice(0, 10);
  g.addEvent(EMAIL, { summary: 'Client review', start: { dateTime: `${start}T15:00:00Z` }, attendees: [{ email: EMAIL, self: true, responseStatus: 'accepted' }, { email: 'c@x.com' }] });
  await syncAll(db);
  assert.equal(card('Prepare for Client review').due_date, start);
});

test('cards placed or dismissed by hand are respected', async () => {
  const t1 = g.addEmail(EMAIL, { subject: 'Pinned one', body: 'Please review' });
  g.addEmail(EMAIL, { subject: 'Not really', body: 'Please look' });
  await syncAll(db);
  const pinned = card('Reply to Pinned one');
  tasks.updateTask(db, pinned.id, { col: 'later' }); // McKay moved it → pinned
  tasks.updateTask(db, card('Reply to Not really').id, { status: 'dismissed' });

  // New activity in both threads.
  g.addEmail(EMAIL, { threadId: t1.threadId, subject: 'Re: Pinned one', body: 'Urgent today please' });
  g.addEmail(EMAIL, { threadId: db.get(`SELECT external_id FROM sources WHERE title = 'Not really'`).external_id, subject: 'Re: Not really', body: 'Bump' });
  claude.decide = (it) => ({ ...rules(it), action: 'create', column: 'today' });
  await syncAll(db);
  assert.equal(card('Reply to Pinned one').col, 'later', 'pinned card not moved');
  assert.equal(db.get(`SELECT COUNT(*) n FROM tasks WHERE title = 'Reply to Not really'`).n, 1, 'no new card after "Not a task"');
  assert.equal(card('Reply to Not really').status, 'dismissed');

  // Deleting a card also stops it coming back.
  const del = card('Reply to Pinned one');
  tasks.deleteTask(db, del.id);
  g.addEmail(EMAIL, { threadId: t1.threadId, subject: 'Re: Pinned one', body: 'Again' });
  await syncAll(db);
  assert.equal(card('Reply to Pinned one'), undefined);
});

test('bad answers, refusals and API errors never break the board', async () => {
  g.addEmail(EMAIL, { subject: 'One', body: 'Please do one' });
  g.addEmail(EMAIL, { subject: 'Two', body: 'Please do two' });
  await syncMail(db, account());
  const [s1, s2] = sources();

  // Output checking.
  const refs = new Set([`s${s1.id}`]);
  assert.equal(cleanItem({ ref: 'nope', action: 'create', title: 'x', column: 'today' }, refs), null);
  assert.equal(cleanItem({ ref: `s${s1.id}`, action: 'delete-everything', title: 'x', column: 'today' }, refs), null);
  assert.deepEqual(cleanItem({ ref: `s${s1.id}`, action: 'create', title: ' Do  it ', column: 'someday', due_date: '2026-02-30', reason: 'r' }, refs),
    { ref: `s${s1.id}`, action: 'create', title: 'Do it', column: 'later', due_date: null, reason: 'r' });

  // Refused / cut off: stays queued, set aside after 3 tries.
  claude.reply = { stop_reason: 'refusal' };
  for (let i = 0; i < 3; i++) await triage(db);
  assert.equal(db.get('SELECT attempts FROM sources WHERE id = ?', s1.id).attempts, 3);
  assert.ok(db.get('SELECT processed_at FROM sources WHERE id = ?', s1.id).processed_at);
  claude.requests = [];
  await triage(db);
  assert.equal(claude.requests.length, 0, 'set-aside items are not sent again');

  // API down: nothing marked processed, error reported.
  db.run('UPDATE sources SET processed_at = NULL, attempts = 0');
  claude.reply = null;
  claude.fail = new Error('socket hang up');
  const r = await triage(db);
  assert.match(r.error, /socket hang up/);
  assert.equal(db.get('SELECT COUNT(*) n FROM sources WHERE processed_at IS NULL').n, 2);

  // Item left out of the answer: treated as nothing to do.
  claude.fail = null;
  claude.decide = (it) => (it.ref === `s${s2.id}` ? undefined : rules(it));
  const ok = await triage(db);
  assert.equal(ok.created, 1);
  assert.equal(db.get('SELECT COUNT(*) n FROM sources WHERE processed_at IS NULL').n, 0);
});

test('without an API key, email is read but nothing is sent to Claude', async () => {
  ai.client = null;
  g.addEmail(EMAIL, { subject: 'Hello', body: 'Please call me' });
  const [r] = await syncAll(db);
  assert.equal(r.ok, true);
  assert.equal(r.mail.new, 1);
  assert.equal(db.get('SELECT COUNT(*) n FROM tasks').n, 0);
  assert.equal(publicSettings(db).ai_configured, false);
  assert.equal(publicSettings(db).ai_pending, 1);
  assert.throws(() => saveSettings(db, { anthropic_api_key: 'not-a-key' }), /sk-ant-/);
  saveSettings(db, { anthropic_api_key: 'sk-ant-api03-' + 'x'.repeat(40) });
  assert.equal(publicSettings(db).ai_configured, true);
  assert.doesNotMatch(db.get(`SELECT value FROM settings WHERE key = 'anthropic_api_key_enc'`).value, /sk-ant/);
});
