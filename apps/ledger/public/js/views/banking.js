import { html, raw, esc, money, fmtDate, on, $, $$, options, field, toast, modal, dataTable, confirmDialog } from '../ui.js';

const acctLabel = (a) => `${a.number ? a.number + ' ' : ''}${a.name}`;

export async function feed(ctx) {
  ctx.setTitle('Banking');
  const [accounts, vendors, customers, dash] = await Promise.all([ctx.capi.accounts(), ctx.capi.vendors(), ctx.capi.customers(), ctx.capi.get('/dashboard')]);
  const feedAccts = accounts.filter((a) => a.type === 'bank' || a.type === 'credit_card');
  if (!feedAccts.length) { ctx.el.innerHTML = '<div class="page"><h1>Banking</h1><div class="empty">Add a bank or credit card account in the chart of accounts first.</div></div>'; return; }
  const acctId = Number(ctx.query.account) || feedAccts[0].id;
  const tab = ctx.query.tab ?? 'review';
  const rows = await ctx.capi.get('/bank/feed', { account_id: acctId, status: tab === 'done' ? 'done' : tab });
  const categories = accounts.filter((a) => a.id !== acctId && !['accounts_receivable', 'accounts_payable'].includes(a.type) && a.system_key !== 'UNDEPOSITED');
  const catOpts = (sel) => options(categories, sel, { blank: 'Select category', label: acctLabel, group: (a) => a.type_label });
  const counts = Object.fromEntries(dash.banks.map((b) => [b.id, b]));

  const reviewTable = () => rows.length ? html`<div class="table-wrap"><table class="grid feed">
    <thead><tr><th><input type="checkbox" data-all aria-label="Select all"></th><th>Date</th><th>Description</th><th class="num">Spent</th><th class="num">Received</th><th>Payee</th><th>Category or match</th><th></th></tr></thead>
    <tbody>${raw(rows.map((r) => {
      const best = r.matches?.[0];
      const payeeList = r.amount < 0 ? vendors : customers;
      const payeeSel = r.amount < 0 ? r.suggested_vendor_id : r.suggested_customer_id;
      return html`<tr data-feed="${r.id}" data-amount="${r.amount}">
        <td><input type="checkbox" data-sel aria-label="Select"></td>
        <td>${fmtDate(r.date)}</td>
        <td class="desc">${r.description}${r.rule_name ? raw(html`<br><small class="muted">Rule: ${r.rule_name}</small>`) : ''}</td>
        <td class="num">${r.amount < 0 ? money(-r.amount) : ''}</td>
        <td class="num">${r.amount > 0 ? money(r.amount) : ''}</td>
        <td><select data-payee aria-label="Payee">${raw(options(payeeList, payeeSel, { blank: '', label: (p) => p.display_name }))}</select></td>
        <td>${best ? raw(html`<label class="match"><input type="radio" name="mode-${r.id}" value="match" checked> Match: <a href="${ctx.chref('txn/' + best.transaction_id)}">${best.type_label} ${best.number ?? ''}</a> <small>${fmtDate(best.date)}${best.payee ? ' · ' + esc(best.payee) : ''}</small></label><label class="match"><input type="radio" name="mode-${r.id}" value="add"> Categorize</label>`) : ''}
          <select data-cat aria-label="Category" ${best ? raw('hidden') : ''}>${raw(catOpts(r.suggested_account_id))}</select></td>
        <td class="nowrap"><button type="button" class="btn btn-small btn-primary" data-go>${best ? 'Match' : 'Add'}</button> <button type="button" class="link" data-exclude>Exclude</button> <button type="button" class="link" data-mkrule>Rule…</button></td></tr>`;
    }).join(''))}</tbody></table></div>` : html`<div class="empty"><p>You're all caught up. 🎉</p><p class="muted">Upload a CSV, QFX or OFX file from your bank to bring in new transactions.</p></div>`;

  const doneTable = () => dataTable(rows, [
    { key: 'date', label: 'Date', type: 'date' }, { key: 'description', label: 'Description' },
    { key: 'amount', label: 'Amount', type: 'money' },
    { key: 'status', label: tab === 'done' ? 'Action' : 'Status', render: (r) => (r.status === 'matched' ? 'Matched' : r.status === 'added' ? 'Added' : 'Excluded') },
    { key: 'txn', label: 'Transaction', render: (r) => (r.txn_id ? html`<a href="${ctx.chref('txn/' + r.txn_id)}">${r.txn_type_label} ${r.txn_number ?? ''}</a>` : '') },
    { key: 'u', label: '', render: (r) => html`<button class="link" data-undo="${r.id}">Undo</button>` },
  ], { empty: tab === 'done' ? 'Nothing categorized yet.' : 'Nothing excluded.' });

  ctx.el.innerHTML = html`<div class="page">
    <div class="page-head"><h1>Bank transactions</h1><div class="btn-row"><a class="btn" href="${ctx.chref('banking/rules')}">Rules</a><a class="btn" href="${ctx.chref('reconcile/' + acctId)}">Reconcile</a><button class="btn btn-primary" data-action="upload">Upload transactions</button></div></div>
    <div class="acct-tiles">${raw(feedAccts.map((a) => html`<a class="acct-tile ${a.id === acctId ? 'active' : ''}" href="${ctx.chref('banking')}?account=${a.id}"><strong>${a.name}</strong><span class="muted">In books</span><b>${money(a.balance)}</b>${counts[a.id]?.to_review ? raw(html`<span class="badge badge-warn">${counts[a.id].to_review} to review</span>`) : ''}</a>`).join(''))}</div>
    <div class="tabs" role="tablist">${raw([['review', 'For review'], ['done', 'Categorized'], ['excluded', 'Excluded']].map(([k, l]) => html`<a role="tab" aria-selected="${k === tab}" class="${k === tab ? 'active' : ''}" href="${ctx.chref('banking')}?account=${acctId}&tab=${k}">${l}</a>`).join(''))}</div>
    ${tab === 'review' && rows.length ? raw('<div class="bulk btn-row"><button class="btn btn-small" data-bulk="accept">Accept selected</button><button class="btn btn-small" data-bulk="exclude">Exclude selected</button><button class="btn btn-small btn-ghost" data-action="apply-rules">Re-run rules</button></div>') : ''}
    ${raw(tab === 'review' ? reviewTable() : doneTable())}
  </div>`;

  const reload = () => ctx.reload();
  const rowEl = (id) => ctx.el.querySelector(`tr[data-feed="${id}"]`);
  const act = async (tr) => {
    const id = tr.dataset.feed;
    const mode = tr.querySelector(`input[name="mode-${id}"]:checked`)?.value ?? 'add';
    const r = rows.find((x) => String(x.id) === id);
    if (mode === 'match') return ctx.capi.post(`/bank/feed/${id}/match`, { transaction_id: r.matches[0].transaction_id });
    const payee = tr.querySelector('[data-payee]').value || null;
    return ctx.capi.post(`/bank/feed/${id}/add`, { account_id: tr.querySelector('[data-cat]').value || null, ...(Number(tr.dataset.amount) < 0 ? { vendor_id: payee } : { customer_id: payee }) });
  };

  on(ctx.el, 'change', 'input[type=radio][name^=mode-]', (e, rb) => {
    const tr = rb.closest('tr');
    tr.querySelector('[data-cat]').hidden = rb.value === 'match';
    tr.querySelector('[data-go]').textContent = rb.value === 'match' ? 'Match' : 'Add';
  });
  on(ctx.el, 'click', '[data-go]', async (e, b) => {
    b.disabled = true;
    try { await act(b.closest('tr')); toast('Done'); reload(); } catch (ex) { toast(ex.message, 'error'); b.disabled = false; }
  });
  on(ctx.el, 'click', '[data-exclude]', async (e, b) => { await ctx.capi.post(`/bank/feed/${b.closest('tr').dataset.feed}/exclude`); reload(); });
  on(ctx.el, 'click', '[data-undo]', async (e, b) => { try { await ctx.capi.post(`/bank/feed/${b.dataset.undo}/undo`); toast('Moved back to For review'); reload(); } catch (ex) { toast(ex.message, 'error'); } });
  on(ctx.el, 'change', '[data-all]', (e, cb) => $$('[data-sel]', ctx.el).forEach((c) => { c.checked = cb.checked; }));
  on(ctx.el, 'click', '[data-bulk]', async (e, b) => {
    const sel = $$('[data-sel]:checked', ctx.el).map((c) => c.closest('tr'));
    if (!sel.length) return toast('Select some transactions first', 'error');
    let ok = 0; const errors = [];
    for (const tr of sel) {
      try { if (b.dataset.bulk === 'exclude') await ctx.capi.post(`/bank/feed/${tr.dataset.feed}/exclude`); else await act(tr); ok++; }
      catch (ex) { errors.push(`${tr.querySelector('.desc').textContent.trim()}: ${ex.message}`); }
    }
    toast(`${ok} processed${errors.length ? `, ${errors.length} need attention` : ''}`, errors.length ? 'error' : 'ok');
    if (errors.length) console.warn(errors);
    reload();
  });
  on(ctx.el, 'click', '[data-action=apply-rules]', async () => { const r = await ctx.capi.post('/bank/rules/apply', { account_id: acctId }); toast(`${r.suggested} matched a rule, ${r.added} auto-added`); reload(); });
  on(ctx.el, 'click', '[data-mkrule]', async (e, b) => {
    const tr = b.closest('tr');
    const r = rows.find((x) => String(x.id) === tr.dataset.feed);
    const words = r.description.split(/\s+/).slice(0, 2).join(' ');
    await editRule(ctx, { match_text: words, name: words, direction: r.amount < 0 ? 'out' : 'in', account_id: tr.querySelector('[data-cat]').value || null, vendor_id: r.amount < 0 ? tr.querySelector('[data-payee]').value || null : null, customer_id: r.amount > 0 ? tr.querySelector('[data-payee]').value || null : null }, accounts, vendors, customers);
    await ctx.capi.post('/bank/rules/apply', { account_id: acctId });
    reload();
  });
  on(ctx.el, 'click', '[data-action=upload]', () => upload(ctx, feedAccts, acctId, reload));
  void rowEl;
}

function upload(ctx, feedAccts, acctId, done) {
  const m = modal({
    title: 'Upload bank transactions', submitLabel: 'Upload',
    body: html`<div class="stack">
      ${raw(field('Account', html`<select name="account_id">${raw(options(feedAccts, acctId, { label: acctLabel }))}</select>`))}
      ${raw(field('File (CSV, QFX or OFX)', '<input type="file" name="file" accept=".csv,.qfx,.ofx,text/csv" required>', { hint: 'CSV needs Date, Description and Amount (or Debit/Credit) columns.' }))}
      <label class="check"><input type="checkbox" name="invert" value="1"> Amounts are reversed (charges shown as positive — common on credit card exports)</label>
      <div data-preview class="muted"></div></div>`,
    onSubmit: async (d, form) => {
      const file = form.file.files[0];
      if (!file) throw new Error('Choose a file');
      const content = await file.text();
      const r = await ctx.capi.post('/bank/import', { account_id: d.account_id, content, invert: !!d.invert, format: /\.(qfx|ofx)$/i.test(file.name) ? 'ofx' : 'csv' });
      toast(`${r.imported} imported${r.duplicates ? `, ${r.duplicates} duplicates skipped` : ''}${r.auto_added ? `, ${r.auto_added} auto-added by rules` : ''}`);
      ctx.navigate(ctx.cpath('banking'), { account: d.account_id });
      done();
    },
  });
  m.el.file.addEventListener('change', async () => {
    const f = m.el.file.files[0];
    if (!f) return;
    const text = await f.text();
    m.el.querySelector('[data-preview]').textContent = `${text.split(/\r?\n/).filter(Boolean).length - 1} rows · first line: ${text.split(/\r?\n/)[0].slice(0, 120)}`;
  });
}

function editRule(ctx, r, accounts, vendors, customers) {
  const feedAccts = accounts.filter((a) => a.type === 'bank' || a.type === 'credit_card');
  const cats = accounts.filter((a) => !['accounts_receivable', 'accounts_payable'].includes(a.type));
  return new Promise((resolve) => modal({
    title: r.id ? 'Edit rule' : 'Create rule', wide: true,
    body: html`<div class="form-grid">
      ${raw(field('Rule name', html`<input name="name" value="${r.name ?? ''}">`))}
      ${raw(field('Apply to', html`<select name="direction">${raw(options([{ id: 'out', name: 'Money out' }, { id: 'in', name: 'Money in' }, { id: 'any', name: 'Both' }], r.direction ?? 'out'))}</select>`))}
      ${raw(field('Bank account', html`<select name="bank_account_id">${raw(options(feedAccts, r.bank_account_id, { blank: 'All accounts', label: acctLabel }))}</select>`))}
      ${raw(field('Description contains', html`<input name="match_text" required value="${r.match_text ?? ''}">`))}
      ${raw(field('Category', html`<select name="account_id" required>${raw(options(cats, r.account_id, { blank: 'Select category', label: acctLabel, group: (a) => a.type_label }))}</select>`))}
      ${raw(field('Payee (vendor)', html`<select name="vendor_id">${raw(options(vendors, r.vendor_id, { blank: '', label: (v) => v.display_name }))}</select>`))}
      ${raw(field('Customer', html`<select name="customer_id">${raw(options(customers, r.customer_id, { blank: '', label: (v) => v.display_name }))}</select>`))}
      ${raw(field('Priority', html`<input name="priority" type="number" value="${r.priority ?? 100}">`, { hint: 'Lower runs first' }))}
      <label class="check span-2"><input type="checkbox" name="auto_add" value="1" ${r.auto_add ? raw('checked') : ''}> Automatically add matching transactions (skip review)</label>
    </div>`,
    onSubmit: async (d) => {
      const body = { ...d, auto_add: !!d.auto_add };
      const saved = r.id ? await ctx.capi.put(`/bank/rules/${r.id}`, body) : await ctx.capi.post('/bank/rules', body);
      toast('Rule saved'); resolve(saved);
    },
  }));
}

export async function rules(ctx) {
  ctx.setTitle('Bank rules');
  const [list, accounts, vendors, customers] = await Promise.all([ctx.capi.get('/bank/rules'), ctx.capi.accounts(), ctx.capi.vendors(), ctx.capi.customers()]);
  ctx.el.innerHTML = html`<div class="page">
    <div class="crumbs"><a href="${ctx.chref('banking')}">Banking</a> ›</div>
    <div class="page-head"><h1>Rules</h1><div class="btn-row"><button class="btn" data-action="apply">Run rules now</button><button class="btn btn-primary" data-action="new">New rule</button></div></div>
    <p class="muted">Rules categorize downloaded transactions automatically. The first matching rule (by priority) wins.</p>
    ${raw(dataTable(list, [
      { key: 'priority', label: 'Priority' }, { key: 'name', label: 'Rule' },
      { key: 'direction', label: 'Applies to', render: (r) => ({ in: 'Money in', out: 'Money out', any: 'Both' }[r.direction]) },
      { key: 'match_text', label: 'Description contains', render: (r) => html`<code>${r.match_text}</code>` },
      { key: 'bank_account_name', label: 'Bank account', render: (r) => esc(r.bank_account_name ?? 'All') },
      { key: 'account_name', label: 'Category' }, { key: 'vendor_name', label: 'Payee', render: (r) => esc(r.vendor_name ?? r.customer_name ?? '') },
      { key: 'auto_add', label: 'Auto-add', render: (r) => (r.auto_add ? '✓' : '') },
      { key: 'a', label: '', render: (r) => html`<button class="link" data-edit="${r.id}">Edit</button> · <button class="link danger" data-del="${r.id}">Delete</button>` },
    ], { empty: 'No rules yet. Create one from any transaction in the For review tab, or click New rule.' }))}
  </div>`;
  on(ctx.el, 'click', '[data-action=new]', async () => { await editRule(ctx, {}, accounts, vendors, customers); ctx.reload(); });
  on(ctx.el, 'click', '[data-edit]', async (e, b) => { await editRule(ctx, list.find((r) => r.id === Number(b.dataset.edit)), accounts, vendors, customers); ctx.reload(); });
  on(ctx.el, 'click', '[data-del]', async (e, b) => { if (await confirmDialog('Delete this rule?', { okLabel: 'Delete' })) { await ctx.capi.del(`/bank/rules/${b.dataset.del}`); ctx.reload(); } });
  on(ctx.el, 'click', '[data-action=apply]', async () => { const r = await ctx.capi.post('/bank/rules/apply', {}); toast(`${r.suggested} transactions matched rules, ${r.added} auto-added`); });
  void $;
}
