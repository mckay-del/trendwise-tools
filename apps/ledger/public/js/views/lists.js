import { html, raw, esc, money, fmtDate, on, modal, field, options, toast, dataTable, badge, num, debounce } from '../ui.js';

const ACTION = {
  invoice: [['payment', 'Receive payment', (t) => t.balance > 0], ['print', 'Print', () => true]],
  bill: [['bill_payment', 'Make payment', (t) => t.balance > 0]],
};

function actionCell(ctx, t) {
  const acts = (ACTION[t.type] ?? []).filter(([, , ok]) => ok(t));
  return acts.map(([a, label]) => a === 'print'
    ? html`<a class="link" href="${ctx.chref('print/' + t.id)}" target="_blank" rel="noopener">${label}</a>`
    : html`<a class="link" href="${ctx.chref('new/' + a)}?${t.type === 'invoice' ? 'customer' : 'vendor'}=${t.customer_id ?? t.vendor_id}&apply=${t.id}">${label}</a>`).join(' · ') || html`<a class="link" href="${ctx.chref('txn/' + t.id)}">View/Edit</a>`;
}

export async function transactions(ctx, { type, side, title }) {
  ctx.setTitle(title);
  const q = { type: ctx.query.type ?? type, side, from: ctx.query.from, to: ctx.query.to, status: ctx.query.status, search: ctx.query.search };
  const rows = await ctx.capi.get('/transactions', q);
  const newBtns = side === 'sales' || type === 'invoice' ? [['invoice', 'New invoice'], ['payment', 'Receive payment'], ['sales_receipt', 'Sales receipt']]
    : type === 'bill' ? [['bill', 'New bill'], ['bill_payment', 'Pay bills']]
    : type?.startsWith('expense') ? [['expense', 'New expense'], ['check', 'Check'], ['bill', 'Bill']]
    : [['journal_entry', 'Journal entry'], ['transfer', 'Transfer']];
  const totalOpen = rows.reduce((s, r) => s + (r.balance > 0 && (r.type === 'invoice' || r.type === 'bill') ? r.balance : 0), 0);
  const overdue = rows.filter((r) => r.status_label === 'Overdue');
  ctx.el.innerHTML = html`<div class="page">
    <div class="page-head"><h1>${title}</h1><div class="btn-row">${raw(newBtns.map(([t, l], i) => html`<a class="btn ${i === 0 ? 'btn-primary' : ''}" href="${ctx.chref('new/' + t)}">${l}</a>`).join(''))}</div></div>
    ${type === 'invoice' || type === 'bill' ? raw(html`<div class="stat-strip"><div><small>Open</small><b>${money(totalOpen)}</b></div><div class="bad"><small>Overdue (${overdue.length})</small><b>${money(overdue.reduce((s, r) => s + r.balance, 0))}</b></div></div>`) : ''}
    <form class="filters" data-form="filters">
      <label>From <input type="date" name="from" value="${ctx.query.from ?? ''}"></label>
      <label>To <input type="date" name="to" value="${ctx.query.to ?? ''}"></label>
      ${type === 'invoice' || type === 'bill' ? raw(html`<label>Status <select name="status">${raw(options([{ id: 'open', name: 'Open' }, { id: 'overdue', name: 'Overdue' }], ctx.query.status, { blank: 'All' }))}</select></label>`) : ''}
      <label>Search <input type="search" name="search" value="${ctx.query.search ?? ''}" placeholder="No., name, memo, amount"></label>
      <button class="btn">Apply</button>
    </form>
    ${raw(dataTable(rows, [
      { key: 'date', label: 'Date', type: 'date' },
      { key: 'type_label', label: 'Type' },
      { key: 'number', label: 'No.' },
      { key: 'payee', label: 'Name', render: (t) => esc(t.payee ?? (t.type === 'transfer' ? `${t.account_name} → ${t.to_account_name}` : '')) },
      { key: 'memo', label: 'Memo', cls: 'clip' },
      { key: 'due_date', label: 'Due', type: 'date' },
      { key: 'balance', label: 'Balance', type: 'money', render: (t) => (t.type === 'invoice' || t.type === 'bill' || t.balance ? esc(money(t.balance)) : '') },
      { key: 'total', label: 'Total', type: 'money' },
      { key: 'status_label', label: 'Status', render: (t) => badge(t.deposit_status ?? t.status_label) },
      { key: 'actions', label: '', render: (t) => actionCell(ctx, t) },
    ], { rowAttrs: (t) => html`data-href="${ctx.chref('txn/' + t.id)}" tabindex="0" class="clickable ${t.status === 'voided' ? 'voided' : ''}"`, empty: 'No transactions match these filters.' }))}
  </div>`;
  on(ctx.el, 'submit', '[data-form=filters]', (e, f) => {
    e.preventDefault();
    const { path } = { path: location.hash.slice(2).split('?')[0] };
    ctx.navigate(path, Object.fromEntries(new FormData(f)));
  });
}

// --- Customers & vendors ---------------------------------------------------

function partyForm(table, p = {}, accounts = []) {
  const isC = table === 'customers';
  return html`<div class="form-grid">
    ${raw(field('Display name *', html`<input name="display_name" required value="${p.display_name ?? ''}" autofocus>`, { cls: 'span-2' }))}
    ${raw(field('Company name', html`<input name="company_name" value="${p.company_name ?? ''}">`))}
    ${raw(field('Contact name', html`<input name="contact_name" value="${p.contact_name ?? ''}">`))}
    ${raw(field('Email', html`<input name="email" type="email" value="${p.email ?? ''}">`))}
    ${raw(field('Phone', html`<input name="phone" value="${p.phone ?? ''}">`))}
    ${raw(field(isC ? 'Billing address' : 'Address', html`<textarea name="${isC ? 'billing_address' : 'address'}" rows="3">${(isC ? p.billing_address : p.address) ?? ''}</textarea>`, { cls: 'span-2' }))}
    ${raw(field('Payment terms (days)', html`<input name="terms_days" type="number" min="0" max="365" value="${p.terms_days ?? ''}" placeholder="Company default">`))}
    ${isC ? raw(field('Taxable', html`<select name="taxable">${raw(options([{ id: 1, name: 'Yes' }, { id: 0, name: 'No' }], p.taxable ?? 1))}</select>`))
      : raw(html`${raw(field('Tax ID (EIN/SSN)', html`<input name="tax_id" value="${p.tax_id ?? ''}">`))}
        ${raw(field('Track payments for 1099', html`<select name="is_1099">${raw(options([{ id: 0, name: 'No' }, { id: 1, name: 'Yes' }], p.is_1099 ?? 0))}</select>`))}
        ${raw(field('Default expense category', html`<select name="default_account_id">${raw(options(accounts.filter((a) => ['expense', 'cost_of_goods_sold', 'other_expense'].includes(a.type)), p.default_account_id, { blank: '—' }))}</select>`))}`)}
    ${raw(field('Notes', html`<textarea name="notes" rows="2">${p.notes ?? ''}</textarea>`, { cls: 'span-2' }))}
  </div>`;
}

/** Open the customer/vendor form. Resolves with the saved record, or null if cancelled. */
export async function editParty(ctx, table, p = {}) {
  const accounts = table === 'vendors' ? await ctx.capi.accounts() : [];
  return new Promise((resolve) => {
    modal({
      onClose: () => resolve(null),
      title: p.id ? `Edit ${p.display_name}` : `New ${table === 'customers' ? 'customer' : 'vendor'}`, body: partyForm(table, p, accounts), wide: true,
      onSubmit: async (data) => {
        const body = { ...data, taxable: data.taxable === '1', is_1099: data.is_1099 === '1' };
        const r = p.id ? await ctx.capi.put(`/${table}/${p.id}`, body) : await ctx.capi.post(`/${table}`, body);
        toast('Saved');
        resolve(r);
      },
    });
  });
}

const singular = (table) => (table === 'customers' ? 'customer' : 'vendor');

/** <option>s for a customer/vendor picker with "＋ Add new …" at the top. */
export function partyOptions(list, sel, table, blank = '') {
  return options(list, sel, { blank, label: (p) => p.display_name }).replace(/(<option value="">[^<]*<\/option>)?/, (m) => `${m}${html`<option value="__new">＋ Add new ${singular(table)}</option>`}`);
}

/** Turn a bank description into a likely payee name: "SQ *BLUE MOON CAFE #123 LAS VEGAS" → "Blue Moon Cafe". */
export function guessPayee(desc = '') {
  const words = String(desc).replace(/^(sq|tst|pp|paypal|pos|ach|dbt|debit|purchase|checkcard)\s*\*?\s*/i, '').replace(/[#*].*$/, '').replace(/\d{3,}.*$/, '')
    .split(/\s+/).filter((w) => w && !/^(las|vegas|nv|ca|www|com|inc|llc|co)$/i.test(w)).slice(0, 3);
  return words.map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

/**
 * Make every <select data-quick-add="vendors|customers"> inside root offer "＋ Add new".
 * Choosing it opens the form (pre-filled from data-prefill); on save every picker of that kind
 * is refreshed and this one selects the new record; on cancel the previous choice comes back.
 */
export function wireQuickAdd(ctx, root, { onCreated } = {}) {
  on(root, 'focusin', 'select[data-quick-add]', (e, sel) => { if (sel.value !== '__new') sel.dataset.prev = sel.value; });
  on(root, 'change', 'select[data-quick-add]', async (e, sel) => {
    if (sel.value !== '__new') { sel.dataset.prev = sel.value; return; }
    const table = sel.dataset.quickAdd;
    const created = await editParty(ctx, table, sel.dataset.prefill ? { display_name: sel.dataset.prefill } : {});
    if (!created) { sel.value = sel.dataset.prev ?? ''; return; }
    const list = table === 'customers' ? await ctx.capi.customers() : await ctx.capi.vendors();
    root.querySelectorAll(`select[data-quick-add="${table}"]`).forEach((other) => {
      const keep = other === sel ? String(created.id) : other.value;
      other.innerHTML = partyOptions(list, keep, table, other.dataset.blank ?? '');
      other.value = keep;
    });
    sel.dataset.prev = String(created.id);
    onCreated?.(created, table, sel, list);
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

export async function parties(ctx, table) {
  const isC = table === 'customers';
  ctx.setTitle(isC ? 'Customers' : 'Vendors');
  const showInactive = ctx.query.inactive === '1';
  const rows = await ctx.capi.get(`/${table}`, { inactive: showInactive ? '1' : '' });
  const open = rows.reduce((s, r) => s + r.balance, 0);
  const overdue = rows.reduce((s, r) => s + r.overdue, 0);
  const render = (list) => dataTable(list, [
    { key: 'display_name', label: isC ? 'Customer' : 'Vendor', render: (r) => html`<strong>${r.display_name}</strong>${r.company_name && r.company_name !== r.display_name ? raw(html`<br><small class="muted">${r.company_name}</small>`) : ''}${r.is_active ? '' : raw(' <span class="badge badge-muted">Inactive</span>')}` },
    { key: 'email', label: 'Email' },
    { key: 'phone', label: 'Phone' },
    ...(isC ? [] : [{ key: 'is_1099', label: '1099', render: (r) => (r.is_1099 ? '✓' : '') }]),
    { key: 'overdue', label: 'Overdue', type: 'money', render: (r) => (r.overdue ? html`<span class="neg">${money(r.overdue)}</span>` : '') },
    { key: 'balance', label: 'Open balance', type: 'money' },
    { key: 'a', label: '', render: (r) => html`<a class="link" href="${ctx.chref(isC ? 'new/invoice' : 'new/bill')}?${isC ? 'customer' : 'vendor'}=${r.id}">${isC ? 'Create invoice' : 'Create bill'}</a>` },
  ], { rowAttrs: (r) => html`data-href="${ctx.chref(`${table}/${r.id}`)}" tabindex="0" class="clickable"`, empty: `No ${table} yet.` });
  ctx.el.innerHTML = html`<div class="page">
    <div class="page-head"><h1>${isC ? 'Customers' : 'Vendors'}</h1><div class="btn-row"><button class="btn btn-primary" data-action="new">New ${isC ? 'customer' : 'vendor'}</button></div></div>
    <div class="stat-strip"><div><small>${isC ? 'Receivable' : 'Payable'}</small><b>${money(open)}</b></div><div class="bad"><small>Overdue</small><b>${money(overdue)}</b></div><div><small>${isC ? 'Customers' : 'Vendors'}</small><b>${rows.length}</b></div></div>
    <div class="filters"><input type="search" data-filter placeholder="Find by name, email or phone" aria-label="Filter"><label class="check"><input type="checkbox" data-inactive ${showInactive ? 'checked' : ''}> Include inactive</label></div>
    <div data-list>${raw(render(rows))}</div>
  </div>`;
  on(ctx.el, 'click', '[data-action=new]', async () => { const r = await editParty(ctx, table); ctx.navigate(ctx.cpath(`${table}/${r.id}`)); });
  on(ctx.el, 'change', '[data-inactive]', (e, el) => ctx.navigate(ctx.cpath(table), { inactive: el.checked ? '1' : '' }));
  on(ctx.el, 'input', '[data-filter]', debounce((e, el) => {
    const q = el.value.toLowerCase();
    ctx.el.querySelector('[data-list]').innerHTML = render(rows.filter((r) => [r.display_name, r.company_name, r.email, r.phone].some((v) => v?.toLowerCase().includes(q))));
  }, 120));
}

export async function partyDetail(ctx, table) {
  const isC = table === 'customers';
  const p = await ctx.capi.get(`/${table}/${ctx.params.id}`);
  ctx.setTitle(p.display_name);
  ctx.el.innerHTML = html`<div class="page">
    <div class="crumbs"><a href="${ctx.chref(table)}">${isC ? 'Customers' : 'Vendors'}</a> ›</div>
    <div class="page-head"><h1>${p.display_name} ${p.is_active ? '' : raw('<span class="badge badge-muted">Inactive</span>')}</h1>
      <div class="btn-row"><button class="btn" data-action="edit">Edit</button><button class="btn" data-action="toggle">${p.is_active ? 'Make inactive' : 'Make active'}</button>
      ${raw(isC ? html`<a class="btn" href="${ctx.chref('new/payment')}?customer=${p.id}">Receive payment</a><a class="btn btn-primary" href="${ctx.chref('new/invoice')}?customer=${p.id}">New invoice</a>`
        : html`<a class="btn" href="${ctx.chref('new/bill_payment')}?vendor=${p.id}">Pay bills</a><a class="btn" href="${ctx.chref('new/expense')}?vendor=${p.id}">New expense</a><a class="btn btn-primary" href="${ctx.chref('new/bill')}?vendor=${p.id}">New bill</a>`)}</div></div>
    <div class="detail-grid">
      <section class="card">
        <dl class="dl">
          ${p.company_name ? raw(html`<dt>Company</dt><dd>${p.company_name}</dd>`) : ''}
          ${p.contact_name ? raw(html`<dt>Contact</dt><dd>${p.contact_name}</dd>`) : ''}
          ${p.email ? raw(html`<dt>Email</dt><dd><a href="mailto:${p.email}">${p.email}</a></dd>`) : ''}
          ${p.phone ? raw(html`<dt>Phone</dt><dd>${p.phone}</dd>`) : ''}
          ${(p.billing_address ?? p.address) ? raw(html`<dt>Address</dt><dd class="pre">${p.billing_address ?? p.address}</dd>`) : ''}
          <dt>Terms</dt><dd>${p.terms_days != null ? `Net ${p.terms_days}` : 'Company default'}</dd>
          ${!isC ? raw(html`<dt>1099</dt><dd>${p.is_1099 ? `Yes · Tax ID ${p.tax_id ?? 'missing'}` : 'No'}</dd>`) : ''}
          ${p.notes ? raw(html`<dt>Notes</dt><dd class="pre">${p.notes}</dd>`) : ''}
        </dl>
      </section>
      <section class="card"><h3>Open balance</h3><div class="big-number">${money(p.balance)}</div><div class="kv ${p.overdue ? 'bad' : ''}"><span>Overdue</span><b>${money(p.overdue)}</b></div></section>
    </div>
    <h2>Transactions</h2>
    ${raw(dataTable(p.transactions, [
      { key: 'date', label: 'Date', type: 'date' }, { key: 'type_label', label: 'Type' }, { key: 'number', label: 'No.' },
      { key: 'memo', label: 'Memo', cls: 'clip' }, { key: 'due_date', label: 'Due', type: 'date' },
      { key: 'balance', label: 'Balance', type: 'money' }, { key: 'total', label: 'Total', type: 'money' },
      { key: 'status_label', label: 'Status', render: (t) => badge(t.status_label) },
    ], { rowAttrs: (t) => html`data-href="${ctx.chref('txn/' + t.id)}" tabindex="0" class="clickable ${t.status === 'voided' ? 'voided' : ''}"` }))}
  </div>`;
  on(ctx.el, 'click', '[data-action=edit]', async () => { await editParty(ctx, table, p); ctx.reload(); });
  on(ctx.el, 'click', '[data-action=toggle]', async () => {
    try { await ctx.capi.put(`/${table}/${p.id}`, { is_active: !p.is_active }); toast(p.is_active ? 'Made inactive' : 'Made active'); ctx.reload(); }
    catch (e) { toast(e.message, 'error'); }
  });
}

// --- Products & services ----------------------------------------------------

export async function editItem(ctx, it = {}) {
  const accounts = await ctx.capi.accounts();
  const inc = accounts.filter((a) => ['income', 'other_income'].includes(a.type));
  const exp = accounts.filter((a) => ['expense', 'cost_of_goods_sold', 'other_expense'].includes(a.type));
  return new Promise((resolve) => modal({
    title: it.id ? `Edit ${it.name}` : 'New product or service', wide: true,
    body: html`<div class="form-grid">
      ${raw(field('Name *', html`<input name="name" required value="${it.name ?? ''}" autofocus>`))}
      ${raw(field('SKU', html`<input name="sku" value="${it.sku ?? ''}">`))}
      ${raw(field('Type', html`<select name="type">${raw(options([{ id: 'service', name: 'Service' }, { id: 'non_inventory', name: 'Non-inventory' }], it.type ?? 'service'))}</select>`))}
      ${raw(field('Taxable', html`<select name="taxable">${raw(options([{ id: 0, name: 'No' }, { id: 1, name: 'Yes' }], it.taxable ?? 0))}</select>`))}
      ${raw(field('Sales description', html`<textarea name="description" rows="2">${it.description ?? ''}</textarea>`, { cls: 'span-2' }))}
      ${raw(field('Sales price / rate', html`<input name="sales_price" inputmode="decimal" value="${it.sales_price != null ? num(it.sales_price) : ''}">`))}
      ${raw(field('Income account', html`<select name="income_account_id">${raw(options(inc, it.income_account_id ?? inc[0]?.id, { blank: '— none (purchase only) —' }))}</select>`))}
      ${raw(field('Purchase cost', html`<input name="cost" inputmode="decimal" value="${it.cost ? num(it.cost) : ''}">`))}
      ${raw(field('Expense account', html`<select name="expense_account_id">${raw(options(exp, it.expense_account_id, { blank: '— none (sales only) —' }))}</select>`))}
    </div>`,
    onSubmit: async (d) => {
      const body = { ...d, taxable: d.taxable === '1' };
      const r = it.id ? await ctx.capi.put(`/items/${it.id}`, body) : await ctx.capi.post('/items', body);
      toast('Saved'); resolve(r);
    },
  }));
}

export async function items(ctx) {
  ctx.setTitle('Products and services');
  const rows = await ctx.capi.get('/items', { inactive: '1' });
  ctx.el.innerHTML = html`<div class="page">
    <div class="page-head"><h1>Products and services</h1><button class="btn btn-primary" data-action="new">New</button></div>
    ${raw(dataTable(rows, [
      { key: 'name', label: 'Name', render: (r) => html`<strong>${r.name}</strong>${r.is_active ? '' : raw(' <span class="badge badge-muted">Inactive</span>')}` },
      { key: 'sku', label: 'SKU' }, { key: 'type', label: 'Type', render: (r) => (r.type === 'service' ? 'Service' : 'Non-inventory') },
      { key: 'description', label: 'Description', cls: 'clip' },
      { key: 'sales_price', label: 'Price', type: 'money' }, { key: 'cost', label: 'Cost', type: 'money', render: (r) => (r.cost ? esc(money(r.cost)) : '') },
      { key: 'income_account_name', label: 'Income account' }, { key: 'taxable', label: 'Taxable', render: (r) => (r.taxable ? '✓' : '') },
      { key: 'a', label: '', render: (r) => html`<button class="link" data-edit="${r.id}">Edit</button> · <button class="link" data-toggle="${r.id}">${r.is_active ? 'Make inactive' : 'Make active'}</button>` },
    ], { empty: 'Add the services and products you sell so invoices fill in automatically.' }))}
  </div>`;
  on(ctx.el, 'click', '[data-action=new]', async () => { await editItem(ctx); ctx.reload(); });
  on(ctx.el, 'click', '[data-edit]', async (e, b) => { await editItem(ctx, rows.find((r) => r.id === Number(b.dataset.edit))); ctx.reload(); });
  on(ctx.el, 'click', '[data-toggle]', async (e, b) => { const it = rows.find((r) => r.id === Number(b.dataset.toggle)); await ctx.capi.put(`/items/${it.id}`, { is_active: !it.is_active }); ctx.reload(); });
}
