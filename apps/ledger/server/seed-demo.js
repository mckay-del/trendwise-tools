// Seeds a demo company with ~4 months of realistic activity. Safe to re-run: it creates a new company each time.
import { randomBytes } from 'node:crypto';
import { openDb } from './db.js';
import { createUser, needsSetup } from './auth.js';
import { createCompany, saveParty, saveItem, saveTaxRate } from './services/names.js';
import { listAccounts } from './services/accounts.js';
import { createTransaction } from './services/transactions.js';
import { importStatement, saveRule } from './services/banking.js';
import { addDays, today } from './util.js';

const db = openDb();
let creds = null;
if (needsSetup(db)) {
  const password = process.env.LEDGER_ADMIN_PASSWORD || randomBytes(9).toString('base64url');
  createUser(db, { email: process.env.LEDGER_ADMIN_EMAIL || 'admin@example.com', name: 'Administrator', password, role: 'admin' });
  creds = { email: process.env.LEDGER_ADMIN_EMAIL || 'admin@example.com', password };
}

const co = createCompany(db, { name: 'Desert Bloom Landscaping (Demo)', legal_name: 'Desert Bloom Landscaping LLC', ein: '88-1234567', email: 'office@desertbloom.example', phone: '(702) 555-0142', address: '4120 W Sahara Ave\nLas Vegas, NV 89102' });
const A = Object.fromEntries(listAccounts(db, co.id).map((a) => [a.name, a.id]));
const tax = saveTaxRate(db, co.id, { name: 'Clark County, NV', rate: 8.375 });

const cust = Object.fromEntries(['Summerlin HOA', 'Henderson Dental Group', 'Red Rock Apartments', 'The Martinez Family', 'Paradise Office Park'].map((n, i) =>
  [n, saveParty(db, co.id, 'customers', { display_name: n, email: `ap@${n.toLowerCase().replace(/[^a-z]/g, '')}.example`, terms_days: [30, 15, 30, 0, 45][i], billing_address: `${1000 + i * 37} Example Blvd\nLas Vegas, NV 891${10 + i}` }).id]));
const vend = {
  nursery: saveParty(db, co.id, 'vendors', { display_name: 'Mojave Nursery Supply', terms_days: 30, default_account_id: A['Cost of Goods Sold'] }).id,
  crew: saveParty(db, co.id, 'vendors', { display_name: 'J. Ortega (subcontractor)', is_1099: true, tax_id: 'XXX-XX-4821', default_account_id: A['Subcontractors'] }).id,
  irrigation: saveParty(db, co.id, 'vendors', { display_name: 'Vegas Irrigation Co', is_1099: true, tax_id: '84-4455667', terms_days: 15, default_account_id: A['Subcontractors'] }).id,
  nvenergy: saveParty(db, co.id, 'vendors', { display_name: 'NV Energy', default_account_id: A['Utilities'] }).id,
  shell: saveParty(db, co.id, 'vendors', { display_name: 'Shell', default_account_id: A['Car & Truck'] }).id,
  landlord: saveParty(db, co.id, 'vendors', { display_name: 'Sahara Commercial Properties', default_account_id: A['Rent & Lease'] }).id,
  insurer: saveParty(db, co.id, 'vendors', { display_name: 'Silver State Insurance', default_account_id: A['Insurance'] }).id,
};
const items = {
  maint: saveItem(db, co.id, { name: 'Monthly Maintenance', description: 'Monthly landscape maintenance service', sales_price: 650, income_account_id: A['Services Revenue'] }).id,
  design: saveItem(db, co.id, { name: 'Landscape Design', description: 'Design consultation (per hour)', sales_price: 125, income_account_id: A['Services Revenue'] }).id,
  install: saveItem(db, co.id, { name: 'Installation Labor', description: 'Installation labor (per hour)', sales_price: 85, income_account_id: A['Services Revenue'] }).id,
  plants: saveItem(db, co.id, { name: 'Plants & Materials', description: 'Desert-adapted plants and materials', sales_price: 0, income_account_id: A['Product Sales'], expense_account_id: A['Cost of Goods Sold'], taxable: true }).id,
};

const t0 = addDays(today(), -120);
const d = (n) => addDays(t0, n);
const T = (body) => createTransaction(db, co.id, body);

T({ type: 'journal_entry', date: d(0), memo: 'Opening balances', lines: [
  { account_id: A['Business Checking'], debit: 18500 }, { account_id: A['Furniture & Equipment'], debit: 24000 },
  { account_id: A['Notes Payable'], credit: 15000 }, { account_id: A['Opening Balance Equity'], credit: 27500 },
] });

const invoices = [];
for (let m = 0; m < 4; m++) {
  for (const [name, qty] of [['Summerlin HOA', 4], ['Red Rock Apartments', 3], ['Paradise Office Park', 2]]) {
    invoices.push(T({ type: 'invoice', date: d(m * 30 + 2), customer_id: cust[name], lines: [{ item_id: items.maint, qty, rate: 650 }] }));
  }
}
const proj = T({ type: 'invoice', date: d(40), customer_id: cust['Henderson Dental Group'], tax_rate_id: tax.id, memo: 'Front entry xeriscape conversion', lines: [
  { item_id: items.design, qty: 6, rate: 125 }, { item_id: items.install, qty: 42, rate: 85 }, { item_id: items.plants, qty: 1, rate: 3860, taxable: true },
] });
T({ type: 'sales_receipt', date: d(55), customer_id: cust['The Martinez Family'], account_id: A['Business Checking'], tax_rate_id: tax.id, lines: [{ item_id: items.design, qty: 2, rate: 125 }, { item_id: items.plants, qty: 1, rate: 420, taxable: true }] });

// Customers pay most invoices; leave recent and one overdue open.
const payments = [];
for (const inv of invoices.slice(0, -4)) {
  if (inv.customer_id === cust['Paradise Office Park'] && inv.date > d(50)) continue;
  payments.push(T({ type: 'payment', date: addDays(inv.date, 12 + (inv.id % 9)), customer_id: inv.customer_id, total: inv.total / 100, applications: [{ target_txn_id: inv.id, amount: inv.total / 100 }] }));
}
payments.push(T({ type: 'payment', date: d(70), customer_id: cust['Henderson Dental Group'], total: 4000, applications: [{ target_txn_id: proj.id, amount: 4000 }] }));
// Deposit all but the last three payments.
const toDeposit = payments.filter((p) => p.date <= addDays(today(), -30)).sort((a, b) => a.date.localeCompare(b.date));
for (let i = 0; i < toDeposit.length; i += 3) {
  const batch = toDeposit.slice(i, i + 3);
  T({ type: 'deposit', date: addDays(batch.at(-1).date, 1), account_id: A['Business Checking'], lines: batch.map((p) => ({ linked_txn_id: p.id })) });
}

for (let m = 0; m < 4; m++) {
  T({ type: 'check', number: String(1040 + m), date: d(m * 30 + 1), vendor_id: vend.landlord, account_id: A['Business Checking'], lines: [{ account_id: A['Rent & Lease'], amount: 1850 }] });
  T({ type: 'expense', date: d(m * 30 + 12), vendor_id: vend.nvenergy, account_id: A['Business Checking'], lines: [{ account_id: A['Utilities'], amount: 210 + m * 35 }] });
  for (let w = 0; w < 4; w++) T({ type: 'expense', date: d(m * 30 + w * 7 + 3), vendor_id: vend.shell, account_id: A['Business Credit Card'], lines: [{ account_id: A['Car & Truck'], amount: 84 + ((m + w) % 3) * 11.5 }] });
  const b = T({ type: 'bill', date: d(m * 30 + 6), vendor_id: vend.nursery, number: `MNS-${5521 + m}`, lines: [{ account_id: A['Cost of Goods Sold'], amount: 900 + m * 140, description: 'Plants, mulch, drip line' }] });
  if (m < 3) T({ type: 'bill_payment', date: addDays(b.date, 25), vendor_id: vend.nursery, account_id: A['Business Checking'], total: b.total / 100, applications: [{ target_txn_id: b.id, amount: b.total / 100 }] });
  T({ type: 'check', number: String(2100 + m), date: d(m * 30 + 15), vendor_id: vend.crew, account_id: A['Business Checking'], lines: [{ account_id: A['Subcontractors'], amount: 1200 }] });
}
const irr = T({ type: 'bill', date: d(45), vendor_id: vend.irrigation, number: 'VI-889', lines: [{ account_id: A['Subcontractors'], amount: 2350, customer_id: cust['Henderson Dental Group'], description: 'Drip system install — Henderson Dental' }] });
T({ type: 'bill_payment', date: d(62), vendor_id: vend.irrigation, account_id: A['Business Checking'], total: 2350, applications: [{ target_txn_id: irr.id, amount: 2350 }] });
T({ type: 'bill', date: d(95), vendor_id: vend.insurer, number: 'POL-2291', lines: [{ account_id: A['Insurance'], amount: 1420, description: 'General liability — quarterly' }] });
T({ type: 'transfer', date: d(80), account_id: A['Business Checking'], to_account_id: A['Business Credit Card'], total: 900, memo: 'Card payment' });

// A bank statement export waiting in the feed, plus rules.
saveRule(db, co.id, { name: 'Shell fuel', match_text: 'SHELL OIL', direction: 'out', account_id: A['Car & Truck'], vendor_id: vend.shell });
saveRule(db, co.id, { name: 'Software subscriptions', match_text: 'ADOBE', direction: 'out', account_id: A['Office Supplies & Software'] });
saveRule(db, co.id, { name: 'Bank fees', match_text: 'SERVICE FEE', direction: 'out', account_id: A['Bank Charges & Fees'], auto_add: true });
const fmt = (iso) => { const [y, mm, dd] = iso.split('-'); return `${mm}/${dd}/${y}`; };
const recent = [
  [-9, 'ADOBE *CREATIVE CLD 800-833-6687 CA', -59.99], [-8, 'NV ENERGY PAYMENT', -318.0], [-7, 'HOME DEPOT #3302 LAS VEGAS NV', -146.32],
  [-6, 'MOBILE DEPOSIT', 2600.0], [-4, 'MONTHLY SERVICE FEE', -15.0], [-3, `CHECK ${2103}`, -1200.0], [-2, 'ZELLE FROM MARTINEZ R', 350.0],
];
importStatement(db, co.id, { account_id: A['Business Checking'], content: 'Date,Description,Amount\n' + recent.map(([n, desc, amt]) => `${fmt(addDays(today(), n))},"${desc}",${amt.toFixed(2)}`).join('\n') });
importStatement(db, co.id, { account_id: A['Business Credit Card'], content: 'Date,Description,Amount\n' + [[-5, 'SHELL OIL 57442 LAS VEGAS', -91.4], [-3, 'LOWES #1890', -233.18], [-1, 'GOOGLE *WORKSPACE', -14.4]].map(([n, desc, amt]) => `${fmt(addDays(today(), n))},"${desc}",${amt.toFixed(2)}`).join('\n') });

db.close();
console.log(`Demo company "${co.name}" created (id ${co.id}).`);
if (creds) console.log(`Admin login created → email: ${creds.email}  password: ${creds.password}`);
