import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Db } from '../server/db.js';
import { createHandler } from '../server/app.js';
import { detectType } from '../server/services/attachments.js';

let server, base, db, cookie, cid, txnId;
const call = async (method, path, body) => {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ledger', Cookie: cookie ?? '' }, body: body ? JSON.stringify(body) : undefined });
  return res;
};
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]);

before(async () => {
  db = new Db(':memory:');
  server = createServer(createHandler(db));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const s = await call('POST', '/api/auth/setup', { name: 'A', email: 'a@x.test', password: 'long-enough-pw' });
  cookie = s.headers.get('set-cookie').split(';')[0];
  cid = (await (await call('POST', '/api/companies', { name: 'Files Co' })).json()).id;
  const accts = await (await call('GET', `/api/c/${cid}/accounts`)).json();
  const A = (n) => accts.find((a) => a.name === n).id;
  txnId = (await (await call('POST', `/api/c/${cid}/transactions`, { type: 'expense', date: '2026-03-01', account_id: A('Business Checking'), lines: [{ account_id: A('Meals'), amount: 42 }] })).json()).id;
});
after(() => { server.close(); db.close(); });

test('file types are decided by content, not name', () => {
  assert.equal(detectType(PDF, 'receipt.jpg').mime, 'application/pdf');
  assert.equal(detectType(PNG, 'x.png').mime, 'image/png');
  assert.equal(detectType(Buffer.from('<html><script>alert(1)</script>'), 'evil.pdf'), null);
  assert.equal(detectType(Buffer.from('<svg onload=alert(1)>'), 'logo.svg'), null);
  assert.equal(detectType(Buffer.from('Date,Amount\n1/1/26,5\n'), 'stmt.csv').mime, 'text/csv');
  assert.equal(detectType(Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2]), 'archive.zip'), null);
});

test('attach, list, download and delete', async () => {
  const up = await call('POST', `/api/c/${cid}/transactions/${txnId}/attachments`, { file_name: 'Lunch receipt.pdf', data_base64: PDF.toString('base64') });
  assert.equal(up.status, 200);
  const att = await up.json();
  assert.equal(att.mime, 'application/pdf');
  const dup = await call('POST', `/api/c/${cid}/transactions/${txnId}/attachments`, { file_name: 'again.pdf', data_base64: PDF.toString('base64') });
  assert.equal(dup.status, 400);
  const bad = await call('POST', `/api/c/${cid}/transactions/${txnId}/attachments`, { file_name: 'page.html', data_base64: Buffer.from('<html>').toString('base64') });
  assert.match((await bad.json()).error, /isn't a supported file/);

  const txn = await (await call('GET', `/api/c/${cid}/transactions/${txnId}`)).json();
  assert.equal(txn.attachments.length, 1);
  const list = await (await call('GET', `/api/c/${cid}/transactions?type=expense`)).json();
  assert.equal(list[0].attachment_count, 1);

  const file = await call('GET', `/api/c/${cid}/attachments/${att.id}`);
  assert.equal(file.headers.get('content-type'), 'application/pdf');
  assert.match(file.headers.get('content-disposition'), /^inline; filename="Lunch receipt.pdf"/);
  assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), PDF);
  const dl = await call('GET', `/api/c/${cid}/attachments/${att.id}?download=1`);
  assert.match(dl.headers.get('content-disposition'), /^attachment;/);

  // Signed-out users and other companies can't read it
  const anon = await fetch(`${base}/api/c/${cid}/attachments/${att.id}`);
  assert.equal(anon.status, 401);
  const other = (await (await call('POST', '/api/companies', { name: 'Other Co' })).json()).id;
  assert.equal((await call('GET', `/api/c/${other}/attachments/${att.id}`)).status, 404);

  assert.equal((await call('DELETE', `/api/c/${cid}/attachments/${att.id}`)).status, 200);
  assert.equal((await (await call('GET', `/api/c/${cid}/transactions/${txnId}`)).json()).attachments.length, 0);
});

test('deleting a transaction deletes its files', async () => {
  await call('POST', `/api/c/${cid}/transactions/${txnId}/attachments`, { file_name: 'photo.png', data_base64: PNG.toString('base64') });
  await call('DELETE', `/api/c/${cid}/transactions/${txnId}`);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM attachments').n, 0);
});
