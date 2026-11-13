// Shared UI helpers. No inline event handlers anywhere (CSP forbids them) — use delegation.

export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Tagged template that escapes interpolations unless wrapped with raw(). */
export function html(strings, ...vals) {
  return strings.reduce((out, s, i) => out + s + (i < vals.length ? toHtml(vals[i]) : ''), '');
}
const RAW = Symbol('raw');
export const raw = (s) => ({ [RAW]: true, s: String(s) });
function toHtml(v) {
  if (v === null || v === undefined || v === false) return '';
  if (Array.isArray(v)) return v.map(toHtml).join('');
  if (typeof v === 'object' && v[RAW]) return v.s;
  return esc(v);
}

export const money = (c, { blankZero = false, sign = true } = {}) => {
  if (c === null || c === undefined || c === '') return '';
  if (blankZero && !c) return '';
  const s = (Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return c < 0 && sign ? `-$${s}` : `$${s}`;
};
export const num = (c) => (c === null || c === undefined ? '' : (c / 100).toFixed(2));
export const parseMoney = (s) => {
  const t = String(s ?? '').replace(/[$,\s]/g, '');
  if (t === '') return 0;
  const neg = /^\(.*\)$/.test(t);
  const n = Number(t.replace(/[()]/g, ''));
  return Number.isFinite(n) ? Math.round((neg ? -n : n) * 100) : NaN;
};
export const fmtDate = (iso) => {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${m}/${d}/${y}`;
};
export const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

export function $(sel, root = document) { return root.querySelector(sel); }
export function $$(sel, root = document) { return [...root.querySelectorAll(sel)]; }

/** Delegate events: on(root, 'click', '[data-action=save]', fn) */
export function on(root, event, selector, fn) {
  const h = (e) => { const t = e.target.closest(selector); if (t && root.contains(t)) fn(e, t); };
  root.addEventListener(event, h);
  return () => root.removeEventListener(event, h);
}

// --- Toasts ---------------------------------------------------------------
export function toast(msg, kind = 'ok') {
  let host = $('#toasts');
  if (!host) { host = document.createElement('div'); host.id = 'toasts'; document.body.append(host); }
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.textContent = msg;
  host.append(el);
  setTimeout(() => el.classList.add('out'), kind === 'error' ? 6000 : 3000);
  setTimeout(() => el.remove(), kind === 'error' ? 6500 : 3500);
}

// --- Modals ---------------------------------------------------------------
/** Open a modal. `body` is HTML. Returns { el, close }. onSubmit(formData, el) may return false to keep it open. */
export function modal({ title, body, submitLabel = 'Save', onSubmit, wide = false, cancelLabel = 'Cancel', danger = false }) {
  const prev = document.activeElement;
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop';
  wrap.innerHTML = html`<form class="modal ${wide ? 'modal-wide' : ''}" role="dialog" aria-modal="true" aria-label="${title}" novalidate>
    <header><h2>${title}</h2><button type="button" class="icon-btn" data-close aria-label="Close">×</button></header>
    <div class="modal-body">${raw(body)}</div>
    <div class="form-error" hidden></div>
    <footer>${onSubmit ? raw(html`<button type="button" class="btn" data-close>${cancelLabel}</button><button type="submit" class="btn ${danger ? 'btn-danger' : 'btn-primary'}">${submitLabel}</button>`) : raw('<button type="button" class="btn btn-primary" data-close>Close</button>')}</footer>
  </form>`;
  document.body.append(wrap);
  const form = wrap.querySelector('form');
  const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey); prev?.focus?.(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); });
  on(wrap, 'click', '[data-close]', close);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!onSubmit) return close();
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      const r = await onSubmit(Object.fromEntries(new FormData(form)), form);
      if (r !== false) close();
    } catch (err) {
      const box = form.querySelector('.form-error');
      box.textContent = err.message; box.hidden = false;
    } finally { btn.disabled = false; }
  });
  setTimeout(() => (form.querySelector('[autofocus]') ?? form.querySelector('input,select,textarea'))?.focus(), 0);
  return { el: form, close };
}

export function confirmDialog(message, { title = 'Are you sure?', okLabel = 'OK', danger = true } = {}) {
  return new Promise((resolve) => {
    let ok = false;
    const m = modal({ title, body: html`<p>${message}</p>`, submitLabel: okLabel, danger, onSubmit: () => { ok = true; } });
    const obs = new MutationObserver(() => { if (!document.body.contains(m.el)) { obs.disconnect(); resolve(ok); } });
    obs.observe(document.body, { childList: true });
  });
}

// --- Form controls ----------------------------------------------------------
export function options(list, selected, { blank = null, value = (o) => o.id, label = (o) => o.name, group = null } = {}) {
  const sel = selected === null || selected === undefined ? '' : String(selected);
  let out = blank !== null ? html`<option value="">${blank}</option>` : '';
  if (group) {
    const groups = new Map();
    for (const o of list) { const g = group(o); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(o); }
    for (const [g, items] of groups) out += html`<optgroup label="${g}">${raw(items.map((o) => html`<option value="${value(o)}" ${String(value(o)) === sel ? raw('selected') : ''}>${label(o)}</option>`).join(''))}</optgroup>`;
    return out;
  }
  return out + list.map((o) => html`<option value="${value(o)}" ${String(value(o)) === sel ? raw('selected') : ''}>${label(o)}</option>`).join('');
}

export function field(label, control, { hint = '', cls = '' } = {}) {
  return html`<label class="field ${cls}"><span>${label}</span>${raw(control)}${hint ? raw(html`<small>${hint}</small>`) : ''}</label>`;
}

export const badge = (label) => {
  const k = { Paid: 'ok', Closed: 'ok', Deposited: 'ok', Posted: 'ok', Overdue: 'bad', Voided: 'muted', Partial: 'warn', Open: 'info', Unapplied: 'warn', Undeposited: 'warn' }[label] ?? 'info';
  return html`<span class="badge badge-${k}">${label}</span>`;
};

/** Simple sortable/filterable table. cols: [{key, label, type:'money'|'date'|'text', render?(row)}] */
export function dataTable(rows, cols, { rowAttrs = () => '', empty = 'Nothing here yet.', footer = null } = {}) {
  if (!rows.length) return html`<div class="empty">${empty}</div>`;
  return html`<div class="table-wrap"><table class="grid">
    <thead><tr>${raw(cols.map((c) => html`<th class="${c.type === 'money' ? 'num' : ''}">${c.label}</th>`).join(''))}</tr></thead>
    <tbody>${raw(rows.map((r) => html`<tr ${raw(rowAttrs(r))}>${raw(cols.map((c) => html`<td class="${c.type === 'money' ? 'num' : ''} ${c.cls ?? ''}">${raw(c.render ? c.render(r) : c.type === 'money' ? esc(money(r[c.key])) : c.type === 'date' ? esc(fmtDate(r[c.key])) : esc(r[c.key] ?? ''))}</td>`).join(''))}</tr>`).join(''))}</tbody>
    ${footer ? raw(`<tfoot>${footer}</tfoot>`) : ''}
  </table></div>`;
}

export function debounce(fn, ms = 250) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

export function download(filename, text, type = 'text/csv') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
