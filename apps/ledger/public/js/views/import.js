import { html, raw, esc, money, fmtDate, on, field, toast, confirmDialog, dataTable, readUploadFile, fmtStamp } from '../ui.js';

const STEPS = [
  { key: 'accounts', title: '1. Chart of accounts', how: 'In QuickBooks: <b>Reports</b> → search <b>Account List</b> → <b>Export</b> → Export to Excel.', files: [['file', 'Account List export']] },
  { key: 'customers', title: '2. Customers', how: 'In QuickBooks: <b>Sales</b> → <b>Customers</b> → the export icon (above the list, right side) → Export to Excel.', files: [['file', 'Customer list export']] },
  { key: 'vendors', title: '3. Vendors', how: 'In QuickBooks: <b>Expenses</b> → <b>Vendors</b> → the export icon → Export to Excel.', files: [['file', 'Vendor list export']] },
  { key: 'opening', title: '4. Opening balances', how: 'Pick a cutover date (usually the last day of a month you\'ve reconciled in QuickBooks). Run each report <b>as of that date</b>, <b>Accrual</b> basis, and export to Excel: <b>Trial Balance</b>, <b>A/R Aging Detail</b>, <b>A/P Aging Detail</b>.',
    files: [['trial_balance', 'Trial Balance (required)'], ['ar_aging', 'A/R Aging Detail (recommended)'], ['ap_aging', 'A/P Aging Detail (recommended)']] },
];

export async function view(ctx) {
  ctx.setTitle('Import from QuickBooks');
  const [history, txns] = await Promise.all([ctx.capi.get('/imports'), ctx.capi.get('/transactions', { limit: 1 })]);
  const canOpen = ['admin', 'accountant'].includes(ctx.user.role);
  const opening = history.find((h) => h.kind === 'opening' && h.status === 'done');
  ctx.el.innerHTML = html`<div class="page narrow">
    <div class="crumbs"><a href="${ctx.chref('settings')}">Settings</a> ›</div>
    <div class="page-head"><h1>Import from QuickBooks Online</h1></div>
    <p class="muted">Bring <b>${ctx.company.name}</b> over from QuickBooks in four steps. Excel (.xlsx) or CSV exports both work. Each step shows a <b>preview</b> first, and nothing is saved until you click Import. Do the steps in order: opening balances match accounts by name, so the chart of accounts must come first.</p>
    ${txns.length && !opening ? raw('<div class="banner banner-warn">This company already has transactions. Importing is still safe, but check the opening balance date doesn’t overlap what you’ve entered.</div>') : ''}
    ${raw(STEPS.map((s) => html`<section class="card import-step" data-step="${s.key}">
      <h3>${s.title} ${history.some((h) => h.kind === s.key && h.status === 'done') ? raw('<span class="badge badge-ok">imported</span>') : ''}</h3>
      <p class="muted">${raw(s.how)}</p>
      ${s.key === 'opening' && opening ? raw(html`<div class="banner banner-info">Opening balances were imported ${fmtStamp(opening.at)}: ${opening.summary}. ${canOpen ? raw(html`<button type="button" class="link danger" data-undo="${opening.id}">Undo that import</button>`) : ''}</div>`) : ''}
      ${s.key === 'opening' && !canOpen ? raw('<p class="bad">Only admins and accountants can import opening balances.</p>') : ''}
      <form class="stack" data-form="${s.key}" ${s.key === 'opening' && (opening || !canOpen) ? raw('hidden') : ''}>
        <div class="form-grid">
          ${s.key === 'opening' ? raw(field('Cutover date', '<input type="date" name="date" required>', { hint: 'Balances are as of the end of this day. Enter new activity here from the next day on.' })) : ''}
          ${raw(s.files.map(([k, label]) => field(label, html`<input type="file" name="${k}" accept=".xlsx,.csv" ${k === 'file' || k === 'trial_balance' ? raw('required') : ''}>`)).join(''))}
          ${s.key === 'accounts' ? raw('<label class="check span-2"><input type="checkbox" name="remove_unused" value="1" checked> Remove starter accounts that aren’t in QuickBooks and have never been used</label>') : ''}
        </div>
        <div class="btn-row"><button class="btn" data-mode="preview">Preview</button><button class="btn btn-primary" data-mode="import" disabled>Import</button></div>
        <div data-out></div>
      </form>
    </section>`).join(''))}
    ${history.length ? raw(html`<h2>Import history</h2>${raw(dataTable(history, [
      { key: 'at', label: 'When', render: (h) => esc(fmtStamp(h.at)) }, { key: 'kind', label: 'What' }, { key: 'file_name', label: 'Files', cls: 'clip' },
      { key: 'summary', label: 'Result' }, { key: 'user_name', label: 'By' }, { key: 'status', label: 'Status' },
    ]))}`) : ''}
    <h2>After importing</h2>
    <ol class="muted">
      <li>Run the <b>Balance Sheet</b> and <b>Trial Balance</b> as of the cutover date and compare them with QuickBooks. They should match to the penny.</li>
      <li>Check <b>A/R Aging</b> and <b>A/P Aging</b> against QuickBooks.</li>
      <li>Set the <b>closing date</b> (Settings) to the cutover date so the opening balances can't be changed by accident.</li>
      <li>Upload bank transactions starting the day after the cutover date.</li>
    </ol>
  </div>`;

  for (const s of STEPS) wireStep(ctx, s);
  on(ctx.el, 'click', '[data-undo]', async (e, b) => {
    if (!(await confirmDialog('Undo the opening balance import? The opening journal entry and every imported invoice and bill are deleted. Customers, vendors and accounts stay.', { okLabel: 'Undo import' }))) return;
    try { const r = await ctx.capi.post(`/imports/${b.dataset.undo}/undo`); toast(`Removed ${r.removed} transactions`); ctx.reload(); } catch (ex) { toast(ex.message, 'error'); }
  });
}

function wireStep(ctx, step) {
  const form = ctx.el.querySelector(`[data-form=${step.key}]`);
  const out = form.querySelector('[data-out]');
  const importBtn = form.querySelector('[data-mode=import]');
  let mode = 'preview';
  on(form, 'click', '[data-mode]', (e, b) => { mode = b.dataset.mode; });
  on(form, 'change', 'input', () => { importBtn.disabled = true; });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = { dryRun: mode === 'preview' };
    try {
      for (const [k] of step.files) { const f = form[k].files[0]; if (f) body[k] = await readUploadFile(f); }
      if (form.date) body.date = form.date.value;
      if (form.remove_unused) body.remove_unused = form.remove_unused.checked;
      form.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      const r = await ctx.capi.post(`/import/${step.key}`, body);
      out.innerHTML = renderResult(step.key, r);
      if (r.dry_run) importBtn.disabled = !!(r.unmatched?.length);
      else { toast('Imported'); ctx.state.capi?.invalidate?.(); setTimeout(() => ctx.reload(), 900); }
    } catch (ex) {
      out.innerHTML = html`<div class="form-error">${ex.message}</div>`;
      importBtn.disabled = true;
    } finally {
      form.querySelector('[data-mode=preview]').disabled = false;
      if (mode === 'import') importBtn.disabled = true;
    }
  });
}

function list(label, items, max = 12) {
  if (!items?.length) return '';
  return html`<details ${items.length <= max ? raw('open') : ''}><summary><b>${label}</b> (${items.length})</summary><p class="muted small">${items.join(', ')}</p></details>`;
}

function renderResult(kind, r) {
  const head = r.dry_run ? html`<div class="banner banner-info"><b>Preview only</b>: nothing has been saved. Review below, then click <b>Import</b>.</div>` : html`<div class="banner banner-ok">Import complete.</div>`;
  const warn = r.warnings?.length ? html`<div class="banner banner-warn"><b>Check:</b><ul>${raw(r.warnings.map((w) => html`<li>${w}</li>`).join(''))}</ul></div>` : '';
  if (kind === 'accounts') return head + warn + list('New accounts', r.created) + list('Matched existing accounts', r.updated) + list('Linked to system accounts', r.linked) + list('Starter accounts removed', r.removed);
  if (kind === 'customers' || kind === 'vendors') return head + warn + list(`New ${kind}`, r.created) + list(`Updated ${kind}`, r.updated);
  // opening
  if (r.unmatched?.length) {
    return head + warn + html`<div class="form-error">These trial balance accounts don't match any account here. Import the chart of accounts first (step 1), or add or rename the accounts in the chart of accounts, then preview again.</div>
      ${raw(dataTable(r.unmatched, [{ key: 'name', label: 'Account in QuickBooks' }, { key: 'debit', label: 'Debit', type: 'money' }, { key: 'credit', label: 'Credit', type: 'money' }]))}`;
  }
  return head + warn + html`
    <div class="stat-strip"><div><small>Accounts with balances</small><b>${r.lines.length}</b></div><div><small>Open invoices</small><b>${r.invoices}</b></div><div><small>Open bills</small><b>${r.bills}</b></div><div><small>Credits</small><b>${r.credits}</b></div></div>
    <p class="muted">Trial balance: debits ${money(r.tb_debits)} · credits ${money(r.tb_credits)}${r.ar_detail_total !== undefined ? ` · open A/R ${money(r.ar_detail_total)}` : ''}${r.ap_detail_total !== undefined ? ` · open A/P ${money(r.ap_detail_total)}` : ''}</p>
    ${raw(list('New customers created from the aging report', r.created_customers))}${raw(list('New vendors created from the aging report', r.created_vendors))}
    ${raw(dataTable(r.lines, [{ key: 'name', label: 'QuickBooks account' }, { key: 'account', label: 'Matched to' }, { key: 'debit', label: 'Debit', type: 'money', render: (l) => esc(money(l.debit, { blankZero: true })) }, { key: 'credit', label: 'Credit', type: 'money', render: (l) => esc(money(l.credit, { blankZero: true })) }]))}`;
}
void fmtDate;
