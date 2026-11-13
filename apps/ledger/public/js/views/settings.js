import { api } from '../api.js';
import { html, raw, esc, on, field, toast, modal, options, dataTable, fmtDate } from '../ui.js';
import { companyForm } from './auth.js';
import { refreshCompany } from '../app.js';

export async function company(ctx) {
  ctx.setTitle('Settings');
  const c = ctx.company;
  const taxRates = await ctx.capi.get('/tax-rates');
  const canClose = ['admin', 'accountant'].includes(ctx.user.role);
  ctx.el.innerHTML = html`<div class="page">
    <div class="page-head"><h1>Settings</h1><div class="btn-row"><a class="btn" href="${ctx.chref('audit')}">Audit log</a>${ctx.user.role === 'admin' ? raw('<a class="btn" href="#/users">Manage users</a>') : ''}</div></div>
    <div class="settings-grid">
      <section class="card"><h3>Company</h3><form data-form="company">${raw(companyForm(c))}
        <div class="form-grid">${raw(field('Default payment terms (days)', html`<input name="default_terms_days" type="number" min="0" max="365" value="${c.default_terms_days}">`))}
        ${raw(field('Invoice footer', html`<textarea name="invoice_footer" rows="2" placeholder="Thank you for your business! Remit to…">${c.invoice_footer ?? ''}</textarea>`, { cls: 'span-2' }))}</div>
        <button class="btn btn-primary">Save company settings</button></form></section>
      <section class="card"><h3>Close the books</h3>
        <p class="muted">Transactions dated on or before the closing date can't be added, edited, voided or deleted. Use this after you file a return or finish a period-end close.</p>
        <form data-form="closing" class="stack">${raw(field('Closing date', html`<input type="date" name="closing_date" value="${c.closing_date ?? ''}" ${canClose ? '' : raw('disabled')}>`, { hint: canClose ? 'Leave blank to open all periods' : 'Only admins and accountants can change this' }))}
        ${canClose ? raw('<button class="btn btn-primary">Save closing date</button>') : ''}</form>
      </section>
      <section class="card"><h3>Sales tax rates</h3>
        ${raw(dataTable(taxRates, [
          { key: 'name', label: 'Name' }, { key: 'rate', label: 'Rate', render: (r) => esc(`${r.rate}%`) },
          { key: 'is_active', label: 'Status', render: (r) => (r.is_active ? 'Active' : 'Inactive') },
          { key: 'a', label: '', render: (r) => html`<button class="link" data-tax="${r.id}">Edit</button>` },
        ], { empty: 'No sales tax rates. Add one if you charge sales tax.' }))}
        <button class="btn" data-tax="new">Add tax rate</button>
      </section>
    </div></div>`;

  on(ctx.el, 'submit', '[data-form=company]', async (e, f) => {
    e.preventDefault();
    try { await ctx.capi.put('', Object.fromEntries(new FormData(f))); toast('Company settings saved'); await refreshCompany(); }
    catch (ex) { toast(ex.message, 'error'); }
  });
  on(ctx.el, 'submit', '[data-form=closing]', async (e, f) => {
    e.preventDefault();
    try { await ctx.capi.put('', { closing_date: f.closing_date.value || null }); toast(f.closing_date.value ? `Books closed through ${f.closing_date.value}` : 'Closing date removed'); await refreshCompany(); }
    catch (ex) { toast(ex.message, 'error'); }
  });
  on(ctx.el, 'click', '[data-tax]', (e, b) => {
    const r = taxRates.find((x) => String(x.id) === b.dataset.tax) ?? {};
    modal({
      title: r.id ? 'Edit tax rate' : 'New tax rate',
      body: html`<div class="stack">${raw(field('Name', html`<input name="name" required value="${r.name ?? ''}" placeholder="e.g. Clark County, NV">`))}${raw(field('Rate (%)', html`<input name="rate" inputmode="decimal" required value="${r.rate ?? ''}" placeholder="8.375">`))}
        ${r.id ? raw(field('Status', html`<select name="is_active">${raw(options([{ id: 1, name: 'Active' }, { id: 0, name: 'Inactive' }], r.is_active))}</select>`)) : ''}</div>`,
      onSubmit: async (d) => { const body = { ...d, is_active: d.is_active === undefined ? undefined : d.is_active === '1' }; if (r.id) await ctx.capi.put(`/tax-rates/${r.id}`, body); else await ctx.capi.post('/tax-rates', body); toast('Saved'); ctx.reload(); },
    });
  });
}

export async function audit(ctx) {
  ctx.setTitle('Audit log');
  const rows = await ctx.capi.get('/audit', { limit: 500 });
  ctx.el.innerHTML = html`<div class="page"><div class="crumbs"><a href="${ctx.chref('settings')}">Settings</a> ›</div><div class="page-head"><h1>Audit log</h1></div>
    ${raw(dataTable(rows, [
      { key: 'at', label: 'When (UTC)', render: (r) => esc(r.at) }, { key: 'user_name', label: 'User' },
      { key: 'action', label: 'Action' }, { key: 'entity', label: 'Record', render: (r) => esc(r.entity.replace(/_/g, ' ')) },
      { key: 'summary', label: 'Details' },
    ], { rowAttrs: (r) => (r.entity_id && !['company', 'customer', 'vendor', 'item', 'tax_rate', 'bank_rule', 'bank_feed', 'account', 'reconciliation', 'closing_date', 'user'].includes(r.entity) && r.action !== 'delete' ? html`data-href="${ctx.chref('txn/' + r.entity_id)}" class="clickable"` : '') }))}</div>`;
}

export async function users(ctx) {
  document.title = 'Users · Trendwise Ledger';
  const list = await api.get('/api/users');
  ctx.el.innerHTML = (html`<div class="page narrow">
    <div class="crumbs"><a href="#/companies">Companies</a> ›</div>
    <div class="page-head"><h1>Users</h1><button class="btn btn-primary" data-action="new">Invite user</button></div>
    <p class="muted"><b>Admin</b>: everything, including users. <b>Accountant</b>: all bookkeeping plus closing the books and undoing reconciliations. <b>Standard</b>: day-to-day entry. <b>Viewer</b>: read-only reports and lists.</p>
    ${raw(dataTable(list, [
      { key: 'name', label: 'Name' }, { key: 'email', label: 'Email' }, { key: 'role', label: 'Role' },
      { key: 'is_active', label: 'Status', render: (u) => (u.is_active ? 'Active' : 'Inactive') },
      { key: 'created_at', label: 'Added', render: (u) => esc(fmtDate(u.created_at)) },
      { key: 'a', label: '', render: (u) => html`<button class="link" data-edit="${u.id}">Edit</button>` },
    ]))}</div>`);
  const ROLES = ['admin', 'accountant', 'standard', 'viewer'].map((r) => ({ id: r, name: r[0].toUpperCase() + r.slice(1) }));
  const form = (u = {}) => html`<div class="stack">
    ${raw(field('Name', html`<input name="name" required value="${u.name ?? ''}">`))}
    ${u.id ? '' : raw(field('Email', '<input name="email" type="email" required>'))}
    ${raw(field('Role', html`<select name="role">${raw(options(ROLES, u.role ?? 'standard'))}</select>`))}
    ${u.id ? raw(field('Status', html`<select name="is_active">${raw(options([{ id: 1, name: 'Active' }, { id: 0, name: 'Inactive' }], u.is_active))}</select>`)) : ''}
    ${raw(field(u.id ? 'Reset password' : 'Temporary password', html`<input name="password" type="password" minlength="10" ${u.id ? '' : raw('required')} autocomplete="new-password">`, { hint: 'At least 10 characters. Share it securely.' }))}</div>`;
  on(ctx.el, 'click', '[data-action=new]', () => modal({ title: 'Invite user', body: form(), onSubmit: async (d) => { await api.post('/api/users', d); toast('User added'); ctx.reload(); } }));
  on(ctx.el, 'click', '[data-edit]', (e, b) => {
    const u = list.find((x) => x.id === Number(b.dataset.edit));
    modal({ title: `Edit ${u.name}`, body: form(u), onSubmit: async (d) => { await api.put(`/api/users/${u.id}`, { ...d, is_active: d.is_active === '1', password: d.password || undefined }); toast('User updated'); ctx.reload(); } });
  });
}
