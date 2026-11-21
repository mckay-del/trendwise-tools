// In-memory stand-in for Google's OAuth, userinfo and Tasks endpoints (used by the tests and for local UI checks).
import { SCOPES } from '../server/services/google.js';

export class FakeGoogle {
  constructor() {
    this.users = new Map(); // email -> { refresh, lists: Map(id -> {id,title,tasks: Map}) }
    this.codes = new Map();
    this.access = new Map(); // access token -> email
    this.seq = 0;
    this.clock = Date.parse('2026-11-21T10:00:00Z');
    this.calls = [];
    this.revoked = [];
    this.grantScopes = SCOPES.join(' ');
  }
  now() { this.clock += 1000; return new Date(this.clock).toISOString(); }
  addUser(email) {
    const lists = new Map([['default', { id: 'default', title: 'My Tasks', tasks: new Map() }]]);
    this.users.set(email, { refresh: `rt-${email}`, lists });
    return lists;
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
    const lists = this.users.get(email).lists;
    let m;
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

