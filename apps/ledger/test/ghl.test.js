import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Db } from '../server/db.js';
import { createCompany } from '../server/services/names.js';
import { listAccounts } from '../server/services/accounts.js';
import { getTransaction } from '../server/services/transactions.js';
import { saveConnection, syncCompany, testConnection, getConnection } from '../server/services/ghl.js';

// --- A simulated GHL API, shaped like the published OpenAPI definitions -------------------------
const TOKEN = 'pit-test-token-1234';
const LOC = 'LocABC123xyz';
const data = { invoices: [], payments: [] };
const seen = [];
let mock;

before(async () => {
  mock = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    seen.push({ path: url.pathname, version: req.headers.version, auth: req.headers.authorization, q: Object.fromEntries(url.searchParams) });
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { message: 'Invalid JWT' });
    if (req.headers.version !== '2021-07-28') return send(400, { message: 'Version header missing' });
    if (url.searchParams.get('altId') !== LOC || url.searchParams.get('altType') !== 'location') return send(422, { message: 'altId/altType required' });
    if (url.pathname === '/invoices/' && !url.searchParams.get('offset')) return send(422, { message: ['offset must be a string', 'offset should not be empty'] }); // real GHL requires it
    const limit = Number(url.searchParams.get('limit') ?? 10), offset = Number(url.searchParams.get('offset') ?? 0);
    if (url.pathname === '/invoices/') return send(200, { invoices: data.invoices.slice(offset, offset + limit), total: data.invoices.length });
    if (url.pathname === '/payments/transactions') return send(200, { data: data.payments.slice(offset, offset + limit), totalCount: data.payments.length });
    send(404, { message: 'not found' });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  process.env.GHL_API_BASE = `http://127.0.0.1:${mock.address().port}`;
});
after(() => mock.close());

const contact = { id: 'c-1', name: 'Dana Ruiz', companyName: 'Ruiz Dental', email: 'dana@ruizdental.test', address: { addressLine1: '10 Main St', city: 'Henderson', state: 'NV', postalCode: '89012' } };
const invoice = (over) => ({ _id: 'inv-1', status: 'sent', liveMode: true, invoiceNumber: 1042, currency: 'USD', issueDate: '2026-03-02', dueDate: '2026-03-16', contactDetails: contact,
  invoiceItems: [{ _id: 'i1', productId: 'prod-seo', name: 'SEO package', description: 'Monthly', qty: 1, amount: 500, taxes: [] }, { _id: 'i2', productId: 'prod-web', name: 'Website care', qty: 2, amount: 75, taxes: [{ name: 'NV', rate: 8.375 }] }],
  totalSummary: { subTotal: 650, discount: 50, tax: 12.56 }, total: 612.56, amountPaid: 0, amountDue: 612.56, ...over });

test('GHL sync: preview, invoices, payments, edits, voids, refunds, paging', async () => {
  const db = new Db(':memory:');
  const co = createCompany(db, { name: 'Ruiz Client Books' });
  const A = Object.fromEntries(listAccounts(db, co.id).map((a) => [a.name, a.id]));
  const bal = (n) => listAccounts(db, co.id).find((a) => a.name === n).balance;

  saveConnection(db, co.id, { location_id: LOC, token: 'wrong-key-0000', start_date: '2026-03-01' });
  await assert.rejects(() => syncCompany(db, co.id), /rejected the key/);
  saveConnection(db, co.id, { token: TOKEN });
  assert.equal(getConnection(db, co.id).token_hint, '••••1234');
  assert.equal(getConnection(db, co.id).token, undefined, 'the key is never sent back');

  data.invoices = [
    invoice(),
    invoice({ _id: 'inv-draft', status: 'draft', invoiceNumber: 1043 }),
    invoice({ _id: 'inv-old', invoiceNumber: 1001, issueDate: '2026-02-10', dueDate: '2026-02-24' }),
    { ...invoice({ _id: 'inv-2', invoiceNumber: 1044, issueDate: '2026-03-05', dueDate: '2026-03-05' }), invoiceItems: [{ productId: 'prod-seo', name: 'SEO package', qty: 1, amount: 500 }], totalSummary: { subTotal: 500, discount: 0, tax: 0 }, total: 500 },
  ];
  data.payments = [
    { _id: 'pay-1', status: 'succeeded', liveMode: true, amount: 300, currency: 'usd', entityType: 'invoice', entityId: 'inv-1', chargeId: 'ch_3Abc', contactId: 'c-1', contactName: 'Dana Ruiz', createdAt: '2026-03-04T18:22:00.000Z', amountRefunded: 0 },
    { _id: 'pay-funnel', status: 'succeeded', liveMode: true, amount: 97, currency: 'usd', entityType: 'order', entitySourceType: 'funnel', entitySourceName: 'Starter Audit', entityId: 'ord-9', chargeId: 'ch_3Fun', contactId: 'c-2', contactName: 'Sam Lee', contactEmail: 'sam@test', createdAt: '2026-03-06T02:15:00.000Z', amountRefunded: 0 },
    { _id: 'pay-test', status: 'succeeded', liveMode: false, amount: 1, currency: 'usd', entityType: 'invoice', entityId: 'inv-1', createdAt: '2026-03-06T00:00:00Z' },
    { _id: 'pay-failed', status: 'failed', liveMode: true, amount: 50, currency: 'usd', entityType: 'invoice', entityId: 'inv-2', createdAt: '2026-03-07T00:00:00Z' },
    { _id: 'pay-old', status: 'succeeded', liveMode: true, amount: 612.56, currency: 'usd', entityType: 'invoice', entityId: 'inv-old', contactId: 'c-1', contactName: 'Dana Ruiz', chargeId: 'ch_3Old', createdAt: '2026-03-08T17:00:00Z', amountRefunded: 0 },
  ];

  // Preview: shows the plan, saves nothing
  const pv = await syncCompany(db, co.id, { dryRun: true });
  assert.deepEqual([pv.stats.invoices.created, pv.stats.payments.created, pv.stats.invoices.skipped, pv.stats.payments.skipped], [2, 3, 2, 2]);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM transactions').n, 0);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM customers').n, 0);
  assert.ok(seen.every((s) => s.version === '2021-07-28'), 'Version header sent');

  // Real sync
  const r1 = await syncCompany(db, co.id);
  assert.deepEqual(r1.stats.invoices, { created: 2, updated: 0, voided: 0, unchanged: 0, skipped: 2 });
  assert.equal(r1.stats.payments.created, 3);
  const inv = getTransaction(db, co.id, db.get("SELECT local_id FROM external_links WHERE kind='invoice' AND external_id='inv-1'").local_id);
  assert.equal(inv.number, '1042');
  assert.equal(inv.total, 61256);
  assert.equal(inv.customer_name, 'Ruiz Dental');
  assert.equal(inv.due_date, '2026-03-16');
  assert.equal(inv.balance, 31256, 'partial payment applied');
  assert.equal(bal('Sales Tax Payable'), 1256);
  assert.equal(bal('Discounts Given'), -5000);
  assert.equal(bal('Undeposited Funds'), 30000 + 9700 + 61256);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM items").n, 2, 'GHL products became products & services');
  const receipt = db.get("SELECT t.type, t.date, t.number FROM transactions t JOIN external_links l ON l.local_id = t.id WHERE l.external_id = 'pay-funnel'");
  assert.deepEqual({ ...receipt }, { type: 'sales_receipt', date: '2026-03-05', number: 'ch_3Fun' }, 'UTC evening converted to the Pacific date');
  const conn = getConnection(db, co.id);
  assert.equal(conn.issues.length, 1);
  assert.match(conn.issues[0].message, /before the sync start date/);

  // Re-running changes nothing
  const r2 = await syncCompany(db, co.id);
  assert.deepEqual([r2.stats.invoices.created, r2.stats.payments.created, r2.stats.invoices.unchanged], [0, 0, 2]);

  // Edits, voids and refunds in GHL flow through
  data.invoices[0] = invoice({ invoiceItems: [...invoice().invoiceItems, { productId: 'prod-seo', name: 'SEO package', qty: 1, amount: 100 }], totalSummary: { subTotal: 750, discount: 50, tax: 12.56 }, total: 712.56 });
  data.invoices[3] = { ...data.invoices[3], status: 'void' };
  data.payments[0] = { ...data.payments[0], status: 'partially_refunded', amountRefunded: 40, updatedAt: '2026-03-10T16:00:00Z' };
  const r3 = await syncCompany(db, co.id);
  assert.deepEqual([r3.stats.invoices.updated, r3.stats.invoices.voided, r3.stats.payments.refunds], [1, 1, 1]);
  assert.equal(getTransaction(db, co.id, inv.id).total, 71256);
  data.payments[0] = { ...data.payments[0], status: 'refunded', amountRefunded: 300 };
  const r4 = await syncCompany(db, co.id);
  assert.equal(r4.stats.payments.refunds, 1);
  assert.equal(bal('Undeposited Funds'), 30000 + 9700 + 61256 - 30000, 'refunds of $40 then $260');

  // Problems are reported, not fatal: an invoice whose lines don't add up
  data.invoices.push({ ...invoice({ _id: 'inv-bad', invoiceNumber: 1050 }), total: 999 });
  const r5 = await syncCompany(db, co.id);
  assert.equal(r5.stats.issues, 1 + 0);
  assert.ok(getConnection(db, co.id).issues.some((i) => /add up to/.test(i.message)));

  // Connection test
  const t = await testConnection(db, co.id);
  assert.equal(t.invoices.ok, true);
  assert.equal(t.payments.ok, true);
});

test('GHL sync pages through long lists', async () => {
  const db = new Db(':memory:');
  const co = createCompany(db, { name: 'Busy Client' });
  saveConnection(db, co.id, { location_id: LOC, token: TOKEN, start_date: '2026-01-01' });
  data.invoices = Array.from({ length: 150 }, (_, i) => ({ ...invoice({ _id: `bulk-${i}`, invoiceNumber: 2000 + i, issueDate: '2026-04-01', dueDate: '2026-04-15' }), invoiceItems: [{ name: 'Retainer', qty: 1, amount: 100 }], totalSummary: { subTotal: 100, discount: 0, tax: 0 }, total: 100 }));
  data.payments = [];
  const r = await syncCompany(db, co.id);
  assert.equal(r.stats.fetched.invoices, 150);
  assert.equal(r.stats.invoices.created, 150);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM transactions WHERE type='invoice'").n, 150);
});

test('sync schedules and the month-end checklist item', async () => {
  const { dueForSync } = await import('../server/services/ghl.js');
  const { closeStatus } = await import('../server/services/close.js');
  const db = new Db(':memory:');
  const daily = createCompany(db, { name: 'Daily Co' });
  const hourly = createCompany(db, { name: 'Hourly Co' });
  const manual = createCompany(db, { name: 'Manual Co' });
  saveConnection(db, daily.id, { location_id: LOC, token: TOKEN, start_date: '2026-01-01' });
  saveConnection(db, hourly.id, { location_id: LOC, token: TOKEN, start_date: '2026-01-01', schedule: 'hourly' });
  saveConnection(db, manual.id, { location_id: LOC, token: TOKEN, start_date: '2026-01-01', schedule: 'manual' });
  const ids = (now) => dueForSync(db, now).map((c) => c.company_id).sort();
  // 2:30 AM and 2:30 PM Pacific (UTC-8 in November)
  const night = new Date('2026-11-14T10:30:00Z'), afternoon = new Date('2026-11-14T22:30:00Z');
  assert.deepEqual(ids(night), [daily.id, hourly.id]);
  assert.deepEqual(ids(afternoon), [hourly.id], 'daily clients wait for the overnight window');
  db.run("UPDATE ghl_connections SET last_sync_at = '2026-11-14 09:45:00'");
  assert.deepEqual(ids(night), [], 'nothing re-runs right after a sync');
  assert.deepEqual(ids(new Date('2026-11-14T11:00:00Z')), [hourly.id], 'hourly runs again an hour later; daily waits for tomorrow night');

  const c = () => db.get('SELECT * FROM companies WHERE id = ?', daily.id);
  db.run("UPDATE ghl_connections SET last_sync_at = '2026-10-31 20:00:00' WHERE company_id = ?", daily.id);
  let item = closeStatus(db, c(), '2026-10').items.find((i) => i.key === 'ghl');
  assert.equal(item.status, 'todo', 'synced before month end ended');
  db.run("UPDATE ghl_connections SET last_sync_at = '2026-11-02 09:00:00' WHERE company_id = ?", daily.id);
  item = closeStatus(db, c(), '2026-10').items.find((i) => i.key === 'ghl');
  assert.equal(item.status, 'ok');
  assert.equal(closeStatus(db, db.get('SELECT * FROM companies WHERE id = ?', createCompany(db, { name: 'No GHL' }).id), '2026-10').items.some((i) => i.key === 'ghl'), false, 'only shown for connected clients');
});
