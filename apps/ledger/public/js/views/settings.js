import { api } from '../api.js';
import { html, raw, esc, on, field, toast, modal, options, dataTable, fmtDate, download } from '../ui.js';
import { companyForm } from './auth.js';
import { refreshCompany } from '../app.js';

export async function company(ctx) {
  ctx.setTitle('Settings');
  const c = ctx.company;
  const isAdmin = ctx.user.role === 'admin';
  const [taxRates, firm, backup] = await Promise.all([ctx.capi.get('/tax-rates'), api.get('/api/firm'), isAdmin ? api.get('/api/backup') : null]);
  const canClose = ['admin', 'accountant'].includes(ctx.user.role);
  const backupAge = backup?.last_backup ? Math.floor((Date.now() - Date.parse(backup.last_backup)) / 86400000) : null;
  ctx.el.innerHTML = html`<div class="page">
    <div class="page-head"><h1>Settings</h1><div class="btn-row"><a class="btn" href="${ctx.chref('import')}">Import from QuickBooks</a><a class="btn" href="${ctx.chref('audit')}">Audit log</a>${ctx.user.role === 'admin' ? raw('<a class="btn" href="#/users">Manage users</a>') : ''}</div></div>
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
      ${isAdmin ? raw(html`<section class="card"><h3>Backup <small>all companies</small></h3>
        <p class="${backupAge === null || backupAge > 7 ? 'bad' : 'muted'}">${backup.last_backup ? `Last backup: ${new Date(backup.last_backup).toLocaleString()} (${backupAge === 0 ? 'today' : `${backupAge} day${backupAge === 1 ? '' : 's'} ago`})` : 'No backup has been made yet.'}</p>
        <p class="muted">Your books are stored on this computer at <code>${backup.db_path}</code>.</p>
        <p class="muted">Downloads an encrypted copy of every company's books. Keep it somewhere other than this computer (e.g. an encrypted drive or cloud folder). <b>The passphrase can't be recovered</b> — store it in your password manager.</p>
        <button class="btn btn-primary" data-action="backup">Download encrypted backup</button>
      </section>`) : ''}
      <section class="card span-all-settings"><h3>Firm branding <small>used on client report packages, all companies</small></h3>
        <form data-form="firm" class="form-grid">
          ${raw(field('Firm name', html`<input name="name" value="${firm.name}" ${isAdmin ? '' : raw('disabled')}>`))}
          ${raw(field('Tagline', html`<input name="tagline" value="${firm.tagline}" placeholder="e.g. Bookkeeping & tax · Las Vegas, NV" ${isAdmin ? '' : raw('disabled')}>`))}
          ${raw(field('Contact block', html`<textarea name="contact" rows="3" placeholder="Phone · email · website" ${isAdmin ? '' : raw('disabled')}>${firm.contact}</textarea>`))}
          ${raw(field('Statement footer', html`<textarea name="footer" rows="3" ${isAdmin ? '' : raw('disabled')}>${firm.footer}</textarea>`, { hint: 'Printed at the bottom of every page' }))}
          ${raw(field('Accent color', html`<input name="accent" type="color" value="${firm.accent}" ${isAdmin ? '' : raw('disabled')}>`))}
          <div class="field"><span>Logo</span><div class="logo-row">${firm.logo ? raw(html`<img src="${firm.logo}" alt="Current logo" class="logo-preview">`) : raw('<span class="muted">No logo</span>')}
            ${isAdmin ? raw('<input type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" data-logo><button type="button" class="link danger" data-action="remove-logo">Remove</button>') : ''}</div><small>PNG, JPG, SVG or WebP up to ~300 KB</small></div>
          ${isAdmin ? raw('<div class="span-2"><button class="btn btn-primary">Save branding</button> <a class="btn" data-preview>Preview package</a></div>') : ''}
        </form>
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
  let logo;
  ctx.el.querySelector('[data-preview]')?.setAttribute('href', ctx.chref('package'));
  on(ctx.el, 'change', '[data-logo]', async (e, inp) => {
    const f = inp.files[0];
    if (!f) return;
    if (f.size > 300 * 1024) { toast('Logo is too large (max about 300 KB)', 'error'); inp.value = ''; return; }
    logo = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(f); });
  });
  on(ctx.el, 'click', '[data-action=remove-logo]', async () => { await api.put('/api/firm', { logo: null }); toast('Logo removed'); ctx.reload(); });
  on(ctx.el, 'submit', '[data-form=firm]', async (e, f) => {
    e.preventDefault();
    try { await api.put('/api/firm', { ...Object.fromEntries(new FormData(f)), ...(logo ? { logo } : {}) }); toast('Branding saved'); ctx.reload(); }
    catch (ex) { toast(ex.message, 'error'); }
  });
  on(ctx.el, 'click', '[data-action=backup]', () => modal({
    title: 'Download encrypted backup', submitLabel: 'Create backup',
    body: html`<div class="stack">${raw(field('Passphrase', '<input type="password" name="passphrase" minlength="12" required autocomplete="new-password" autofocus>', { hint: 'At least 12 characters. You will need it to restore.' }))}
      ${raw(field('Confirm passphrase', '<input type="password" name="confirm" required autocomplete="new-password">'))}</div>`,
    onSubmit: async (d) => {
      if (d.passphrase !== d.confirm) throw new Error('Passphrases do not match');
      if (d.passphrase.length < 12) throw new Error('Passphrase must be at least 12 characters');
      const res = await fetch('/api/backup', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ledger' }, body: JSON.stringify({ passphrase: d.passphrase }) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Backup failed');
      const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'ledger-backup.twlbak';
      download(name, await res.blob(), 'application/octet-stream');
      toast('Backup downloaded');
      setTimeout(() => ctx.reload(), 500);
    },
  }));
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
