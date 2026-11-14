import { html, raw, on, toast, confirmDialog, fmtDate } from '../ui.js';
import { refreshCompany } from '../app.js';

const monthName = (p) => new Date(`${p}-01T00:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
const icon = (s) => ({ ok: '<span class="ck ok" aria-label="Done">✓</span>', todo: '<span class="ck todo" aria-label="To do">!</span>', warn: '<span class="ck warn" aria-label="Check">i</span>' }[s]);

export async function view(ctx) {
  const s = await ctx.capi.get('/close', { period: ctx.query.period });
  ctx.setTitle(`Close ${monthName(s.period)}`);
  const canClose = ['admin', 'accountant'].includes(ctx.user.role);
  const pct = Math.round((s.progress.done / s.progress.total) * 100);
  ctx.el.innerHTML = html`<div class="page close-page">
    <div class="page-head">
      <h1>Month-end close</h1>
      <div class="btn-row month-nav">
        <a class="btn btn-ghost" href="${ctx.chref('close')}?period=${s.prev}">‹ ${monthName(s.prev)}</a>
        <strong>${monthName(s.period)}</strong>
        <a class="btn btn-ghost" href="${ctx.chref('close')}?period=${s.next}">${monthName(s.next)} ›</a>
      </div>
    </div>
    <div class="close-summary card">
      <div><small>Status</small><b>${s.closed ? 'Closed' : s.ready ? 'Ready to close' : 'In progress'}</b></div>
      <div class="progress-wrap"><small>${s.progress.done} of ${s.progress.total} done</small><div class="progress"><div style="width:${pct}%"></div></div></div>
      <div><small>Books closed through</small><b>${s.closing_date ? fmtDate(s.closing_date) : 'Not closed'}</b></div>
    </div>
    ${s.closed ? raw(html`<div class="banner banner-ok">${monthName(s.period)} is closed. Nothing dated on or before ${fmtDate(s.closing_date)} can be added or changed.${canClose && s.closing_date === s.end ? raw(' <button class="link" data-action="reopen">Reopen this month</button>') : ''}</div>`) : ''}

    <section class="card"><h3>Checked automatically</h3>
      <ul class="checklist">${raw(s.items.map((i) => html`<li class="${i.status}">${raw(icon(i.status))}<div><b>${i.title}</b>${!i.required ? raw(' <small class="muted">(advisory)</small>') : ''}
        ${i.detail.length ? raw(html`<ul class="detail">${raw(i.detail.map((d) => html`<li class="${d.ok ? 'ok' : ''}">${d.link ? raw(html`<a href="${ctx.chref(d.link)}">${d.text}</a>`) : d.text}</li>`).join(''))}</ul>`) : ''}</div></li>`).join(''))}</ul>
    </section>

    <section class="card"><h3>Your review</h3>
      <ul class="checklist manual">${raw(s.manual.map((m) => html`<li class="${m.done ? 'ok' : 'todo'}"><label class="check"><input type="checkbox" data-check="${m.key}" ${m.done ? raw('checked') : ''} ${s.closed ? raw('disabled') : ''}> <span><b>${m.title}</b>${m.hint ? raw(html`<br><small class="muted">${m.hint}</small>`) : ''}${m.done && m.by ? raw(html`<br><small class="muted">✓ ${m.by}, ${new Date(m.at).toLocaleDateString()}</small>`) : ''}</span></label></li>`).join(''))}</ul>
      <div class="btn-row quick-links">
        <a class="btn btn-small" href="${ctx.chref('reports/profit_and_loss')}?from=${s.start}&to=${s.end}&compare=prior_period">P&amp;L vs last month</a>
        <a class="btn btn-small" href="${ctx.chref('reports/balance_sheet')}?asof=${s.end}&compare=prior_period">Balance Sheet</a>
        <a class="btn btn-small" href="${ctx.chref('reports/ar_aging')}?asof=${s.end}">A/R aging</a>
        <a class="btn btn-small" href="${ctx.chref('reports/ap_aging')}?asof=${s.end}">A/P aging</a>
        <a class="btn btn-small" href="${ctx.chref('package')}">Client report package</a>
      </div>
      <label class="field"><span>Notes for this month</span><textarea data-notes rows="3" placeholder="e.g. Waiting on client for two receipts; reclassified $300 from meals to supplies." ${s.closed ? raw('disabled') : ''}>${s.notes}</textarea></label>
    </section>

    ${!s.closed ? raw(html`<div class="close-actions">
      ${canClose ? raw(html`<button class="btn btn-primary" data-action="close">Close ${monthName(s.period)}</button>`) : raw('<span class="muted">An admin or accountant closes the month.</span>')}
      <span class="muted">Closing sets the books' closing date to ${fmtDate(s.end)} so nothing in the month can change by accident. You can reopen it.</span>
    </div>`) : ''}
  </div>`;

  on(ctx.el, 'change', '[data-check]', async (e, cb) => {
    try { await ctx.capi.put(`/close/${s.period}`, { checks: { [cb.dataset.check]: cb.checked } }); ctx.reload(); } catch (ex) { toast(ex.message, 'error'); cb.checked = !cb.checked; }
  });
  let t;
  on(ctx.el, 'input', '[data-notes]', (e, ta) => { clearTimeout(t); t = setTimeout(() => ctx.capi.put(`/close/${s.period}`, { notes: ta.value }).then(() => toast('Notes saved')).catch((ex) => toast(ex.message, 'error')), 800); });
  on(ctx.el, 'click', '[data-action=close]', async () => {
    const open = [...s.items.filter((i) => i.required && i.status !== 'ok').map((i) => i.title), ...s.manual.filter((m) => !m.done).map((m) => m.title)];
    const msg = open.length
      ? `${open.length} item${open.length > 1 ? 's are' : ' is'} still open:\n• ${open.join('\n• ')}\n\nClose ${monthName(s.period)} anyway?`
      : `Close ${monthName(s.period)}? Transactions dated on or before ${fmtDate(s.end)} will be locked.`;
    if (!(await confirmDialog(msg, { title: `Close ${monthName(s.period)}`, okLabel: open.length ? 'Close anyway' : 'Close month', danger: !!open.length }))) return;
    try { await ctx.capi.post(`/close/${s.period}/close`, { override: !!open.length }); toast(`${monthName(s.period)} closed`); await refreshCompany(); } catch (ex) { toast(ex.message, 'error'); }
  });
  on(ctx.el, 'click', '[data-action=reopen]', async () => {
    if (!(await confirmDialog(`Reopen ${monthName(s.period)}? Transactions in the month can be changed again.`, { okLabel: 'Reopen' }))) return;
    try { await ctx.capi.post(`/close/${s.period}/reopen`); toast('Month reopened'); await refreshCompany(); } catch (ex) { toast(ex.message, 'error'); }
  });
}
