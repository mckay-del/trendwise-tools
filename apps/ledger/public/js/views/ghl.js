import { html, raw, esc, money, fmtDate, on, toast, confirmDialog, dataTable, field, options, fmtStamp } from '../ui.js';

const usd = (n) => money(Math.round(Number(n) * 100));

export async function view(ctx) {
  ctx.setTitle('GoHighLevel sync');
  const [conn, accounts] = await Promise.all([ctx.capi.get('/ghl'), ctx.capi.accounts()]);
  const connected = !!conn.location_id;
  const canEdit = ['admin', 'accountant'].includes(ctx.user.role);
  const income = accounts.filter((a) => a.type === 'income');
  const r = conn.last_result;
  ctx.el.innerHTML = html`<div class="page narrow">
    <div class="page-head"><h1>GoHighLevel sync</h1>${connected ? raw(html`<span class="badge ${conn.schedule === 'manual' ? 'badge-muted' : 'badge-ok'}">Connected · ${{ manual: 'syncs when you click Sync now', daily: 'syncs nightly', hourly: 'syncs hourly' }[conn.schedule]}</span>`) : ''}</div>
    <p class="muted">Brings this client's GHL <b>invoices</b> and <b>payments</b> (Stripe) into the books automatically: invoices become invoices (A/R), payments are applied to them and land in <b>Undeposited Funds</b>, and funnel or order payments become sales receipts. Read-only: nothing is ever changed in GHL.</p>

    ${connected ? raw(html`<section class="card">
      <h3>Status</h3>
      <div class="kv"><span>Last sync</span><b>${conn.last_sync_at ? fmtStamp(conn.last_sync_at) + ' ' + new Date(conn.last_sync_at.replace(' ', 'T') + 'Z').toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'Not yet'}</b></div>
      ${r ? raw(html`<div class="kv"><span>Invoices</span><b>${r.invoices.created} added · ${r.invoices.updated} updated · ${r.invoices.voided} voided</b></div>
        <div class="kv"><span>Payments</span><b>${r.payments.created} added · ${r.payments.refunds} refunds</b></div>`) : ''}
      ${conn.last_error ? raw(html`<div class="form-error">${conn.last_error}</div>`) : ''}
      <div class="btn-row" style="margin-top:.8rem">
        <button class="btn" data-action="test">Test connection</button>
        <button class="btn" data-action="preview">Preview sync</button>
        <button class="btn btn-primary" data-action="sync">Sync now</button>
      </div>
      <div data-out></div>
    </section>
    ${conn.issues?.length ? raw(html`<section class="card"><h3>Needs attention <small>${conn.issues.length}</small></h3>
      <ul class="issue-list">${raw(conn.issues.map((i) => html`<li><span>${i.message}</span><small class="muted">${fmtStamp(i.at)}</small><button class="link" data-dismiss="${i.id}">Dismiss</button></li>`).join(''))}</ul>
      <p class="muted small">Errors clear automatically when a later sync succeeds (for example after you fix the closing date). Notes stay until you dismiss them.</p></section>`) : ''}`) : ''}

    <section class="card">
      <h3>${connected ? 'Connection settings' : 'Connect this client'}</h3>
      ${connected ? '' : raw(html`<ol class="steps">
        <li>In GHL, switch to this client's <b>sub-account</b>.</li>
        <li>Go to <b>Settings → Business Profile</b> and copy the <b>Location ID</b>.</li>
        <li>Go to <b>Settings → Private Integrations → Create new integration</b>. Name it "Trendwise Ledger" and give it only these two read-only scopes:
          <code>invoices.readonly</code> (view invoices) and <code>payments/transactions.readonly</code> (view payment transactions). Copy the key it shows; GHL displays it only once.</li>
        <li>Paste both below, choose the start date, then <b>Preview sync</b> before the first real sync.</li>
      </ol>`)}
      <form class="form-grid" data-form="conn">
        ${raw(field('GHL Location ID', html`<input name="location_id" value="${conn.location_id ?? ''}" required ${canEdit ? '' : raw('disabled')} autocomplete="off">`))}
        ${raw(field(connected ? 'Private Integration key (leave blank to keep)' : 'Private Integration key', html`<input name="token" type="password" placeholder="${conn.token_hint ?? 'pit-…'}" ${connected ? '' : raw('required')} ${canEdit ? '' : raw('disabled')} autocomplete="off">`))}
        ${raw(field('Bring in GHL activity from', html`<input type="date" name="start_date" value="${conn.start_date ?? ''}" ${canEdit ? '' : raw('disabled')}>`, { hint: 'Usually the day after your opening balances (cutover). Earlier GHL invoices are skipped so A/R isn\'t counted twice.' }))}
        ${raw(field('Income account for GHL items', html`<select name="income_account_id" ${canEdit ? '' : raw('disabled')}>${raw(options(income, conn.income_account_id, { blank: 'First income account', label: (a) => `${a.number ? a.number + ' ' : ''}${a.name}` }))}</select>`, { hint: 'GHL products become Products & Services using this account; change any product later.' }))}
        ${raw(field('Sync automatically', html`<select name="schedule" ${canEdit ? '' : raw('disabled')}>${raw(options([{ id: 'daily', name: 'Daily (overnight, about 1–5 AM)' }, { id: 'hourly', name: 'Every hour' }, { id: 'manual', name: 'Only when I click Sync now' }], conn.schedule ?? 'daily'))}</select>`, { hint: 'The month-end close checklist also reminds you to sync after month end.' }))}
        ${canEdit ? raw(html`<div class="span-2 btn-row"><button class="btn btn-primary">${connected ? 'Save settings' : 'Connect'}</button>${connected ? raw('<button type="button" class="btn btn-ghost danger" data-action="disconnect">Disconnect</button>') : ''}</div>`) : raw('<p class="muted span-2">Only admins and accountants can change the connection.</p>')}
      </form>
    </section>

    <section class="card"><h3>How the money flows</h3>
      <ol class="steps muted">
        <li>A client pays a GHL invoice by card → it appears here as a <b>payment</b> on that invoice, sitting in <b>Undeposited Funds</b>.</li>
        <li>Stripe pays out a few days later, minus its fee → the payout shows up in <b>Banking</b>.</li>
        <li>Make a <b>Bank deposit</b> for that payout: tick the payments it includes and add a line for the Stripe fee (account <i>Bank Charges &amp; Fees</i>, negative amount). Then <b>Match</b> it in Banking. (Automating this step from Stripe is planned next.)</li>
      </ol>
    </section>
  </div>`;

  const out = () => ctx.el.querySelector('[data-out]');
  const busy = (b, on) => { b.disabled = on; b.dataset.label ??= b.textContent; b.textContent = on ? 'Working…' : b.dataset.label; };

  on(ctx.el, 'submit', '[data-form=conn]', async (e, f) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(f));
    const body = { location_id: d.location_id, start_date: d.start_date, income_account_id: d.income_account_id || null, ...(d.token ? { token: d.token } : {}), schedule: d.schedule };
    try { await ctx.capi.put('/ghl', body); toast(connected ? 'Saved' : 'Connected. Run a Preview next.'); ctx.reload(); } catch (ex) { toast(ex.message, 'error'); }
  });
  on(ctx.el, 'click', '[data-action=test]', async (e, b) => {
    busy(b, true);
    try {
      const t = await ctx.capi.post('/ghl/test');
      out().innerHTML = html`<div class="banner ${t.invoices.ok && t.payments.ok ? 'banner-ok' : 'banner-warn'}">
        Invoices: ${t.invoices.ok ? `✓ can read (${t.invoices.total} in GHL)` : `✗ ${t.invoices.error}`}<br>
        Payments: ${t.payments.ok ? `✓ can read (${t.payments.total} transactions)` : `✗ ${t.payments.error}`}</div>`;
    } catch (ex) { out().innerHTML = html`<div class="form-error">${ex.message}</div>`; } finally { busy(b, false); }
  });
  const showRun = (res) => {
    const s = res.stats;
    const rows = res.preview.filter((p) => p.action !== 'unchanged');
    out().innerHTML = html`<div class="banner ${res.dry_run ? 'banner-info' : 'banner-ok'}">${res.dry_run ? raw('<b>Preview only</b> — nothing was saved.') : 'Sync complete.'}
      Fetched ${s.fetched.invoices} invoices and ${s.fetched.payments} payments from GHL. ${s.invoices.created} invoices to add, ${s.invoices.updated} to update, ${s.invoices.voided} to void; ${s.payments.created} payments, ${s.payments.refunds} refunds; ${s.customers} new customers${s.issues ? `; ${s.issues} need attention` : ''}. Skipped ${s.invoices.skipped + s.payments.skipped} (drafts, test mode, failed payments, or before the start date).</div>
      ${raw(dataTable(rows, [
        { key: 'kind', label: 'What', render: (p) => esc(p.label) }, { key: 'who', label: 'Customer' }, { key: 'date', label: 'Date', type: 'date' },
        { key: 'total', label: 'Amount', type: 'money', render: (p) => esc(usd(p.total)) },
        { key: 'action', label: '', render: (p) => (p.action === 'problem' ? html`<span class="badge badge-bad" title="${p.note ?? ''}">Problem</span> <small>${p.note ?? ''}</small>` : html`<span class="badge badge-info">${p.action === 'create' ? 'Add' : p.action === 'update' ? 'Update' : 'Void'}</span>${p.note ? raw(html` <small class="muted">${p.note}</small>`) : ''}`) },
      ], { empty: 'Everything is already up to date.' }))}`;
  };
  on(ctx.el, 'click', '[data-action=preview]', async (e, b) => {
    busy(b, true);
    try { showRun(await ctx.capi.post('/ghl/sync', { dryRun: true })); } catch (ex) { out().innerHTML = html`<div class="form-error">${ex.message}</div>`; } finally { busy(b, false); }
  });
  on(ctx.el, 'click', '[data-action=sync]', async (e, b) => {
    busy(b, true);
    try { const res = await ctx.capi.post('/ghl/sync', {}); toast('Sync complete'); ctx.state.capi?.invalidate?.(); await ctx.reload(); setTimeout(() => showRun(res), 50); } catch (ex) { out().innerHTML = html`<div class="form-error">${ex.message}</div>`; busy(b, false); }
  });
  on(ctx.el, 'click', '[data-dismiss]', async (e, b) => { await ctx.capi.del(`/ghl/issues/${b.dataset.dismiss}`); ctx.reload(); });
  on(ctx.el, 'click', '[data-action=disconnect]', async () => {
    if (!(await confirmDialog('Disconnect GHL for this client? Invoices and payments already brought in stay in the books. Delete the Private Integration in GHL too.', { okLabel: 'Disconnect' }))) return;
    await ctx.capi.del('/ghl'); toast('Disconnected'); ctx.reload();
  });
  void fmtDate;
}
