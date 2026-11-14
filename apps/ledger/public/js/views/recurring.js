import { html, raw, esc, fmtDate, on, toast, confirmDialog, dataTable, modal, options, field } from '../ui.js';

const FREQ = { weekly: 'week', monthly: 'month', quarterly: 'quarter', yearly: 'year' };
const every = (r) => (r.interval_n > 1 ? `Every ${r.interval_n} ${FREQ[r.frequency]}s` : `Every ${FREQ[r.frequency]}`)
  + (r.frequency !== 'weekly' && r.day_of_month ? ` on the ${r.day_of_month === 31 ? 'last day' : ordinal(r.day_of_month)}` : '');
const ordinal = (n) => n + (['th', 'st', 'nd', 'rd'][(n % 100 > 10 && n % 100 < 14) ? 0 : n % 10] ?? 'th');
const TYPES = [['invoice', 'Invoice'], ['sales_receipt', 'Sales receipt'], ['bill', 'Bill'], ['expense', 'Expense'], ['check', 'Check'], ['deposit', 'Bank deposit'], ['transfer', 'Transfer'], ['journal_entry', 'Journal entry']];

export async function list(ctx) {
  ctx.setTitle('Recurring transactions');
  const rows = await ctx.capi.get('/recurring');
  const attention = rows.filter((r) => r.is_due && (r.mode === 'reminder' || r.last_error));
  const status = (r) => {
    if (!r.is_active) return html`<span class="badge badge-muted">${r.end_date && r.next_date > r.end_date ? 'Finished' : 'Paused'}</span>`;
    if (r.last_error) return html`<span class="badge badge-bad" title="${r.last_error}">Needs attention</span>`;
    if (r.is_due && r.mode === 'reminder') return html`<span class="badge badge-warn">Due</span>`;
    return html`<span class="badge badge-ok">${r.mode === 'auto' ? 'Automatic' : 'Reminder'}</span>`;
  };
  ctx.el.innerHTML = html`<div class="page">
    <div class="page-head"><h1>Recurring transactions</h1><div class="btn-row"><button class="btn btn-primary" data-action="new">New recurring transaction</button></div></div>
    <p class="muted">Templates that repeat on a schedule: retainers, rent, subscriptions, loan payments, monthly depreciation. <b>Automatic</b> ones are created on their date (checked every hour); <b>reminders</b> wait here for you to create or skip. Tip: open any saved transaction and click <b>Make recurring</b>.</p>
    ${attention.length ? raw(html`<div class="banner banner-warn">${attention.length} recurring transaction${attention.length > 1 ? 's need' : ' needs'} attention below.</div>`) : ''}
    ${raw(dataTable(rows, [
      { key: 'name', label: 'Name', render: (r) => html`<a href="${ctx.chref('recurring/' + r.id)}"><strong>${r.name}</strong></a>${r.last_error ? raw(html`<br><small class="neg">${r.last_error}</small>`) : ''}` },
      { key: 'type_label', label: 'Type' }, { key: 'payee', label: 'Name / payee' },
      { key: 'amount', label: 'Amount', type: 'money' },
      { key: 'every', label: 'Schedule', render: (r) => esc(every(r) + (r.end_date ? ` until ${fmtDate(r.end_date)}` : '')) },
      { key: 'next_date', label: 'Next', type: 'date', render: (r) => (r.is_active ? esc(fmtDate(r.next_date)) : '—') },
      { key: 'last', label: 'Last created', render: (r) => (r.last_run?.status === 'created' && r.last_run.transaction_id ? html`<a href="${ctx.chref('txn/' + r.last_run.transaction_id)}">${fmtDate(r.last_run.scheduled_date)}</a>` : r.last_run ? esc(`${r.last_run.status} ${fmtDate(r.last_run.scheduled_date)}`) : '') },
      { key: 'status', label: 'Status', render: status },
      { key: 'a', label: '', render: (r) => html`<span class="nowrap">${r.is_active ? raw(html`<button class="link" data-create="${r.id}">Create now</button> · <button class="link" data-skip="${r.id}">Skip next</button> · `) : ''}<button class="link" data-toggle="${r.id}">${r.is_active ? 'Pause' : 'Resume'}</button></span>` },
    ], { empty: 'No recurring transactions yet. Open a saved invoice, bill, expense, check, transfer or journal entry and click “Make recurring”, or click New recurring transaction.' }))}
  </div>`;

  const byId = (id) => rows.find((r) => r.id === Number(id));
  on(ctx.el, 'click', '[data-action=new]', () => modal({
    title: 'New recurring transaction', submitLabel: 'Continue',
    body: field('Type of transaction', html`<select name="type">${raw(options(TYPES.map(([id, name]) => ({ id, name })), 'expense'))}</select>`),
    onSubmit: (d) => { ctx.navigate(ctx.cpath('recurring/new'), { type: d.type }); },
  }));
  on(ctx.el, 'click', '[data-create]', async (e, b) => {
    const r = byId(b.dataset.create);
    if (!(await confirmDialog(`Create “${r.name}” now, dated ${fmtDate(r.next_date)}? The schedule then moves to the following date.`, { okLabel: 'Create', danger: false }))) return;
    try { const t = await ctx.capi.post(`/recurring/${r.id}/create`); toast(`Created ${ctx.meta.txn_types[t.type].label.toLowerCase()} ${t.number ?? ''}`); ctx.reload(); } catch (ex) { toast(ex.message, 'error'); }
  });
  on(ctx.el, 'click', '[data-skip]', async (e, b) => {
    const r = byId(b.dataset.skip);
    if (!(await confirmDialog(`Skip the ${fmtDate(r.next_date)} occurrence of “${r.name}”?`, { okLabel: 'Skip it', danger: false }))) return;
    try { const x = await ctx.capi.post(`/recurring/${r.id}/skip`); toast(`Skipped. Next: ${fmtDate(x.next_date)}`); ctx.reload(); } catch (ex) { toast(ex.message, 'error'); }
  });
  on(ctx.el, 'click', '[data-toggle]', async (e, b) => {
    const r = byId(b.dataset.toggle);
    try { await ctx.capi.put(`/recurring/${r.id}`, { is_active: !r.is_active }); toast(r.is_active ? 'Paused' : 'Resumed'); ctx.reload(); } catch (ex) { toast(ex.message, 'error'); }
  });
}
