import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../server/db.js';
import { createHandler } from '../server/app.js';
import { createUser } from '../server/auth.js';
import { createCompany } from '../server/services/names.js';
import { createBackup } from '../server/backup.js';

test('move books to a new installation by restoring an encrypted backup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-move-'));
  try {
    // Old computer
    const oldDb = new Db(join(dir, 'old.db'));
    createUser(oldDb, { email: 'mckay@example.test', name: 'McKay', password: 'my-long-password', role: 'admin' });
    createCompany(oldDb, { name: 'Client One LLC' });
    createCompany(oldDb, { name: 'Client Two LLC' });
    const backup = createBackup(oldDb, 'backup passphrase 123');
    oldDb.close();

    // New server, empty
    const newDb = new Db(join(dir, 'new.db'));
    const server = createServer(createHandler(newDb));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (p, body, cookie) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ledger', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
    try {
      assert.equal((await (await fetch(base + '/api/auth/status')).json()).needs_setup, true);
      const wrong = await post('/api/auth/restore', { data_base64: backup.toString('base64'), passphrase: 'not the passphrase' });
      assert.equal(wrong.status, 400);
      const ok = await post('/api/auth/restore', { data_base64: backup.toString('base64'), passphrase: 'backup passphrase 123' });
      assert.deepEqual(await ok.json(), { ok: true, users: 1, companies: 2 });
      const login = await post('/api/auth/login', { email: 'mckay@example.test', password: 'my-long-password' });
      assert.equal(login.status, 200);
      const cookie = login.headers.get('set-cookie').split(';')[0];
      const companies = await (await fetch(base + '/api/companies', { headers: { Cookie: cookie } })).json();
      assert.deepEqual(companies.map((c) => c.name), ['Client One LLC', 'Client Two LLC']);
      // Once restored (users exist), restore is refused so nobody can overwrite live books.
      const again = await post('/api/auth/restore', { data_base64: backup.toString('base64'), passphrase: 'backup passphrase 123' });
      assert.equal(again.status, 403);
    } finally { server.close(); newDb.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
