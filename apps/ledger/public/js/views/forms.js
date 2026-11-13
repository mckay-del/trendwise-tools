import { html, raw, esc, money, num, parseMoney, fmtDate, today, addDays, on, $, $$, options, field, toast, modal, confirmDialog, badge, dataTable } from '../ui.js';
import { editParty } from './lists.js';

const ITEM_TYPES = ['invoice', 'sales_receipt', 'credit_memo'];
const CATEGORY_TYPES = ['bill', 'vendor_credit', 'expense', 'check'];
const APPLY = { payment: 'invoice', credit_memo: 'invoice', bill_payment: 'bill', vendor_credit: 'bill' };
const ACCOUNT_FIELD = {
  payment: ['Deposit to', ['bank', 'other_current_asset']],
  sales_receipt: ['Deposit to', ['bank', 'other_current_asset']],
  deposit: ['Account', ['bank', 'other_current_asset']],
  bill_payment: ['Payment account', ['bank', 'credit_card']],
  expense: ['Payment account', ['bank', 'credit_card', 'other_current_asset']],
  check: ['Bank account', ['bank']],
};
const NUMBER_LABEL = { invoice: 'Invoice no.', sales_receipt: 'Sales receipt no.', credit_memo: 'Credit memo no.', bill: 'Bill no.', check: 'Check no.', journal_entry: 'Journal no.', vendor_credit: 'Ref no.' };
const BACK = { invoice: 'invoices', sales_receipt: 'sales', credit_memo: 'sales', payment: 'sales', bill: 'bills', bill_payment: 'expenses', vendor_credit: 'expenses', expense: 'expenses', check: 'expenses', deposit: 'transactions', transfer: 'transactions', journal_entry: 'transactions' };

const acctLabel = (a) => `${a.number ? a.number + ' ' : ''}${a.name}`;
const acctOptions = (accounts, sel, types, blank = 'Choose an account') => options(types ? accounts.filter((a) => types.includes(a.type)) : accounts, sel, { blank, label: acctLabel, group: (a) => a.type_label });
const partyOptions = (list, sel, label) => options(list, sel, { blank: `Choose a ${label}`, label: (p) => p.display_name }) + html`<option value="__new">＋ Add new ${label}</option>`;

export async function view(ctx) {
  const capi = ctx.capi;
  const isNew = !!ctx.params.type;
  const txn = isNew ? null : await capi.get(`/transactions/${ctx.params.id}`);
  const type = isNew ? ctx.params.type : txn.type;
  const def = ctx.meta.txn_types[type];
  if (!def) throw new Error('Unknown transaction type');
  const [accounts, customers, vendors, items, taxRates] = await Promise.all([capi.accounts(), capi.customers(), capi.vendors(), capi.items(), capi.taxRates()]);
  const L = { accounts, customers, vendors, items, taxRates };
  const t = txn ?? defaults(ctx, type, L);
  const locked = t.status === 'voided';
  const closed = ctx.company.closing_date && t.date <= ctx.company.closing_date && !isNew;
  ctx.setTitle(isNew ? `New ${def.label.toLowerCase()}` : `${def.label} ${t.number ?? ''}`);

  ctx.el.innerHTML = html`<form class="page txn-form txn-${type}" data-form="txn" novalidate>
    <div class="page-head">
      <h1>${def.label} ${t.number && !isNew ? `#${t.number}` : ''} ${!isNew ? raw(badge(t.deposit_status ?? t.status_label)) : ''}</h1>
      ${!isNew && (type === 'invoice' || type === 'bill') ? raw(html`<div class="balance-due"><small>Balance due</small><b>${money(t.balance)}</b></div>`) : ''}
    </div>
    ${locked ? raw('<div class="banner banner-muted">This transaction was voided. It has no effect on your books.</div>') : ''}
    ${closed ? raw(html`<div class="banner banner-warn">This transaction is dated on or before the closing date (${ctx.company.closing_date}) and can't be changed.</div>`) : ''}
    ${t.journal?.some((j) => j.cleared === 'R') ? raw('<div class="banner banner-info">This transaction has been reconciled. Undo the reconciliation to change it.</div>') : ''}
    ${t.applied_by?.length ? raw(html`<div class="banner banner-info">Applied: ${raw(t.applied_by.map((a) => html`<a href="${ctx.chref('txn/' + a.source_txn_id)}">${ctx.meta.txn_types[a.type].label} ${a.number ?? ''} (${fmtDate(a.date)}) ${money(a.amount)}</a>`).join(', '))}</div>`) : ''}
    <section class="card header-fields"><div class="form-grid cols-4">${raw(headerFields(ctx, type, t, L))}</div></section>
    <div data-section="apply"></div>
    <div data-section="deposit"></div>
    ${def.lines && def.lines !== 'deposit' ? raw(html`<section class="card"><h3>${type === 'journal_entry' ? 'Lines' : ITEM_TYPES.includes(type) ? 'Products and services' : 'Category details'}</h3><div data-section="lines"></div>
      <div class="btn-row"><button type="button" class="btn btn-small" data-action="add-line">Add lines</button><button type="button" class="btn btn-small btn-ghost" data-action="clear-lines">Clear all lines</button></div></section>`) : ''}
    ${type === 'deposit' ? raw(html`<section class="card"><h3>Add funds to this deposit</h3><div data-section="lines"></div><div class="btn-row"><button type="button" class="btn btn-small" data-action="add-line">Add lines</button></div></section>`) : ''}
    <section class="card footer-fields">
      <div class="form-grid">${raw(field(type === 'invoice' ? 'Message on invoice' : 'Memo', html`<textarea name="memo" rows="2">${t.memo ?? ''}</textarea>`, { cls: 'span-2' }))}</div>
      <div class="totals" data-section="totals"></div>
    </section>
    <div class="form-error" hidden></div>
    <div class="action-bar">
      <a class="btn btn-ghost" href="${ctx.chref(BACK[type])}">Cancel</a>
      ${!isNew ? raw(html`<button type="button" class="btn btn-ghost" data-action="journal">Transaction journal</button>`) : ''}
      ${!isNew && ['invoice', 'sales_receipt', 'credit_memo'].includes(type) ? raw(html`<a class="btn btn-ghost" target="_blank" rel="noopener" href="${ctx.chref('print/' + t.id)}">Print</a>`) : ''}
      ${!isNew && type === 'invoice' && t.balance > 0 ? raw(html`<a class="btn" href="${ctx.chref('new/payment')}?customer=${t.customer_id}&apply=${t.id}">Receive payment</a>`) : ''}
      ${!isNew && type === 'bill' && t.balance > 0 ? raw(html`<a class="btn" href="${ctx.chref('new/bill_payment')}?vendor=${t.vendor_id}&apply=${t.id}">Make payment</a>`) : ''}
      <span class="spacer"></span>
      ${!isNew && !locked ? raw('<button type="button" class="btn btn-ghost danger" data-action="void">Void</button>') : ''}
      ${!isNew ? raw('<button type="button" class="btn btn-ghost danger" data-action="delete">Delete</button>') : ''}
      ${!locked && !closed ? raw('<button type="submit" class="btn" data-mode="new">Save and new</button><button type="submit" class="btn btn-primary" data-mode="close">Save and close</button>') : ''}
    </div>
  </form>`;

  const form = $('[data-form=txn]', ctx.el);
  if (locked || closed) $$('input,select,textarea', form).forEach((el) => { el.disabled = true; });
  const S = { ctx, type, t, L, form, isNew, locked: locked || closed };

  renderLines(S, t.lines?.length ? t.lines : null);
  if (APPLY[type]) await renderApply(S);
  if (type === 'deposit') await renderDeposit(S);
  recalc(S);
  wire(S);
}

function defaults(ctx, type, L) {
  const q = ctx.query;
  const t = { type, date: today(), lines: [], applications: [] };
  if (q.customer) t.customer_id = Number(q.customer);
  if (q.vendor) t.vendor_id = Number(q.vendor);
  if (q.account) t.account_id = Number(q.account);
  const party = t.customer_id ? L.customers.find((c) => c.id === t.customer_id) : null;
  const terms = party?.terms_days ?? (t.vendor_id ? L.vendors.find((v) => v.id === t.vendor_id)?.terms_days : null) ?? ctx.company.default_terms_days;
  if (type === 'invoice' || type === 'bill') t.due_date = addDays(t.date, terms ?? 30);
  if (party) t.billing_address = party.billing_address;
  if (type === 'check' || type === 'bill_payment' || type === 'expense' || type === 'deposit') {
    t.account_id ??= L.accounts.find((a) => a.type === 'bank')?.id;
  }
  if (type === 'payment' || type === 'sales_receipt') t.account_id ??= L.accounts.find((a) => a.system_key === 'UNDEPOSITED')?.id;
  if (q.apply) t._apply = Number(q.apply);
  return t;
}

function headerFields(ctx, type, t, L) {
  const def = ctx.meta.txn_types[type];
  const out = [];
  if (def.party === 'customer') out.push(field(type === 'sales_receipt' ? 'Customer (optional)' : 'Customer', html`<select name="customer_id" data-party="customers" ${type !== 'sales_receipt' ? raw('required') : ''}>${raw(partyOptions(L.customers, t.customer_id, 'customer'))}</select>`, { cls: 'span-2' }));
  if (def.party === 'vendor') out.push(field(['expense', 'check'].includes(type) ? 'Payee' : 'Vendor', html`<select name="vendor_id" data-party="vendors">${raw(partyOptions(L.vendors, t.vendor_id, 'vendor'))}</select>`, { cls: 'span-2' }));
  if (ACCOUNT_FIELD[type]) {
    const [label, types] = ACCOUNT_FIELD[type];
    const list = L.accounts.filter((a) => types.includes(a.type) && !(type === 'deposit' && a.system_key === 'UNDEPOSITED'));
    out.push(field(label, html`<select name="account_id" required>${raw(acctOptions(list, t.account_id, null))}</select>`, { cls: 'span-2', hint: (() => { const a = L.accounts.find((x) => x.id === t.account_id); return a ? `Balance ${money(a.balance)}` : ''; })() }));
  }
  if (type === 'transfer') {
    const ok = L.accounts.filter((a) => !['income', 'expense'].includes(a.cls) && !['accounts_receivable', 'accounts_payable'].includes(a.type));
    out.push(field('Transfer funds from', html`<select name="account_id" required>${raw(acctOptions(ok, t.account_id, null))}</select>`, { cls: 'span-2' }));
    out.push(field('Transfer funds to', html`<select name="to_account_id" required>${raw(acctOptions(ok, t.to_account_id, null))}</select>`, { cls: 'span-2' }));
    out.push(field('Transfer amount', html`<input name="total" inputmode="decimal" required value="${t.total ? num(t.total) : ''}" class="num">`));
  }
  if (type === 'payment' || type === 'bill_payment') out.push(field(type === 'payment' ? 'Amount received' : 'Amount', html`<input name="total" inputmode="decimal" class="num" value="${t.total ? num(t.total) : ''}" data-total>`));
  out.push(field(type === 'invoice' ? 'Invoice date' : type === 'bill' ? 'Bill date' : type === 'payment' ? 'Payment date' : 'Date', html`<input type="date" name="date" required value="${t.date}">`));
  if (type === 'invoice' || type === 'bill') {
    out.push(field('Terms', html`<select data-terms>${raw(options([0, 10, 15, 30, 45, 60, 90].map((d) => ({ id: d, name: d === 0 ? 'Due on receipt' : `Net ${d}` })), '', { blank: 'Custom' }))}</select>`));
    out.push(field('Due date', html`<input type="date" name="due_date" value="${t.due_date ?? ''}">`));
  }
  if (type !== 'transfer' && type !== 'deposit') out.push(field(NUMBER_LABEL[type] ?? 'Ref no.', html`<input name="number" value="${t.number ?? ''}" placeholder="${def.numbered ? 'Auto' : ''}">`));
  if (ITEM_TYPES.includes(type)) {
    out.push(field('Billing address', html`<textarea name="billing_address" rows="2">${t.billing_address ?? ''}</textarea>`, { cls: 'span-2' }));
    out.push(field('Sales tax', html`<select name="tax_rate_id" data-recalc>${raw(options(L.taxRates.filter((r) => r.is_active || r.id === t.tax_rate_id), t.tax_rate_id, { blank: 'No sales tax', label: (r) => `${r.name} (${r.rate}%)` }))}</select>`));
  }
  return out.join('');
}

// --- Lines -----------------------------------------------------------------

function lineRow(S, l = {}) {
  const { type, L } = S;
  if (ITEM_TYPES.includes(type)) {
    const itemList = L.items.filter((i) => i.income_account_id || i.id === l.item_id);
    return html`<tr data-line>
      <td class="drag">⋮</td>
      <td><select name="item_id" aria-label="Product/service">${raw(options(itemList, l.item_id, { blank: 'Product/service' }))}</select></td>
      <td><input name="description" value="${l.description ?? ''}" aria-label="Description"></td>
      <td><input name="qty" class="num qty" inputmode="decimal" value="${l.qty ?? ''}" aria-label="Quantity"></td>
      <td><input name="rate" class="num" inputmode="decimal" value="${l.rate != null ? num(l.rate) : ''}" aria-label="Rate"></td>
      <td><input name="amount" class="num" inputmode="decimal" value="${l.amount ? num(l.amount) : ''}" aria-label="Amount"></td>
      <td class="center"><input type="checkbox" name="taxable" ${l.taxable ? raw('checked') : ''} aria-label="Taxable"></td>
      <td><button type="button" class="icon-btn" data-action="del-line" aria-label="Delete line">🗑</button></td></tr>`;
  }
  if (CATEGORY_TYPES.includes(type)) {
    const cats = L.accounts.filter((a) => !['accounts_receivable', 'accounts_payable'].includes(a.type));
    return html`<tr data-line>
      <td class="drag">⋮</td>
      <td><select name="account_id" aria-label="Category">${raw(acctOptions(cats, l.account_id, null, 'Category'))}</select></td>
      <td><input name="description" value="${l.description ?? ''}" aria-label="Description"></td>
      <td><input name="amount" class="num" inputmode="decimal" value="${l.amount ? num(l.amount) : ''}" aria-label="Amount"></td>
      <td><select name="customer_id" aria-label="Customer">${raw(options(L.customers, l.customer_id, { blank: '', label: (c) => c.display_name }))}</select></td>
      <td><button type="button" class="icon-btn" data-action="del-line" aria-label="Delete line">🗑</button></td></tr>`;
  }
  if (type === 'journal_entry') {
    const nameVal = l.customer_id ? `c:${l.customer_id}` : l.vendor_id ? `v:${l.vendor_id}` : '';
    const names = [...L.customers.map((c) => ({ id: `c:${c.id}`, name: c.display_name, g: 'Customers' })), ...L.vendors.map((v) => ({ id: `v:${v.id}`, name: v.display_name, g: 'Vendors' }))];
    return html`<tr data-line>
      <td class="drag">⋮</td>
      <td><select name="account_id" aria-label="Account">${raw(acctOptions(L.accounts, l.account_id, null, 'Account'))}</select></td>
      <td><input name="debit" class="num" inputmode="decimal" value="${l.amount > 0 ? num(l.amount) : ''}" aria-label="Debit"></td>
      <td><input name="credit" class="num" inputmode="decimal" value="${l.amount < 0 ? num(-l.amount) : ''}" aria-label="Credit"></td>
      <td><input name="description" value="${l.description ?? ''}" aria-label="Description"></td>
      <td><select name="name" aria-label="Name">${raw(options(names, nameVal, { blank: '', group: (n) => n.g }))}</select></td>
      <td><button type="button" class="icon-btn" data-action="del-line" aria-label="Delete line">🗑</button></td></tr>`;
  }
  if (type === 'deposit') {
    const from = L.accounts.filter((a) => a.system_key !== 'UNDEPOSITED' && a.type !== 'accounts_payable');
    return html`<tr data-line>
      <td class="drag">⋮</td>
      <td><select name="customer_id" aria-label="Received from">${raw(options(L.customers, l.customer_id, { blank: '', label: (c) => c.display_name }))}</select></td>
      <td><select name="account_id" aria-label="Account">${raw(acctOptions(from, l.account_id, null, 'Account'))}</select></td>
      <td><input name="description" value="${l.description ?? ''}" aria-label="Description"></td>
      <td><input name="amount" class="num" inputmode="decimal" value="${l.amount ? num(l.amount) : ''}" aria-label="Amount"></td>
      <td><button type="button" class="icon-btn" data-action="del-line" aria-label="Delete line">🗑</button></td></tr>`;
  }
  return '';
}

function lineHead(type) {
  if (ITEM_TYPES.includes(type)) return '<th></th><th>Product/service</th><th>Description</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Amount</th><th>Tax</th><th></th>';
  if (CATEGORY_TYPES.includes(type)) return '<th></th><th>Category</th><th>Description</th><th class="num">Amount</th><th>Customer (billable)</th><th></th>';
  if (type === 'journal_entry') return '<th></th><th>Account</th><th class="num">Debits</th><th class="num">Credits</th><th>Description</th><th>Name</th><th></th>';
  if (type === 'deposit') return '<th></th><th>Received from</th><th>Account</th><th>Description</th><th class="num">Amount</th><th></th>';
  return '';
}

function renderLines(S, lines) {
  const host = $('[data-section=lines]', S.form);
  if (!host) return;
  const base = (lines ?? []).filter((l) => !l.linked_txn_id);
  const n = Math.max(base.length + (S.locked ? 0 : 1), S.type === 'journal_entry' ? 2 : 2);
  const rows = Array.from({ length: n }, (_, i) => lineRow(S, base[i] ?? {})).join('');
  host.innerHTML = `<div class="table-wrap"><table class="lines"><thead><tr>${lineHead(S.type)}</tr></thead><tbody>${rows}</tbody></table></div>`;
  if (S.locked) $$('input,select', host).forEach((el) => { el.disabled = true; });
}

function addLine(S) {
  $('[data-section=lines] tbody', S.form).insertAdjacentHTML('beforeend', lineRow(S));
}

function readLines(S) {
  return $$('[data-section=lines] tr[data-line]', S.form).map((tr) => {
    const v = (n) => tr.querySelector(`[name=${n}]`)?.value ?? '';
    if (ITEM_TYPES.includes(S.type)) return { item_id: v('item_id') || null, description: v('description'), qty: v('qty'), rate: v('rate'), amount: v('amount').replace(/[$,]/g, ''), taxable: tr.querySelector('[name=taxable]').checked };
    if (CATEGORY_TYPES.includes(S.type)) return { account_id: v('account_id') || null, description: v('description'), amount: v('amount').replace(/[$,]/g, ''), customer_id: v('customer_id') || null };
    if (S.type === 'journal_entry') { const nm = v('name'); return { account_id: v('account_id') || null, debit: v('debit').replace(/[$,]/g, ''), credit: v('credit').replace(/[$,]/g, ''), description: v('description'), customer_id: nm.startsWith('c:') ? nm.slice(2) : null, vendor_id: nm.startsWith('v:') ? nm.slice(2) : null }; }
    if (S.type === 'deposit') return { account_id: v('account_id') || null, customer_id: v('customer_id') || null, description: v('description'), amount: v('amount').replace(/[$,]/g, '') };
    return {};
  });
}

// --- Apply payments / credits -----------------------------------------------

async function renderApply(S) {
  const host = $('[data-section=apply]', S.form);
  const docType = APPLY[S.type];
  const partyField = docType === 'invoice' ? 'customer_id' : 'vendor_id';
  const partyId = S.form[partyField]?.value;
  if (!partyId || partyId === '__new') { host.innerHTML = S.type === 'payment' || S.type === 'bill_payment' ? html`<section class="card"><p class="muted">Choose a ${docType === 'invoice' ? 'customer' : 'vendor'} to see open ${docType}s.</p></section>` : ''; return; }
  const docs = await S.ctx.capi.get('/open-documents', { type: docType, [partyField]: partyId, exclude: S.t.id });
  const applied = new Map((S.t.applications ?? []).map((a) => [a.target_txn_id, a.amount]));
  if (S.t._apply && !applied.size) {
    const d = docs.find((x) => x.id === S.t._apply);
    if (d) { applied.set(d.id, d.open_balance); if (S.form.total && !S.form.total.value) S.form.total.value = num(d.open_balance); }
  }
  const label = docType === 'invoice' ? 'Invoice' : 'Bill';
  host.innerHTML = html`<section class="card"><h3>${S.type === 'credit_memo' || S.type === 'vendor_credit' ? `Apply this credit to open ${docType}s` : `Outstanding ${docType}s`}</h3>
    ${docs.length ? raw(html`<div class="table-wrap"><table class="grid apply"><thead><tr><th><input type="checkbox" data-apply-all aria-label="Select all"></th><th>Description</th><th>Due date</th><th class="num">Original amount</th><th class="num">Open balance</th><th class="num">Payment</th></tr></thead><tbody>
      ${raw(docs.map((d) => { const amt = applied.get(d.id) ?? 0; return html`<tr data-doc="${d.id}" data-open="${d.open_balance}">
        <td><input type="checkbox" data-apply-check ${amt ? raw('checked') : ''} aria-label="Apply to ${label} ${d.number ?? ''}"></td>
        <td><a href="${S.ctx.chref('txn/' + d.id)}">${label} ${d.number ?? ''}</a> <small class="muted">(${fmtDate(d.date)})</small></td>
        <td>${fmtDate(d.due_date)}</td><td class="num">${money(d.total)}</td><td class="num">${money(d.open_balance)}</td>
        <td><input class="num" data-apply-amt inputmode="decimal" value="${amt ? num(amt) : ''}" aria-label="Amount applied"></td></tr>`; }).join(''))}
    </tbody></table></div>`) : raw(html`<p class="muted">No open ${docType}s.</p>`)}
  </section>`;
  if (S.locked) $$('input', host).forEach((el) => { el.disabled = true; });
}

function readApplications(S) {
  return $$('[data-section=apply] tr[data-doc]', S.form).map((tr) => ({ target_txn_id: Number(tr.dataset.doc), amount: tr.querySelector('[data-apply-amt]').value.replace(/[$,]/g, '') })).filter((a) => parseMoney(a.amount) > 0);
}

function distribute(S) {
  let left = parseMoney(S.form.total.value);
  if (!Number.isFinite(left)) return;
  for (const tr of $$('[data-section=apply] tr[data-doc]', S.form)) {
    const open = Number(tr.dataset.open);
    const amt = Math.max(0, Math.min(open, left));
    left -= amt;
    tr.querySelector('[data-apply-amt]').value = amt ? num(amt) : '';
    tr.querySelector('[data-apply-check]').checked = amt > 0;
  }
}

// --- Deposits -----------------------------------------------------------------

async function renderDeposit(S) {
  const host = $('[data-section=deposit]', S.form);
  const funds = await S.ctx.capi.get('/undeposited', { exclude: S.t.id });
  const linked = new Set((S.t.lines ?? []).filter((l) => l.linked_txn_id).map((l) => l.linked_txn_id));
  host.innerHTML = html`<section class="card"><h3>Select the payments included in this deposit</h3>
    ${funds.length ? raw(html`<div class="table-wrap"><table class="grid"><thead><tr><th><input type="checkbox" data-dep-all aria-label="Select all"></th><th>Received from</th><th>Date</th><th>Type</th><th>Ref no.</th><th class="num">Amount</th></tr></thead><tbody>
      ${raw(funds.map((f) => html`<tr><td><input type="checkbox" data-dep="${f.id}" data-amt="${f.total}" ${linked.has(f.id) ? raw('checked') : ''} aria-label="Include payment"></td><td>${f.customer_name}</td><td>${fmtDate(f.date)}</td><td>${S.ctx.meta.txn_types[f.type].label}</td><td>${f.number ?? ''}</td><td class="num">${money(f.total)}</td></tr>`).join(''))}
    </tbody></table></div>`) : raw('<p class="muted">There are no payments waiting in Undeposited Funds.</p>')}</section>`;
  if (S.locked) $$('input', host).forEach((el) => { el.disabled = true; });
}

// --- Totals -------------------------------------------------------------------

function recalc(S) {
  const host = $('[data-section=totals]', S.form);
  const { type, form, L } = S;
  if (ITEM_TYPES.includes(type)) {
    let sub = 0, taxable = 0;
    for (const l of readLines(S)) { const a = parseMoney(l.amount) || 0; sub += a; if (l.taxable) taxable += a; }
    const rate = L.taxRates.find((r) => String(r.id) === form.tax_rate_id?.value);
    const tax = rate ? Math.round(taxable * rate.rate / 100) : 0;
    host.innerHTML = html`<div class="kv"><span>Subtotal</span><b>${money(sub)}</b></div>${rate ? raw(html`<div class="kv"><span>${rate.name} (${rate.rate}%) on ${money(taxable)}</span><b>${money(tax)}</b></div>`) : ''}<div class="kv total"><span>Total</span><b>${money(sub + tax)}</b></div>${!S.isNew && type === 'invoice' ? raw(html`<div class="kv"><span>Balance due</span><b>${money(S.t.balance)}</b></div>`) : ''}`;
  } else if (CATEGORY_TYPES.includes(type)) {
    const tot = readLines(S).reduce((s, l) => s + (parseMoney(l.amount) || 0), 0);
    const credit = type === 'vendor_credit' ? readApplications(S).reduce((s, a) => s + parseMoney(a.amount), 0) : null;
    host.innerHTML = html`<div class="kv total"><span>Total</span><b>${money(tot)}</b></div>${credit !== null ? raw(html`<div class="kv"><span>Applied</span><b>${money(credit)}</b></div><div class="kv"><span>Remaining credit</span><b>${money(tot - credit)}</b></div>`) : ''}`;
  } else if (type === 'journal_entry') {
    let d = 0, c = 0;
    for (const l of readLines(S)) { d += parseMoney(l.debit) || 0; c += parseMoney(l.credit) || 0; }
    host.innerHTML = html`<div class="kv"><span>Total debits</span><b>${money(d)}</b></div><div class="kv"><span>Total credits</span><b>${money(c)}</b></div><div class="kv total ${d !== c ? 'bad' : ''}"><span>${d === c ? 'Balanced' : 'Out of balance by'}</span><b>${d === c ? '✓' : money(Math.abs(d - c))}</b></div>`;
  } else if (type === 'deposit') {
    const linked = $$('[data-dep]:checked', S.form).reduce((s, el) => s + Number(el.dataset.amt), 0);
    const other = readLines(S).reduce((s, l) => s + (parseMoney(l.amount) || 0), 0);
    host.innerHTML = html`<div class="kv"><span>Selected payments</span><b>${money(linked)}</b></div><div class="kv"><span>Other funds</span><b>${money(other)}</b></div><div class="kv total"><span>Deposit total</span><b>${money(linked + other)}</b></div>`;
  } else if (type === 'payment' || type === 'bill_payment') {
    const amt = parseMoney(form.total.value) || 0;
    const applied = readApplications(S).reduce((s, a) => s + parseMoney(a.amount), 0);
    host.innerHTML = html`<div class="kv"><span>Amount to apply</span><b>${money(applied)}</b></div><div class="kv total ${applied > amt ? 'bad' : ''}"><span>${applied > amt ? 'Applied exceeds amount by' : 'Amount to credit'}</span><b>${money(Math.abs(amt - applied))}</b></div>`;
  } else if (type === 'transfer') {
    host.innerHTML = '';
  }
  if (type === 'credit_memo') {
    const applied = readApplications(S).reduce((s, a) => s + parseMoney(a.amount), 0);
    if (applied) host.insertAdjacentHTML('beforeend', html`<div class="kv"><span>Applied to invoices</span><b>${money(applied)}</b></div>`);
  }
}

// --- Events -------------------------------------------------------------------

function wire(S) {
  const { form, ctx, type, L } = S;
  let saveMode = 'close';

  on(form, 'click', '[type=submit]', (e, b) => { saveMode = b.dataset.mode; });
  on(form, 'click', '[data-action=add-line]', () => addLine(S));
  on(form, 'click', '[data-action=clear-lines]', () => { renderLines(S, []); recalc(S); });
  on(form, 'click', '[data-action=del-line]', (e, b) => {
    const tr = b.closest('tr');
    if ($$('tr[data-line]', tr.parentElement).length > 1) tr.remove(); else renderLines(S, []);
    recalc(S);
  });

  // Quick-add customer/vendor, refresh dependent sections
  on(form, 'change', '[data-party]', async (e, sel) => {
    const table = sel.dataset.party;
    if (sel.value === '__new') {
      const created = await editParty(ctx, table, {});
      const list = table === 'customers' ? (L.customers = await ctx.capi.customers()) : (L.vendors = await ctx.capi.vendors());
      sel.innerHTML = partyOptions(list, created.id, table === 'customers' ? 'customer' : 'vendor');
    }
    const p = (table === 'customers' ? L.customers : L.vendors).find((x) => String(x.id) === sel.value);
    if (p && form.billing_address && table === 'customers') form.billing_address.value = p.billing_address ?? '';
    if (p && form.due_date && p.terms_days != null) form.due_date.value = addDays(form.date.value, p.terms_days);
    if (p && table === 'vendors' && p.default_account_id && CATEGORY_TYPES.includes(type)) {
      const first = $('[data-section=lines] [name=account_id]', form);
      if (first && !first.value) first.value = String(p.default_account_id);
    }
    if (APPLY[type]) { S.t.applications = []; S.t._apply = null; await renderApply(S); if (form.total) distribute(S); recalc(S); }
  });

  on(form, 'change', '[data-terms]', (e, sel) => { if (sel.value !== '') form.due_date.value = addDays(form.date.value, Number(sel.value)); });
  on(form, 'change', '[name=date]', () => { const ts = $('[data-terms]', form); if (ts?.value) form.due_date.value = addDays(form.date.value, Number(ts.value)); });

  // Item lines: product fills description/rate; qty × rate = amount
  on(form, 'change', '[data-section=lines] [name=item_id]', (e, sel) => {
    const tr = sel.closest('tr');
    const it = L.items.find((i) => String(i.id) === sel.value);
    if (it) {
      tr.querySelector('[name=description]').value = it.description ?? '';
      tr.querySelector('[name=rate]').value = num(it.sales_price);
      if (!tr.querySelector('[name=qty]').value) tr.querySelector('[name=qty]').value = '1';
      tr.querySelector('[name=taxable]').checked = !!it.taxable;
      lineMath(tr, 'rate');
    }
    if (tr === tr.parentElement.lastElementChild) addLine(S);
    recalc(S);
  });
  on(form, 'change', '[data-section=lines] [name=account_id]', (e, sel) => { const tr = sel.closest('tr'); if (tr === tr.parentElement.lastElementChild && sel.value) addLine(S); });
  on(form, 'input', '[data-section=lines] input', (e, inp) => {
    if (ITEM_TYPES.includes(type)) lineMath(inp.closest('tr'), inp.name);
    if (type === 'journal_entry' && inp.value) { const other = inp.closest('tr').querySelector(`[name=${inp.name === 'debit' ? 'credit' : 'debit'}]`); if (other) other.value = ''; }
    recalc(S);
  });
  on(form, 'change', '[data-section=lines] [name=taxable], [data-recalc]', () => recalc(S));
  // Journal entries: pre-fill the balancing amount on a new line
  on(form, 'focusin', '[data-section=lines] [name=debit], [data-section=lines] [name=credit]', (e, inp) => {
    if (type !== 'journal_entry') return;
    const tr = inp.closest('tr');
    if (tr.querySelector('[name=debit]').value || tr.querySelector('[name=credit]').value) return;
    let d = 0, c = 0;
    for (const l of readLines(S)) { d += parseMoney(l.debit) || 0; c += parseMoney(l.credit) || 0; }
    if (inp.name === 'debit' && c > d) inp.value = num(c - d);
    if (inp.name === 'credit' && d > c) inp.value = num(d - c);
    recalc(S);
  });

  // Applications
  on(form, 'input', '[data-total]', () => { distribute(S); recalc(S); });
  on(form, 'change', '[data-apply-check]', (e, cb) => {
    const tr = cb.closest('tr');
    const inp = tr.querySelector('[data-apply-amt]');
    if (cb.checked) {
      let room = Number(tr.dataset.open);
      if (type === 'credit_memo' || type === 'vendor_credit') {
        const total = readLines(S).reduce((s, l) => s + (parseMoney(l.amount) || 0), 0);
        const used = readApplications(S).reduce((s, a) => s + parseMoney(a.amount), 0);
        room = Math.min(room, Math.max(0, total - used));
      }
      inp.value = num(room);
    } else inp.value = '';
    syncPaymentTotal(S); recalc(S);
  });
  on(form, 'change', '[data-apply-all]', (e, cb) => { $$('[data-apply-check]', form).forEach((c) => { if (c.checked !== cb.checked) { c.checked = cb.checked; c.dispatchEvent(new Event('change', { bubbles: true })); } }); });
  on(form, 'input', '[data-apply-amt]', (e, inp) => { inp.closest('tr').querySelector('[data-apply-check]').checked = parseMoney(inp.value) > 0; syncPaymentTotal(S); recalc(S); });

  // Deposits
  on(form, 'change', '[data-dep], [data-dep-all]', (e, cb) => { if (cb.matches('[data-dep-all]')) $$('[data-dep]', form).forEach((c) => { c.checked = cb.checked; }); recalc(S); });

  // Save
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('.form-error', form);
    err.hidden = true;
    const body = collect(S);
    $$('.action-bar button', form).forEach((b) => { b.disabled = true; });
    try {
      const saved = S.isNew ? await ctx.capi.post('/transactions', body) : await ctx.capi.put(`/transactions/${S.t.id}`, body);
      toast(`${ctx.meta.txn_types[type].label} ${saved.number ?? ''} saved`);
      if (saveMode === 'new') { if (S.isNew) ctx.reload(); else ctx.navigate(ctx.cpath('new/' + type)); }
      else if (history.length > 1 && S.isNew && ctx.query.apply) history.back();
      else ctx.navigate(ctx.cpath(BACK[type]));
    } catch (ex) {
      err.textContent = ex.message; err.hidden = false;
      err.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } finally { $$('.action-bar button', form).forEach((b) => { b.disabled = false; }); }
  });

  on(form, 'click', '[data-action=delete]', async () => {
    if (!(await confirmDialog(`Delete this ${ctx.meta.txn_types[type].label.toLowerCase()}? This can't be undone. Consider voiding instead to keep a record.`, { okLabel: 'Delete' }))) return;
    try { await ctx.capi.del(`/transactions/${S.t.id}`); toast('Deleted'); ctx.navigate(ctx.cpath(BACK[type])); } catch (ex) { toast(ex.message, 'error'); }
  });
  on(form, 'click', '[data-action=void]', async () => {
    if (!(await confirmDialog(`Void this ${ctx.meta.txn_types[type].label.toLowerCase()}? Amounts are set to zero but the record is kept.`, { okLabel: 'Void' }))) return;
    try { await ctx.capi.post(`/transactions/${S.t.id}/void`); toast('Voided'); ctx.reload(); } catch (ex) { toast(ex.message, 'error'); }
  });
  on(form, 'click', '[data-action=journal]', () => modal({
    title: 'Transaction journal', wide: true,
    body: dataTable(S.t.journal, [
      { key: 'date', label: 'Date', type: 'date' },
      { key: 'account_name', label: 'Account', render: (j) => esc(`${j.account_number ? j.account_number + ' ' : ''}${j.account_name}`) },
      { key: 'memo', label: 'Memo' },
      { key: 'debit', label: 'Debit', type: 'money', render: (j) => esc(money(j.debit, { blankZero: true })) },
      { key: 'credit', label: 'Credit', type: 'money', render: (j) => esc(money(j.credit, { blankZero: true })) },
      { key: 'cleared', label: 'Cleared' },
    ], { empty: 'No postings (voided).' }),
  }));
}

function syncPaymentTotal(S) {
  if (!(S.type === 'payment' || S.type === 'bill_payment')) return;
  const applied = readApplications(S).reduce((s, a) => s + parseMoney(a.amount), 0);
  const cur = parseMoney(S.form.total.value) || 0;
  if (applied > cur) S.form.total.value = num(applied);
}

function lineMath(tr, changed) {
  const q = tr.querySelector('[name=qty]'), r = tr.querySelector('[name=rate]'), a = tr.querySelector('[name=amount]');
  const qty = Number(q.value), rate = parseMoney(r.value), amt = parseMoney(a.value);
  if ((changed === 'qty' || changed === 'rate') && q.value !== '' && r.value !== '' && Number.isFinite(qty) && Number.isFinite(rate)) a.value = num(Math.round(qty * rate));
  if (changed === 'amount' && Number.isFinite(amt)) { if (q.value && qty) r.value = num(Math.round(amt / qty)); else { q.value = ''; r.value = ''; } }
}

function collect(S) {
  const f = S.form;
  const v = (n) => f[n]?.value ?? undefined;
  const body = { type: S.type, date: v('date'), number: v('number'), memo: v('memo') };
  for (const k of ['customer_id', 'vendor_id', 'account_id', 'to_account_id', 'due_date', 'billing_address', 'tax_rate_id', 'total']) {
    const val = v(k);
    if (val !== undefined) body[k] = val === '__new' ? '' : val;
  }
  if (S.ctx.meta.txn_types[S.type].lines) body.lines = readLines(S);
  if (S.type === 'deposit') {
    body.lines = [...$$('[data-dep]:checked', f).map((cb) => ({ linked_txn_id: Number(cb.dataset.dep) })), ...readLines(S)];
  }
  if (APPLY[S.type]) body.applications = readApplications(S);
  return body;
}

// --- Print view -----------------------------------------------------------------

export async function print(ctx) {
  const t = await ctx.capi.get(`/transactions/${ctx.params.id}`);
  const c = ctx.company;
  const def = ctx.meta.txn_types[t.type];
  const tax = t.tax_rate_id ? (await ctx.capi.taxRates()).find((r) => r.id === t.tax_rate_id) : null;
  document.title = `${def.label} ${t.number ?? ''} · ${c.name}`;
  ctx.el.innerHTML = html`<div class="print-page">
    <div class="no-print print-actions"><button class="btn btn-primary" data-action="print">Print / Save as PDF</button> <a class="btn" href="${ctx.chref('txn/' + t.id)}">Back</a></div>
    <header class="print-head">
      <div><h1>${c.legal_name ?? c.name}</h1><div class="pre">${c.address ?? ''}</div><div>${c.phone ?? ''} ${c.email ?? ''}</div></div>
      <div class="print-title"><h2>${def.label.toUpperCase()}</h2><table><tr><th>No.</th><td>${t.number ?? ''}</td></tr><tr><th>Date</th><td>${fmtDate(t.date)}</td></tr>${t.due_date ? raw(html`<tr><th>Due</th><td>${fmtDate(t.due_date)}</td></tr>`) : ''}</table></div>
    </header>
    <section class="bill-to"><h4>Bill to</h4><strong>${t.customer_name ?? ''}</strong><div class="pre">${t.billing_address ?? ''}</div></section>
    <table class="print-lines"><thead><tr><th>Product/service</th><th>Description</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead>
      <tbody>${raw(t.lines.map((l) => html`<tr><td>${l.item_name ?? l.account_name ?? ''}</td><td class="pre">${l.description ?? ''}</td><td class="num">${l.qty ?? ''}</td><td class="num">${l.rate != null ? money(l.rate) : ''}</td><td class="num">${money(l.amount)}</td></tr>`).join(''))}</tbody></table>
    <div class="print-totals">
      <div class="kv"><span>Subtotal</span><b>${money(t.subtotal)}</b></div>
      ${tax ? raw(html`<div class="kv"><span>${tax.name} (${tax.rate}%)</span><b>${money(t.tax_amount)}</b></div>`) : ''}
      <div class="kv total"><span>Total</span><b>${money(t.total)}</b></div>
      ${t.type === 'invoice' ? raw(html`<div class="kv"><span>Payments/credits</span><b>${money(t.total - t.balance)}</b></div><div class="kv total"><span>Balance due</span><b>${money(t.balance)}</b></div>`) : ''}
    </div>
    ${t.memo ? raw(html`<p class="pre memo">${t.memo}</p>`) : ''}
    ${c.invoice_footer ? raw(html`<footer class="pre">${c.invoice_footer}</footer>`) : ''}
  </div>`;
  on(ctx.el, 'click', '[data-action=print]', () => window.print());
}
