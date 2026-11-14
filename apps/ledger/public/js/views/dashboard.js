import { html, raw, money, fmtDate } from '../ui.js';

function barChart(months) {
  const W = 520, H = 180, pad = 28, max = Math.max(1, ...months.flatMap((m) => [m.income, m.expenses]));
  const bw = (W - pad * 2) / months.length;
  const y = (v) => H - 24 - (Math.max(v, 0) / max) * (H - 44);
  const bars = months.map((m, i) => {
    const x = pad + i * bw;
    return html`<g><title>${m.label}: income ${money(m.income)}, expenses ${money(m.expenses)}</title>
      <rect x="${x + bw * 0.14}" y="${y(m.income)}" width="${bw * 0.34}" height="${H - 24 - y(m.income)}" class="bar-income" rx="2"/>
      <rect x="${x + bw * 0.52}" y="${y(m.expenses)}" width="${bw * 0.34}" height="${H - 24 - y(m.expenses)}" class="bar-expense" rx="2"/>
      <text x="${x + bw / 2}" y="${H - 6}" text-anchor="middle" class="axis">${m.label}</text></g>`;
  }).join('');
  return html`<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Income and expenses, last six months">
    <line x1="${pad}" x2="${W - pad}" y1="${H - 24}" y2="${H - 24}" class="baseline"/>${raw(bars)}</svg>
    <div class="legend"><span class="key key-income"></span>Income <span class="key key-expense"></span>Expenses</div>`;
}

export async function view(ctx) {
  ctx.setTitle('Dashboard');
  const [d, due] = await Promise.all([ctx.capi.get('/dashboard'), ctx.capi.get('/recurring/due').catch(() => [])]);
  const h = ctx.chref;
  const maxExp = Math.max(1, ...d.top_expenses.map((e) => e.amt));
  ctx.el.innerHTML = html`<div class="page">
    <div class="page-head"><h1>${ctx.company.name}</h1><span class="muted">Fiscal year to date since ${fmtDate(d.fiscal_year_start)}</span></div>
    ${due.length ? raw(html`<a class="banner banner-warn block-link" href="${ctx.chref('recurring')}">${due.length} recurring transaction${due.length > 1 ? 's are' : ' is'} waiting for you: ${due.map((r) => r.name).slice(0, 3).join(', ')}${due.length > 3 ? '…' : ''} →</a>`) : ''}
    <div class="cards">
      <section class="card">
        <h3>Profit &amp; loss <small>year to date</small></h3>
        <div class="big-number ${d.ytd.net < 0 ? 'neg' : ''}">${money(d.ytd.net)}</div>
        <div class="kv"><span>Income</span><b>${money(d.ytd.income)}</b></div>
        <div class="kv"><span>Expenses</span><b>${money(d.ytd.expenses)}</b></div>
        <a href="${h('reports/profit_and_loss')}" class="card-link">View P&amp;L →</a>
      </section>
      <section class="card">
        <h3>Invoices <small>receivable</small></h3>
        <div class="big-number">${money(d.ar.open)}</div>
        <div class="kv"><span>${d.ar.count} open</span><b></b></div>
        <div class="kv ${d.ar.overdue ? 'bad' : ''}"><span>${d.ar.overdue_count} overdue</span><b>${money(d.ar.overdue)}</b></div>
        <a href="${h('reports/ar_aging')}" class="card-link">A/R aging →</a>
      </section>
      <section class="card">
        <h3>Bills <small>payable</small></h3>
        <div class="big-number">${money(d.ap.open)}</div>
        <div class="kv"><span>Due in 7 days</span><b>${money(d.ap.due_soon)}</b></div>
        <div class="kv ${d.ap.overdue ? 'bad' : ''}"><span>${d.ap.overdue_count} overdue</span><b>${money(d.ap.overdue)}</b></div>
        <a href="${h('new/bill_payment')}" class="card-link">Pay bills →</a>
      </section>
      <section class="card">
        <h3>Bank accounts</h3>
        ${d.banks.length ? raw(d.banks.map((b) => html`<a class="bank-row" href="${h('banking')}?account=${b.id}"><span>${b.name}${b.to_review ? raw(html` <span class="badge badge-warn">${b.to_review} to review</span>`) : ''}<small>${b.last_reconciled ? `Reconciled through ${fmtDate(b.last_reconciled)}` : 'Never reconciled'}</small></span><b class="${b.balance < 0 ? 'neg' : ''}">${money(b.balance)}</b></a>`).join('')) : raw('<p class="muted">No bank accounts.</p>')}
        ${d.undeposited ? raw(html`<a class="bank-row" href="${h('new/deposit')}"><span>Undeposited funds<small>Ready to deposit</small></span><b>${money(d.undeposited)}</b></a>`) : ''}
        <a href="${h('banking')}" class="card-link">Go to banking →</a>
      </section>
      <section class="card span-2">
        <h3>Income vs. expenses <small>last 6 months</small></h3>
        ${raw(barChart(d.months))}
      </section>
      <section class="card span-2">
        <h3>Top expenses <small>year to date</small></h3>
        ${d.top_expenses.length ? raw(d.top_expenses.map((e) => html`<div class="hbar"><span>${e.name}</span><div class="hbar-track"><div class="hbar-fill" style="width:${Math.round((e.amt / maxExp) * 100)}%"></div></div><b>${money(e.amt)}</b></div>`).join('')) : raw('<p class="muted">No expenses recorded yet.</p>')}
      </section>
    </div>
  </div>`;
}
