import { html, raw, esc, money, fmtDate, on, $, $$, options, field, toast, modal, dataTable, confirmDialog, readUploadFile, fmtStamp } from '../ui.js';
import { partyOptions, guessPayee, wireQuickAdd } from './lists.js';

const acctLabel = (a) => `${a.number ? a.number + ' ' : ''}${a.name}`;

export async function feed(ctx) {
  ctx.setTitle('Banking');
  const [accounts, vendors, customers, dash] = await Promise.all([ctx.capi.accounts(), ctx.capi.vendors(), ctx.capi.customers(), ctx.capi.get('/dashboard')]);
  const feedAccts = accounts.filter((a) => a.type === 'bank' || a.type === 'credit_card');
  if (!feedAccts.length) { ctx.el.innerHTML = '<div class="page"><h1>Banking</h1><div class="empty">Add a bank or credit card account in the chart of accounts first.</div></div>'; return; }
  const acctId = Number(ctx.query.account) || feedAccts[0].id;
  const isBank = feedAccts.find((a) => a.id === acctId)?.type === 'bank';
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
        <td><select data-payee data-quick-add="${r.amount < 0 ? 'vendors' : 'customers'}" data-prefill="${guessPayee(r.description)}" aria-label="${r.amount < 0 ? 'Payee (vendor)' : 'Received from (customer)'}">${raw(partyOptions(payeeList, payeeSel, r.amount < 0 ? 'vendors' : 'customers'))}</select></td>
        <td>${best ? raw(html`<label class="match"><input type="radio" name="mode-${r.id}" value="match" checked> Match: <a href="${ctx.chref('txn/' + best.transaction_id)}">${best.type_label} ${best.number ?? ''}</a> <small>${fmtDate(best.date)}${best.payee ? ' · ' + esc(best.payee) : ''}</small></label><label class="match"><input type="radio" name="mode-${r.id}" value="add"> Categorize</label>`) : ''}
          <select data-cat aria-label="Category" ${best ? raw('hidden') : ''}>${raw(catOpts(r.suggested_account_id))}</select></td>
        <td class="nowrap"><button type="button" class="btn btn-small btn-primary" data-go>${best ? 'Match' : 'Add'}</button> <button type="button" class="link" data-split>Split</button>${r.amount > 0 && isBank ? raw(' <button type="button" class="link" data-from-payments title="Deposit of payments already recorded (Stripe payout, wire, checks)">From payments</button>') : ''} <button type="button" class="link" data-exclude>Exclude</button> <button type="button" class="link" data-mkrule>Rule…</button></td></tr>`;
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
    <div class="acct-tiles">${raw(feedAccts.map((a) => html`<a class="acct-tile ${a.id === acctId ? 'active' : ''}" href="${ctx.chref('banking')}?account=${a.id}"><strong>${a.name}</strong><span class="muted">In books</span><b>${money(a.balance)}</b><small class="muted">${counts[a.id]?.data_through ? `Bank data through ${fmtDate(counts[a.id].data_through)}` : 'No bank data yet'}${counts[a.id]?.last_import_at ? ` · imported ${fmtStamp(counts[a.id].last_import_at)}` : ''}</small>${counts[a.id]?.to_review ? raw(html`<span class="badge badge-warn">${counts[a.id].to_review} to review</span>`) : ''}</a>`).join(''))}</div>
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
    const pv = tr.querySelector('[data-payee]').value;
    const payee = pv && pv !== '__new' ? pv : null;
    return ctx.capi.post(`/bank/feed/${id}/add`, { account_id: tr.querySelector('[data-cat]').value || null, ...(Number(tr.dataset.amount) < 0 ? { vendor_id: payee } : { customer_id: payee }) });
  };

  // "＋ Add new" in the payee pickers; a vendor's default category fills an empty category.
  wireQuickAdd(ctx, ctx.el, { onCreated: (c, table) => { (table === 'vendors' ? vendors : customers).push(c); } });
  on(ctx.el, 'change', '[data-payee]', (e, sel) => {
    if (sel.dataset.quickAdd !== 'vendors' || !sel.value || sel.value === '__new') return;
    const v = vendors.find((x) => String(x.id) === sel.value);
    const cat = sel.closest('tr').querySelector('[data-cat]');
    if (v?.default_account_id && cat && !cat.value) cat.value = String(v.default_account_id);
  });
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
  on(ctx.el, 'click', '[data-from-payments]', (e, b) => {
    const r = rows.find((x) => String(x.id) === b.closest('tr').dataset.feed);
    fromPaymentsDialog(ctx, r, accounts, reload);
  });
  on(ctx.el, 'click', '[data-split]', (e, b) => {
    const tr = b.closest('tr');
    const r = rows.find((x) => String(x.id) === tr.dataset.feed);
    splitDialog(ctx, r, { categories, catOpts, vendors, customers, payee: tr.querySelector('[data-payee]').value, category: tr.querySelector('[data-cat]').value, done: reload });
  });
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
  let file = null, preview = null;
  const m = modal({
    title: 'Upload bank transactions', submitLabel: 'Import', wide: true,
    body: html`<div class="stack">
      <div class="form-grid">
        ${raw(field('Account', html`<select name="account_id">${raw(options(feedAccts, acctId, { label: acctLabel }))}</select>`))}
        ${raw(field('File from your bank', '<input type="file" name="file" accept=".csv,.qfx,.ofx,.qbo,.xlsx,text/csv" required>', { hint: 'QFX/OFX (“Quicken” or “Web Connect”), CSV, or Excel' }))}
      </div>
      <div data-last class="banner banner-info" hidden></div>
      <div data-layout></div>
      <div data-result></div>
    </div>`,
    onSubmit: async (d, form) => {
      if (!file) throw new Error('Choose a file');
      if (preview?.error) throw new Error(preview.error);
      const r = await ctx.capi.post('/bank/import', { account_id: d.account_id, ...file, layout: currentLayout(form), remember: !!form.remember?.checked });
      toast(`${r.imported} imported${r.duplicates ? `, ${r.duplicates} duplicates skipped` : ''}${r.auto_added ? `, ${r.auto_added} auto-added by rules` : ''}`);
      ctx.navigate(ctx.cpath('banking'), { account: d.account_id });
      done();
    },
  });
  const form = m.el;
  const lastBox = form.querySelector('[data-last]');

  const showLast = (li) => {
    lastBox.hidden = !li;
    if (li) lastBox.innerHTML = html`Last import: <b>${fmtStamp(li.at)}</b>${li.file_name ? ` (${li.file_name})` : ''} with data through <b>${fmtDate(li.last_date)}</b>. Download from <b>${fmtDate(li.last_date)}</b> onward — overlapping days are skipped automatically.`;
  };
  const loadLast = async () => { const h = await ctx.capi.get('/bank/imports', { account_id: form.account_id.value }); showLast(h[0] ?? null); };
  loadLast();

  const currentLayout = (f) => {
    const box = f.querySelector('[data-layout] .layout');
    if (!box) return undefined;
    const v = (n) => f[n]?.value;
    return { header_row: v('header_row'), mode: f.querySelector('[name=mode]:checked')?.value, date_col: v('date_col'), description_col: v('description_col'), amount_col: v('amount_col'), debit_col: v('debit_col'), credit_col: v('credit_col'), invert: f.invert?.checked ? 1 : 0 };
  };

  const render = () => {
    const p = preview;
    const result = form.querySelector('[data-result]');
    const layoutHost = form.querySelector('[data-layout]');
    if (!p) { layoutHost.innerHTML = ''; result.innerHTML = ''; return; }
    if (p.layout) {
      const L = p.layout;
      const colOpts = (sel) => options(L.headers.map((h, i) => ({ id: i, name: h || `Column ${i + 1}` })), sel >= 0 ? sel : '', { blank: '— none —' });
      const rowOpts = options(p.raw_sample.map((r, i) => ({ id: i, name: `Row ${i + 1}: ${r.filter(Boolean).slice(0, 4).join(' | ').slice(0, 70)}` })), L.header_row);
      layoutHost.innerHTML = html`<fieldset class="layout"><legend>Columns ${p.saved_layout ? raw('<span class="badge badge-ok">remembered for this account</span>') : ''}</legend>
        <div class="form-grid cols-4">
          ${raw(field('Header row', html`<select name="header_row" data-relayout>${raw(rowOpts)}</select>`, { cls: 'span-2' }))}
          ${raw(field('Date', html`<select name="date_col" data-relayout>${raw(colOpts(L.date_col))}</select>`))}
          ${raw(field('Description', html`<select name="description_col" data-relayout>${raw(colOpts(L.description_col))}</select>`))}
        </div>
        <div class="inline-checks"><label class="check"><input type="radio" name="mode" value="single" data-relayout ${L.mode === 'single' ? raw('checked') : ''}> One amount column</label>
          <label class="check"><input type="radio" name="mode" value="split" data-relayout ${L.mode === 'split' ? raw('checked') : ''}> Separate money-out / money-in columns</label></div>
        <div class="form-grid cols-4">
          ${L.mode === 'single' ? raw(field('Amount', html`<select name="amount_col" data-relayout>${raw(colOpts(L.amount_col))}</select>`))
            : raw(html`${raw(field('Money out (debit)', html`<select name="debit_col" data-relayout>${raw(colOpts(L.debit_col))}</select>`))}${raw(field('Money in (credit)', html`<select name="credit_col" data-relayout>${raw(colOpts(L.credit_col))}</select>`))}`)}
          <label class="check span-2"><input type="checkbox" name="invert" value="1" data-relayout ${L.invert ? raw('checked') : ''}> Flip signs (charges show as positive)</label>
        </div>
        <label class="check"><input type="checkbox" name="remember" checked> Remember these columns for this account</label>
      </fieldset>`;
    } else layoutHost.innerHTML = html`<p class="muted">${p.format.toUpperCase()} file — columns are read automatically.</p>`;
    result.innerHTML = p.error ? html`<div class="form-error">${p.error}</div>` : html`
      <div class="stat-strip"><div><small>Transactions</small><b>${p.count}</b></div><div><small>Dates</small><b>${fmtDate(p.first_date)} – ${fmtDate(p.last_date)}</b></div><div><small>Money in / out</small><b>${money(p.money_in)} / ${money(p.money_out)}</b></div><div class="${p.duplicates ? '' : ''}"><small>Already imported</small><b>${p.duplicates}</b></div></div>
      ${raw(dataTable(p.sample, [{ key: 'date', label: 'Date', type: 'date' }, { key: 'description', label: 'Description' }, { key: 'amount', label: 'Amount', type: 'money' }]))}
      <small class="muted">Check the first rows: money you spent should be negative, deposits positive. If not, tick “Flip signs”.</small>`;
  };

  const refresh = async (withLayout) => {
    if (!file) return;
    try {
      preview = await ctx.capi.post('/bank/import/preview', { account_id: form.account_id.value, ...file, ...(withLayout ? { layout: currentLayout(form) } : {}) });
    } catch (e) { preview = { error: e.message }; }
    render();
  };
  form.file.addEventListener('change', async () => { file = await readUploadFile(form.file.files[0]).catch((e) => { toast(e.message, 'error'); return null; }); refresh(false); });
  form.account_id.addEventListener('change', () => { loadLast(); refresh(false); });
  on(form, 'change', '[data-relayout]', () => refresh(true));
}

/**
 * A bank deposit made of payments already recorded (GHL/Stripe payouts, wires, checks).
 * Tick the payments it contains; if they total more than the bank received, the difference is the processing fee.
 */
async function fromPaymentsDialog(ctx, r, accounts, done) {
  const cands = await ctx.capi.get(`/bank/feed/${r.id}/deposit-candidates`);
  const feeAccts = accounts.filter((a) => ['expense', 'other_expense', 'cost_of_goods_sold'].includes(a.type));
  const defaultFee = feeAccts.find((a) => /bank charge|merchant|processing|stripe/i.test(a.name))?.id;
  const m = modal({
    title: 'Deposit from payments', wide: true, submitLabel: 'Record deposit',
    body: html`<div class="split-head"><div><small class="muted">${fmtDate(r.date)}</small><div><b>${r.description}</b></div></div><div class="split-amt"><small>Received</small><b>${money(r.amount)}</b></div></div>
      ${cands.length ? raw(html`<p class="muted">Tick the payments included in this deposit. Stripe's dashboard (Balance → Payouts) lists the payments in each payout.</p>
      <div class="table-wrap"><table class="grid"><thead><tr><th></th><th>Date</th><th>Customer</th><th>Type</th><th>Ref</th><th class="num">Amount</th></tr></thead><tbody>
        ${raw(cands.map((c) => html`<tr><td><input type="checkbox" data-pay="${c.id}" data-amt="${c.total}" aria-label="Include"></td><td>${fmtDate(c.date)}</td><td>${c.customer_name || '—'}</td><td>${c.type_label}</td><td><small>${c.number ?? ''}</small></td><td class="num">${money(c.total)}</td></tr>`).join(''))}
      </tbody></table></div>
      <div class="form-grid" style="margin-top:1rem">${raw(field('Fee account (if the deposit is less than the payments)', html`<select name="fee_account_id">${raw(options(feeAccts, defaultFee, { blank: 'Choose…', label: acctLabel }))}</select>`))}<div data-sum class="deposit-sum"></div></div>`)
        : raw('<div class="empty">No payments are waiting in Undeposited Funds. Sync GoHighLevel or record the payment first, or categorize this line with Add.</div>')}`,
    onSubmit: async (d, form) => {
      const ids = [...form.querySelectorAll('[data-pay]:checked')].map((c) => Number(c.dataset.pay));
      const res = await ctx.capi.post(`/bank/feed/${r.id}/add`, { payment_ids: ids, fee_account_id: form.fee_account_id?.value || null });
      toast(`Deposit recorded${res.fee ? ` with ${money(res.fee)} in fees` : ''}`);
      done();
    },
  });
  const form = m.el;
  const sum = () => {
    const sel = [...form.querySelectorAll('[data-pay]:checked')].reduce((s, c) => s + Number(c.dataset.amt), 0);
    const fee = sel - r.amount;
    const box = form.querySelector('[data-sum]');
    if (box) box.innerHTML = html`<div class="kv"><span>Payments ticked</span><b>${money(sel)}</b></div><div class="kv"><span>Bank received</span><b>${money(r.amount)}</b></div>
      <div class="kv total ${fee < 0 ? 'bad' : ''}"><span>${fee < 0 ? 'Short by (tick more payments)' : fee === 0 ? 'Fees' : 'Fees (difference)'}</span><b>${money(Math.abs(fee))}</b></div>`;
    const ok = sel > 0 && fee >= 0 && (fee === 0 || !!form.fee_account_id?.value);
    form.querySelector('[type=submit]').disabled = !ok;
  };
  on(form, 'change', '[data-pay], [name=fee_account_id]', sum);
  sum();
}

/** Split one bank line across several categories. The lines must add up to the bank amount. */
function splitDialog(ctx, r, { catOpts, vendors, customers, payee, category, done }) {
  const out = r.amount < 0;
  const total = Math.abs(r.amount);
  const lineRow = (l = {}) => html`<tr data-split-line>
    <td><select name="s_account" aria-label="Category">${raw(catOpts(l.account_id))}</select></td>
    <td><input name="s_desc" value="${l.description ?? ''}" placeholder="${r.description}" aria-label="Description"></td>
    <td><input name="s_amount" class="num" inputmode="decimal" value="${l.amount ?? ''}" aria-label="Amount"></td>
    <td><select name="s_customer" data-quick-add="customers" aria-label="Customer">${raw(partyOptions(customers, l.customer_id, 'customers'))}</select></td>
    <td><button type="button" class="icon-btn" data-del-split aria-label="Remove line">🗑</button></td></tr>`;
  const m = modal({
    title: 'Split transaction', wide: true, submitLabel: 'Save split',
    body: html`<div class="split-head"><div><small class="muted">${fmtDate(r.date)}</small><div><b>${r.description}</b></div></div><div class="split-amt ${out ? 'neg' : ''}"><small>${out ? 'Spent' : 'Received'}</small><b>${money(total)}</b></div></div>
      ${raw(field(out ? 'Payee (vendor)' : 'Received from (customer)', html`<select name="payee" data-quick-add="${out ? 'vendors' : 'customers'}" data-prefill="${guessPayee(r.description)}">${raw(partyOptions(out ? vendors : customers, payee, out ? 'vendors' : 'customers'))}</select>`))}
      <div class="table-wrap"><table class="lines"><thead><tr><th>Category</th><th>Description</th><th class="num">Amount</th><th>Customer (optional)</th><th></th></tr></thead>
        <tbody data-split-body>${raw(lineRow({ account_id: category || null, amount: (total / 100).toFixed(2) }) + lineRow())}</tbody></table></div>
      <div class="btn-row"><button type="button" class="btn btn-small" data-add-split>Add line</button><span class="spacer"></span><span data-remaining></span></div>`,
    onSubmit: async (d, form) => {
      const splits = [...form.querySelectorAll('[data-split-line]')].map((tr) => ({
        account_id: tr.querySelector('[name=s_account]').value || null, description: tr.querySelector('[name=s_desc]').value,
        amount: tr.querySelector('[name=s_amount]').value.replace(/[$,]/g, ''), customer_id: ((v) => (v && v !== '__new' ? v : null))(tr.querySelector('[name=s_customer]').value),
      })).filter((s) => s.account_id || s.amount);
      const p = form.payee.value && form.payee.value !== '__new' ? form.payee.value : null;
      await ctx.capi.post(`/bank/feed/${r.id}/add`, { splits, ...(out ? { vendor_id: p } : { customer_id: p }) });
      toast(`Split into ${splits.length} lines and added`);
      done();
    },
  });
  const form = m.el;
  const body = form.querySelector('[data-split-body]');
  const recalc = () => {
    const sum = [...body.querySelectorAll('[name=s_amount]')].reduce((s, i) => s + (Math.round(Number(i.value.replace(/[$,]/g, '')) * 100) || 0), 0);
    const left = total - sum;
    form.querySelector('[data-remaining]').innerHTML = left === 0 ? html`<span class="badge badge-ok">Balanced ✓</span>` : html`<span class="${left < 0 ? 'neg' : ''}">${left > 0 ? 'Left to assign' : 'Over by'} <b>${money(Math.abs(left))}</b></span>`;
    form.querySelector('[type=submit]').disabled = left !== 0;
  };
  on(form, 'click', '[data-add-split]', () => { body.insertAdjacentHTML('beforeend', lineRow()); recalc(); });
  on(form, 'click', '[data-del-split]', (e, btn) => { if (body.children.length > 1) btn.closest('tr').remove(); recalc(); });
  on(form, 'input', '[name=s_amount]', recalc);
  // Moving off an amount: put whatever is left on the next empty line.
  on(form, 'change', '[name=s_amount]', (e, inp) => {
    const rowsEls = [...body.querySelectorAll('[data-split-line]')];
    const sum = rowsEls.reduce((s, tr) => s + (Math.round(Number(tr.querySelector('[name=s_amount]').value.replace(/[$,]/g, '')) * 100) || 0), 0);
    const empty = rowsEls.find((tr) => !tr.querySelector('[name=s_amount]').value);
    if (total - sum > 0 && empty) empty.querySelector('[name=s_amount]').value = ((total - sum) / 100).toFixed(2);
    else if (total - sum > 0 && inp.closest('tr') === rowsEls.at(-1)) { body.insertAdjacentHTML('beforeend', lineRow({ amount: ((total - sum) / 100).toFixed(2) })); }
    recalc();
  });
  wireQuickAdd(ctx, form, { onCreated: (c, table) => { (table === 'vendors' ? vendors : customers).push(c); } });
  recalc();
}

function editRule(ctx, r, accounts, vendors, customers) {
  const feedAccts = accounts.filter((a) => a.type === 'bank' || a.type === 'credit_card');
  const cats = accounts.filter((a) => !['accounts_receivable', 'accounts_payable'].includes(a.type));
  return new Promise((resolve) => { const m = modal({
    title: r.id ? 'Edit rule' : 'Create rule', wide: true, onClose: () => resolve(null),
    body: html`<div class="form-grid">
      ${raw(field('Rule name', html`<input name="name" value="${r.name ?? ''}">`))}
      ${raw(field('Apply to', html`<select name="direction">${raw(options([{ id: 'out', name: 'Money out' }, { id: 'in', name: 'Money in' }, { id: 'any', name: 'Both' }], r.direction ?? 'out'))}</select>`))}
      ${raw(field('Bank account', html`<select name="bank_account_id">${raw(options(feedAccts, r.bank_account_id, { blank: 'All accounts', label: acctLabel }))}</select>`))}
      ${raw(field('Description contains', html`<input name="match_text" required value="${r.match_text ?? ''}">`))}
      ${raw(field('Category', html`<select name="account_id" required>${raw(options(cats, r.account_id, { blank: 'Select category', label: acctLabel, group: (a) => a.type_label }))}</select>`))}
      ${raw(field('Payee (vendor)', html`<select name="vendor_id" data-quick-add="vendors" data-prefill="${r.vendor_id ? '' : guessPayee(r.match_text ?? '')}">${raw(partyOptions(vendors, r.vendor_id, 'vendors'))}</select>`))}
      ${raw(field('Customer', html`<select name="customer_id" data-quick-add="customers">${raw(partyOptions(customers, r.customer_id, 'customers'))}</select>`))}
      ${raw(field('Priority', html`<input name="priority" type="number" value="${r.priority ?? 100}">`, { hint: 'Lower runs first' }))}
      <label class="check span-2"><input type="checkbox" name="auto_add" value="1" ${r.auto_add ? raw('checked') : ''}> Automatically add matching transactions (skip review)</label>
    </div>`,
    onSubmit: async (d) => {
      for (const k of ['vendor_id', 'customer_id']) if (d[k] === '__new') d[k] = '';
      const body = { ...d, auto_add: !!d.auto_add };
      const saved = r.id ? await ctx.capi.put(`/bank/rules/${r.id}`, body) : await ctx.capi.post('/bank/rules', body);
      toast('Rule saved'); resolve(saved);
    },
  }); wireQuickAdd(ctx, m.el); });
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
