// In-memory stand-in for Google's OAuth, userinfo and Tasks endpoints (used by the tests and for local UI checks).
import { SCOPES } from '../server/services/google.js';

export class FakeGoogle {
  constructor() {
    this.users = new Map(); // email -> { refresh, lists: Map(id -> {id,title,tasks: Map}) }
    this.codes = new Map();
    this.access = new Map(); // access token -> email
    this.seq = 0;
    this.clock = Date.now(); // real time: the app compares Google's timestamps with its own clock
    this.calls = [];
    this.revoked = [];
    this.grantScopes = SCOPES.join(' ');
  }
  now() { this.clock += 1000; return new Date(this.clock).toISOString(); }
  addUser(email) {
    const lists = new Map([['default', { id: 'default', title: 'My Tasks', tasks: new Map() }]]);
    this.users.set(email, {
      refresh: `rt-${email}`, lists,
      // Gmail: threads, a running history id, and the oldest history id still available.
      threads: new Map(), historyId: 1000, history: [], historyFloor: 0,
      // Calendar: one primary calendar; sync tokens are "t<seq>", anything below calFloor has expired.
      events: new Map(), calSeq: 0, calFloor: 0,
    });
    return lists;
  }

  /** Add a message (new thread, or a reply when threadId is given). `sent` = written by the account owner. */
  addEmail(email, { threadId, from = 'Client <client@example.com>', subject = 'Hello', body = 'Hi', labels = ['INBOX', 'UNREAD'], sent = false, html = false, daysAgo = 0 }) {
    const u = this.users.get(email);
    const id = `m${++this.seq}`;
    const tid = threadId ?? `t${this.seq}`;
    const at = this.clock - daysAgo * 86400_000; this.now();
    const data = Buffer.from(body).toString('base64url');
    const msg = {
      id, threadId: tid, labelIds: sent ? ['SENT', ...labels.filter((l) => l !== 'UNREAD')] : labels, snippet: body.slice(0, 100), internalDate: String(at),
      payload: { mimeType: 'multipart/alternative', headers: [{ name: 'From', value: sent ? email : from }, { name: 'To', value: sent ? from : email }, { name: 'Subject', value: subject }, { name: 'Date', value: new Date(at).toUTCString() }],
        parts: [{ mimeType: html ? 'text/html' : 'text/plain', body: { data } }] },
    };
    if (!u.threads.has(tid)) u.threads.set(tid, { id: tid, messages: [] });
    u.threads.get(tid).messages.push(msg);
    u.historyId++;
    if (msg.labelIds.includes('INBOX')) u.history.push({ id: String(u.historyId), messagesAdded: [{ message: { id, threadId: tid, labelIds: msg.labelIds } }] });
    return msg;
  }

  addEvent(email, ev) {
    const u = this.users.get(email);
    const e = { id: `e${++this.seq}`, status: 'confirmed', eventType: 'default', htmlLink: `https://calendar.google.com/event?eid=${this.seq}`, ...ev, updated: this.now(), _seq: ++u.calSeq };
    u.events.set(e.id, e);
    return e;
  }
  editEvent(email, id, patch) {
    const u = this.users.get(email);
    Object.assign(u.events.get(id), patch, { updated: this.now(), _seq: ++u.calSeq });
  }
  issueCode(email) { const c = `code-${++this.seq}`; this.codes.set(c, email); return c; }
  addRemote(email, listId, t) {
    const task = { id: `g${++this.seq}`, status: 'needsAction', updated: this.now(), ...t };
    this.users.get(email).lists.get(listId).tasks.set(task.id, task);
    return task;
  }
  edit(email, listId, id, patch) { Object.assign(this.users.get(email).lists.get(listId).tasks.get(id), patch, { updated: this.now() }); }
  taskList(email, title) { return [...this.users.get(email).lists.values()].find((l) => l.title === title); }

  fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const method = opts.method ?? 'GET';
    this.calls.push(`${method} ${u.pathname}`);
    const json = (status, body) => new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (u.href.startsWith('https://oauth2.googleapis.com/token')) {
      const p = new URLSearchParams(opts.body);
      if (p.get('grant_type') === 'authorization_code') {
        const email = this.codes.get(p.get('code'));
        if (!email) return json(400, { error: 'invalid_grant' });
        const at = `at-${++this.seq}`; this.access.set(at, email);
        return json(200, { access_token: at, expires_in: 3600, refresh_token: this.users.get(email).refresh, scope: this.grantScopes });
      }
      const email = [...this.users].find(([, v]) => v.refresh === p.get('refresh_token'))?.[0];
      if (!email) return json(400, { error: 'invalid_grant' });
      const at = `at-${++this.seq}`; this.access.set(at, email);
      return json(200, { access_token: at, expires_in: 3600 });
    }
    if (u.href.startsWith('https://oauth2.googleapis.com/revoke')) { this.revoked.push(new URLSearchParams(opts.body).get('token')); return json(200, {}); }
    const email = this.access.get(String(opts.headers?.Authorization ?? '').replace('Bearer ', ''));
    if (!email) return json(401, { error: { message: 'Invalid Credentials' } });
    if (u.hostname === 'openidconnect.googleapis.com') return json(200, { email });
    const user = this.users.get(email);
    const lists = user.lists;
    let m;
    // ---- Gmail ----
    if (u.pathname === '/gmail/v1/users/me/profile') return json(200, { emailAddress: email, historyId: String(user.historyId) });
    if (u.pathname === '/gmail/v1/users/me/messages') {
      const q = u.searchParams.get('q') ?? '';
      const days = Number(q.match(/newer_than:(\d+)d/)?.[1] ?? 3650);
      const cats = ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS'];
      const messages = [];
      for (const t of user.threads.values()) for (const msg of t.messages) {
        if (!msg.labelIds.includes('INBOX') || msg.labelIds.some((l) => cats.includes(l))) continue;
        if (Number(msg.internalDate) < this.clock - days * 86400_000) continue;
        messages.push({ id: msg.id, threadId: t.id });
      }
      return json(200, { messages: messages.reverse() });
    }
    if (u.pathname === '/gmail/v1/users/me/history') {
      const start = Number(u.searchParams.get('startHistoryId'));
      if (start < user.historyFloor) return json(404, { error: { message: 'Requested entity was not found.' } });
      return json(200, { history: user.history.filter((h) => Number(h.id) > start), historyId: String(user.historyId) });
    }
    if ((m = u.pathname.match(/^\/gmail\/v1\/users\/me\/threads\/([^/]+)$/))) {
      const t = user.threads.get(decodeURIComponent(m[1]));
      return t ? json(200, t) : json(404, { error: { message: 'Not found' } });
    }
    // ---- Calendar ----
    if (u.pathname === '/calendar/v3/users/me/calendarList') return json(200, { items: [{ id: email, primary: true, selected: true, accessRole: 'owner' }] });
    if (u.pathname === '/calendar/v3/calendars/primary/events') {
      const token = u.searchParams.get('syncToken');
      let since = 0;
      if (token) { since = Number(token.slice(1)); if (since < user.calFloor) return json(410, { error: { message: 'Sync token is no longer valid' } }); }
      const items = [...user.events.values()].filter((e) => e._seq > since).map(({ _seq, ...e }) => e);
      return json(200, { items, nextSyncToken: `t${user.calSeq}` });
    }
    // ---- Tasks ----
    if (u.pathname === '/tasks/v1/users/@me/lists') {
      if (method === 'POST') { const l = { id: `list${++this.seq}`, title: JSON.parse(opts.body).title, tasks: new Map() }; lists.set(l.id, l); return json(200, { id: l.id, title: l.title }); }
      return json(200, { items: [...lists.values()].map(({ id, title }) => ({ id, title })) });
    }
    if ((m = u.pathname.match(/^\/tasks\/v1\/lists\/([^/]+)\/tasks(?:\/([^/]+))?$/))) {
      const list = lists.get(decodeURIComponent(m[1]));
      if (!list) return json(404, { error: { message: 'Not found' } });
      const id = m[2] && decodeURIComponent(m[2]);
      if (method === 'GET') {
        const since = u.searchParams.get('updatedMin');
        const items = [...list.tasks.values()].filter((t) => (!since || t.updated >= since)
          && (u.searchParams.get('showCompleted') === 'true' || t.status !== 'completed')
          && (u.searchParams.get('showDeleted') === 'true' || !t.deleted));
        return json(200, { items });
      }
      if (method === 'POST') { const t = { id: `g${++this.seq}`, ...JSON.parse(opts.body), updated: this.now() }; list.tasks.set(t.id, t); return json(200, t); }
      const t = list.tasks.get(id);
      if (!t || t.deleted) return json(404, { error: { message: 'Not found' } });
      if (method === 'PATCH') { Object.assign(t, JSON.parse(opts.body), { updated: this.now() }); return json(200, t); }
      if (method === 'DELETE') { t.deleted = true; t.updated = this.now(); return new Response(null, { status: 204 }); }
    }
    return json(404, { error: { message: `unhandled ${method} ${u.pathname}` } });
  };
}

