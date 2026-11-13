import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Db } from '../server/db.js';
import { createHandler } from '../server/app.js';

let server, base, db;
before(async () => {
  db = new Db(':memory:');
  server = createServer(createHandler(db));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); db.close(); });

const call = async (method, path, body, cookie, headers = { 'X-Requested-With': 'ledger' }) => {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(method === 'GET' ? {} : headers) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json, cookie: res.headers.get('set-cookie')?.split(';')[0] };
};

test('auth, CSRF header, roles and static safety', async () => {
  assert.equal((await call('GET', '/api/companies')).status, 401);
  assert.equal((await call('GET', '/api/auth/status')).json.needs_setup, true);

  const setup = await call('POST', '/api/auth/setup', { name: 'Admin', email: 'a@x.test', password: 'correct-horse-battery' });
  assert.equal(setup.status, 200);
  const admin = setup.cookie;
  assert.match(admin, /^ledger_session=/);
  assert.equal((await call('POST', '/api/auth/setup', { name: 'B', email: 'b@x.test', password: 'another-password' })).status, 403);

  // Mutations without the custom header are rejected (CSRF defense).
  assert.equal((await call('POST', '/api/companies', { name: 'X' }, admin, {})).status, 403);
  const co = await call('POST', '/api/companies', { name: 'Acme' }, admin);
  assert.equal(co.status, 200);

  // Viewer can read but not write.
  assert.equal((await call('POST', '/api/users', { name: 'V', email: 'v@x.test', password: 'viewer-password', role: 'viewer' }, admin)).status, 200);
  const viewer = (await call('POST', '/api/auth/login', { email: 'v@x.test', password: 'viewer-password' })).cookie;
  assert.equal((await call('GET', `/api/c/${co.json.id}/accounts`, null, viewer)).status, 200);
  assert.equal((await call('POST', `/api/c/${co.json.id}/customers`, { display_name: 'Nope' }, viewer)).status, 403);
  assert.equal((await call('GET', '/api/users', null, viewer)).status, 403);

  // Wrong password
  assert.equal((await call('POST', '/api/auth/login', { email: 'a@x.test', password: 'wrong-password' })).status, 400);

  // Report CSV export
  const csv = await fetch(`${base}/api/c/${co.json.id}/reports/balance_sheet?format=csv`, { headers: { Cookie: admin } });
  assert.equal(csv.headers.get('content-type'), 'text/csv; charset=utf-8');
  assert.match(await csv.text(), /TOTAL ASSETS/);

  // Static file serving can't escape the public directory.
  for (const evil of ['/..%2f..%2fpackage.json', '/..%2fserver%2fdb.js', '/%2e%2e/%2e%2e/package.json']) {
    const body = await (await fetch(base + evil)).text();
    assert.ok(!body.includes('trendwise-ledger') && !body.includes('DatabaseSync'), `traversal via ${evil}`);
  }
  const idx = await fetch(`${base}/`);
  assert.equal(idx.headers.get('x-frame-options'), 'DENY');
  assert.match(idx.headers.get('content-security-policy'), /script-src 'self'/);

  // Logout invalidates the session.
  await call('POST', '/api/auth/logout', {}, admin);
  assert.equal((await call('GET', '/api/companies', null, admin)).status, 401);
});
