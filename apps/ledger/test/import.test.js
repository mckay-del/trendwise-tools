import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { Db } from '../server/db.js';
import { createCompany } from '../server/services/names.js';
import { listAccounts } from '../server/services/accounts.js';
import { runReport } from '../server/services/reports.js';
import { importAccounts, importParties, importOpening, listImports, undoImport } from '../server/services/qboImport.js';
import { previewStatement, importStatement, lastImport, getImportSettings } from '../server/services/banking.js';
import { readXlsx } from '../server/services/tabular.js';

/** Build a real .xlsx (deflated zip) from rows. Strings go to sharedStrings; numbers inline. */
function makeXlsx(rows) {
  const shared = [];
  const sIdx = (s) => { let i = shared.indexOf(s); if (i < 0) { shared.push(s); i = shared.length - 1; } return i; };
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const col = (i) => { let s = ''; i++; while (i) { s = String.fromCharCode(65 + ((i - 1) % 26)) + s; i = Math.floor((i - 1) / 26); } return s; };
  const sheet = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => (v === '' || v === null ? '' : typeof v === 'number' ? `<c r="${col(ci)}${ri + 1}"><v>${v}</v></c>` : `<c r="${col(ci)}${ri + 1}" t="s"><v>${sIdx(v)}</v></c>`)).join('')}</row>`).join('')}</sheetData></worksheet>`;
  const files = {
    'xl/workbook.xml': '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': sheet,
    'xl/sharedStrings.xml': `<sst>${shared.map((s) => `<si><t>${esc(s)}</t></si>`).join('')}</sst>`,
  };
  const locals = [], centrals = [];
  let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = deflateRawSync(Buffer.from(text));
    const nb = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(text.length, 22); lh.writeUInt16LE(nb.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(text.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, nb, data); centrals.push(ch, nb);
    off += 30 + nb.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}
const xlsxFile = (rows, file_name = 'export.xlsx') => ({ data_base64: makeXlsx(rows).toString('base64'), file_name });
const csvFile = (content, file_name = 'export.csv') => ({ content, file_name });

const ACCOUNT_LIST = [
  ['Desert Bloom LLC'], ['Account List'], [],
  ['Account', 'Type', 'Detail type', 'Description', 'Balance'],
  ['Checking', 'Bank', 'Checking', '', 5000],
  ['Accounts Receivable (A/R)', 'Accounts receivable (A/R)', 'Accounts Receivable (A/R)', '', 1500],
  ['Truck', 'Fixed Assets', 'Vehicles', '', ''],
  ['Truck:Original Cost', 'Fixed Assets', 'Vehicles', '', 20000],
  ['Accounts Payable (A/P)', 'Accounts payable (A/P)', 'Accounts Payable (A/P)', '', 800],
  ['Opening Balance Equity', 'Equity', 'Opening Balance Equity', '', ''],
  ['Retained Earnings', 'Equity', 'Retained Earnings', '', ''],
  ['Sales', 'Income', 'Service/Fee Income', '', ''],
  ['Utilities', 'Expenses', 'Utilities', '', ''],
  ['Utilities:Electric', 'Expenses', 'Utilities', 'Power', ''],
  ['Mystery', 'Weird Type', '', '', ''],
];

const TB = `Desert Bloom LLC
Trial Balance
"As of December 31, 2025"

,Debit,Credit
Checking,"5,000.00",
Accounts Receivable (A/R),"1,500.00",
Truck:Original Cost,"20,000.00",
Accounts Payable (A/P),,800.00
Opening Balance Equity,,"10,000.00"
Retained Earnings,,"8,000.00"
Sales,,"30,000.00"
Utilities:Electric,"22,300.00",
TOTAL,"$48,800.00","$48,800.00"

"Wednesday, Jan 07, 2026 09:15 AM GMT-08:00"
`;

const AR = `A/R Aging Detail
"As of December 31, 2025"

Date,Transaction type,Num,Customer,Due date,Past due,Amount,Open balance
Current
12/15/2025,Invoice,1001,Acme Co,01/14/2026,0,"1,000.00","1,000.00"
Total for Current,,,,,,"1,000.00","1,000.00"
1 - 30 days past due
11/20/2025,Invoice,998,Beta LLC,12/20/2025,11,700.00,700.00
11/25/2025,Payment,,Beta LLC,11/25/2025,,-200.00,-200.00
Total for 1 - 30 days past due,,,,,,500.00,500.00
TOTAL,,,,,,"1,500.00","1,500.00"
`;

const AP = `A/P Aging Detail
"As of December 31, 2025"

Date,Transaction type,Num,Vendor,Due date,Past due,Amount,Open balance
12/10/2025,Bill,B-77,Power Co,01/09/2026,,800.00,800.00
TOTAL,,,,,,800.00,800.00
`;

let db, co;
const accts = () => listAccounts(db, co.id, { includeInactive: true });
const row = (rep, label) => rep.rows.find((r) => r.cells[0] === label || String(r.cells[0]).endsWith(' ' + label));

beforeEach(() => {
  db = new Db(':memory:');
  co = createCompany(db, { name: 'Imported Co' });
});

describe('xlsx reader', () => {
  test('reads shared strings, numbers and gaps', () => {
    const rows = readXlsx(makeXlsx([['a', '', 'c'], [1.5, 'x & y']]));
    assert.deepEqual(rows, [['a', '', 'c'], ['1.5', 'x & y']]);
  });
});

describe('QuickBooks import', () => {
  test('chart of accounts: preview changes nothing; import maps types, sub-accounts, A/R & A/P system accounts', () => {
    const before = accts().length;
    const pv = importAccounts(db, co.id, { file: xlsxFile(ACCOUNT_LIST), dryRun: true });
    assert.equal(pv.dry_run, true);
    assert.equal(accts().length, before);
    assert.ok(pv.warnings.some((w) => w.includes('Mystery')));

    const r = importAccounts(db, co.id, { file: xlsxFile(ACCOUNT_LIST), remove_unused: true });
    const list = accts();
    const by = (n) => list.find((a) => a.name === n);
    assert.equal(by('Accounts Receivable (A/R)').system_key, 'AR');
    assert.equal(by('Accounts Payable (A/P)').system_key, 'AP');
    assert.equal(by('Electric').parent_id, by('Utilities').id);
    assert.equal(by('Original Cost').parent_id, by('Truck').id);
    assert.equal(by('Original Cost').type, 'fixed_asset');
    assert.ok(r.removed.includes('Business Checking'), 'unused default accounts removed');
    assert.ok(by('Undeposited Funds'), 'system accounts are kept');
    assert.equal(listImports(db, co.id)[0].kind, 'accounts');
  });

  test('customers and vendors from list exports', () => {
    const c = importParties(db, co.id, 'customers', { file: csvFile('Name,Company name,Street Address,City,State,Zip,Phone,Email,Terms\nAcme Co,Acme Company,1 Main St,Las Vegas,NV,89101,(702) 555-0101,ap@acme.test,Net 15\n') });
    assert.deepEqual(c.created, ['Acme Co']);
    const acme = db.get("SELECT * FROM customers WHERE display_name = 'Acme Co'");
    assert.equal(acme.billing_address, '1 Main St\nLas Vegas, NV 89101');
    assert.equal(acme.terms_days, 15);
    const v = importParties(db, co.id, 'vendors', { file: xlsxFile([['Vendor', 'Company name', 'Email', 'Tax ID', '1099 Tracking'], ['J. Ortega', '', 'jo@test', '123-45-6789', 'Yes'], ['Power Co', 'Power Co', '', '', 'No']]) });
    assert.equal(v.created.length, 2);
    assert.equal(db.get("SELECT is_1099 FROM vendors WHERE display_name = 'J. Ortega'").is_1099, 1);
    // Re-import updates instead of duplicating
    const again = importParties(db, co.id, 'customers', { file: csvFile('Name,Email\nAcme Co,new@acme.test\n') });
    assert.deepEqual(again.updated, ['Acme Co']);
    assert.equal(db.get("SELECT email FROM customers WHERE display_name = 'Acme Co'").email, 'new@acme.test');
  });

  test('opening balances: trial balance + aging detail rebuild the books, then undo', () => {
    importAccounts(db, co.id, { file: xlsxFile(ACCOUNT_LIST) });
    const body = { date: '2025-12-31', trial_balance: csvFile(TB, 'tb.csv'), ar_aging: csvFile(AR), ap_aging: csvFile(AP) };

    const pv = importOpening(db, co.id, { ...body, dryRun: true });
    assert.equal(pv.unmatched.length, 0);
    assert.equal(pv.invoices, 2);
    assert.equal(pv.credits, 1);
    assert.equal(pv.bills, 1);
    assert.deepEqual(pv.warnings, []);
    assert.equal(db.get('SELECT COUNT(*) AS n FROM transactions').n, 0, 'preview rolled back');

    const r = importOpening(db, co.id, body);
    const c = db.get('SELECT * FROM companies WHERE id = ?', co.id);
    const bs = runReport(db, c, 'balance_sheet', { asof: '2025-12-31' });
    assert.equal(bs.check.assets, bs.check.liabilitiesAndEquity);
    assert.equal(bs.check.assets, 2650000);
    assert.equal(row(bs, 'Opening Balance Equity').cells[1], 1000000);
    assert.equal(row(bs, 'Retained Earnings').cells[1], 800000);
    assert.equal(row(bs, 'Net Income').cells[1], 770000);
    // Next year: 2025 profit rolls into retained earnings
    const bs26 = runReport(db, c, 'balance_sheet', { asof: '2026-01-31' });
    assert.equal(row(bs26, 'Retained Earnings').cells[1], 1570000);
    // Aging by customer survives the move
    const aging = runReport(db, c, 'ar_aging', { asof: '2026-01-31' });
    assert.deepEqual(aging.rows.find((x) => x.cells[0] === 'Acme Co').cells.slice(1), [0, 100000, 0, 0, 0, 100000]);
    assert.equal(aging.rows.find((x) => x.cells[0] === 'Beta LLC').cells[6], 50000);
    assert.equal(aging.rows.at(-1).cells[6], 150000);
    // Can't import twice; undo removes everything
    assert.throws(() => importOpening(db, co.id, body), /already imported/);
    undoImport(db, co.id, r.import_id);
    assert.equal(db.get('SELECT COUNT(*) AS n FROM transactions').n, 0);
    importOpening(db, co.id, body); // allowed again after undo
  });

  test('unmatched trial balance accounts are reported in preview and block the import', () => {
    const body = { date: '2025-12-31', trial_balance: csvFile(TB) };
    const pv = importOpening(db, co.id, { ...body, dryRun: true });
    assert.ok(pv.unmatched.some((u) => u.name === 'Truck:Original Cost'));
    assert.throws(() => importOpening(db, co.id, body), /don't match/);
  });

  test('without aging detail, A/R and A/P go to placeholder names', () => {
    importAccounts(db, co.id, { file: xlsxFile(ACCOUNT_LIST) });
    const r = importOpening(db, co.id, { date: '2025-12-31', trial_balance: csvFile(TB) });
    assert.ok(r.created_customers.includes('Opening A/R (no detail imported)'));
    const c = db.get('SELECT * FROM companies WHERE id = ?', co.id);
    assert.equal(runReport(db, c, 'ar_aging', { asof: '2025-12-31' }).rows.at(-1).cells[6], 150000);
  });
});

describe('bank file layouts', () => {
  const odd = `Account: ****1234
Statement period: 10/01/2026 - 10/31/2026

Txn Date,Details,Out,In,Running Bal
10/03/2026,COFFEE SHOP,4.50,,995.50
10/05/2026,CLIENT PAYMENT,,250.00,1245.50
Ending balance,,,,1245.50
`;
  test('unrecognized headers: preview explains, explicit layout works and is remembered', () => {
    const checking = accts().find((a) => a.name === 'Business Checking').id;
    const p1 = previewStatement(db, co.id, { account_id: checking, ...csvFile(odd) });
    assert.equal(p1.error, null, 'header row and columns are found by pattern');
    assert.deepEqual([p1.layout.header_row, p1.layout.mode, p1.layout.date_col, p1.layout.description_col, p1.layout.debit_col, p1.layout.credit_col], [2, 'split', 0, 1, 2, 3]);
    const strange = 'Col A,Col B,Col C\n10/03/2026,COFFEE,-4.50\n';
    assert.ok(previewStatement(db, co.id, { account_id: checking, ...csvFile(strange) }).error, 'unknown headers need a layout');
    const layout = { header_row: 2, mode: 'split', date_col: 0, description_col: 1, debit_col: 2, credit_col: 3 };
    const p2 = previewStatement(db, co.id, { account_id: checking, ...csvFile(odd), layout });
    assert.equal(p2.error, null);
    assert.equal(p2.count, 2);
    assert.deepEqual(p2.sample.map((t) => t.amount), [-450, 25000]);
    const r = importStatement(db, co.id, { account_id: checking, ...csvFile(odd, 'oct.csv'), layout }, null);
    assert.equal(r.imported, 2);
    assert.equal(getImportSettings(db, checking).mode, 'split');
    const li = lastImport(db, checking);
    assert.equal(li.last_date, '2026-10-05');
    assert.equal(li.file_name, 'oct.csv');
    // Next month: no layout sent, remembered one is used; duplicates are reported in preview
    const p3 = previewStatement(db, co.id, { account_id: checking, ...csvFile(odd) });
    assert.equal(p3.error, null);
    assert.equal(p3.saved_layout, true);
    assert.equal(p3.duplicates, 2);
  });

  test('xlsx bank export with Excel serial dates', () => {
    const card = accts().find((a) => a.name === 'Business Credit Card').id;
    const r = importStatement(db, co.id, { account_id: card, ...xlsxFile([['Transaction Date', 'Description', 'Amount'], [46300, 'FUEL', -40], [46301, 'REFUND', 12.5]]) }, null);
    assert.equal(r.imported, 2);
    assert.deepEqual(db.all('SELECT date, amount FROM bank_feed ORDER BY id').map((x) => [x.date, x.amount]), [['2026-10-05', -4000], ['2026-10-06', 1250]]);
  });
});
