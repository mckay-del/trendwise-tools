import { api } from '../api.js';
import { html, raw, on, $, $$, modal, field, options, toast, confirmDialog, fmtDate, addDays } from '../ui.js';
import { APP_NAME } from '../app.js';

const SOURCE_ICON = { email: '✉', event: '◷', gtask: '✓' };

export async function view(ctx) {
  document.title = APP_NAME;
  const columns = ctx.state.meta.columns;
  let data;

  async function load() {
    data = await api.get('/api/board');
    draw();
  }

  function card(t) {
    const overdue = t.due_date && t.due_date < data.today;
    const dueLabel = !t.due_date ? '' : t.due_date === data.today ? 'Today' : t.due_date === addDays(data.today, 1) ? 'Tomorrow' : fmtDate(t.due_date);
    return html`<article class="tb-card" draggable="true" data-id="${t.id}" tabindex="0" aria-label="${t.title}">
      <button class="tb-check" data-action="done" aria-label="Mark done" title="Mark done"></button>
      <div class="tb-card-body" data-action="edit">
        <div class="tb-title">${t.title}</div>
        <div class="tb-meta">
          ${dueLabel ? raw(html`<span class="tb-due ${overdue ? 'overdue' : ''}">${overdue ? 'Overdue · ' : ''}${dueLabel}</span>`) : ''}
          ${t.account_email ? raw(html`<span class="tb-acct" style="--acct:${t.account_color}">${t.account_email.split('@')[1]}</span>`) : ''}
          ${t.source_link ? raw(html`<a class="tb-src" href="${t.source_link}" target="_blank" rel="noopener noreferrer" title="Open the ${t.source_kind}">${SOURCE_ICON[t.source_kind] ?? '↗'}</a>`) : ''}
          ${t.pinned ? raw('<span class="tb-pin" title="Placed by you. The agent won\'t move it.">●</span>') : ''}
        </div>
        ${t.ai_reason ? raw(html`<div class="tb-reason">${t.ai_reason}</div>`) : ''}
      </div>
    </article>`;
  }

  function draw() {
    const counts = Object.fromEntries(data.columns.map((c) => [c.id, c.tasks.length]));
    ctx.el.innerHTML = html`
      <div class="tb-toolbar">
        <h1>Board</h1>
        <span class="muted">${new Date(data.today + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</span>
        <span class="spacer"></span>
        <button class="btn btn-primary" data-action="new">＋ New task</button>
      </div>
      <div class="tb-board">
        ${raw(data.columns.map((c) => html`<section class="tb-col" data-col="${c.id}" aria-label="${c.label}">
          <header><h2>${c.label}</h2><span class="tb-count">${counts[c.id]}</span><button class="icon-btn" data-action="new" data-col="${c.id}" aria-label="Add a task to ${c.label}">＋</button></header>
          <div class="tb-list">${raw(c.tasks.length ? c.tasks.map(card).join('') : '<p class="tb-empty">Nothing here</p>')}</div>
        </section>`).join(''))}
      </div>
      <details class="tb-done" ${data.done.length ? '' : raw('hidden')}>
        <summary>Done <span class="tb-count">${data.done.length}</span></summary>
        <ul>${raw(data.done.map((t) => html`<li><button class="link" data-action="reopen" data-id="${t.id}" title="Move back to the board">↺</button> <s>${t.title}</s> <small class="muted">${t.completed_at ? new Date(t.completed_at).toLocaleDateString() : ''}</small></li>`).join(''))}</ul>
      </details>`;
  }

  const find = (id) => data.columns.flatMap((c) => c.tasks).find((t) => t.id === Number(id));
  const save = async (id, body, msg) => { await api.put(`/api/tasks/${id}`, body); if (msg) toast(msg); await load(); };

  function editor(t, col) {
    const isNew = !t;
    const m = modal({
      title: isNew ? 'New task' : 'Edit task',
      body: html`<div class="stack">
        ${raw(field('Task', html`<input name="title" required maxlength="300" autofocus value="${t?.title ?? ''}">`))}
        <div class="grid-2">
          ${raw(field('Column', html`<select name="col">${raw(options(columns, t?.col ?? col ?? '', { blank: isNew && !col ? 'Pick from the due date' : null, label: (c) => c.label }))}</select>`))}
          ${raw(field('Due date', html`<input name="due_date" type="date" value="${t?.due_date ?? ''}">`))}
        </div>
        ${raw(field('Notes', html`<textarea name="notes" rows="4" maxlength="5000">${t?.notes ?? ''}</textarea>`))}
        ${!isNew ? raw(html`<div class="btn-row"><button type="button" class="btn btn-small" data-action="dismiss">Not a task</button><button type="button" class="btn btn-small btn-ghost danger" data-action="delete">Delete</button></div>`) : ''}
      </div>`,
      submitLabel: isNew ? 'Add task' : 'Save',
      onSubmit: async (f) => {
        const body = { title: f.title, notes: f.notes, due_date: f.due_date || null };
        if (f.col && (isNew || f.col !== t.col)) body.col = f.col;
        if (isNew) await api.post('/api/tasks', body); else await api.put(`/api/tasks/${t.id}`, body);
        await load();
      },
    });
    if (isNew) return;
    on(m.el, 'click', '[data-action=dismiss]', async () => { m.close(); await save(t.id, { status: 'dismissed' }, 'Dismissed'); });
    on(m.el, 'click', '[data-action=delete]', async () => {
      if (!(await confirmDialog(`Delete "${t.title}"?`, { okLabel: 'Delete' }))) return;
      m.close(); await api.del(`/api/tasks/${t.id}`); toast('Deleted'); await load();
    });
  }

  on(ctx.el, 'click', '[data-action=new]', (e, b) => editor(null, b.dataset.col));
  on(ctx.el, 'click', '[data-action=edit]', (e, b) => { if (!e.target.closest('a')) editor(find(b.closest('[data-id]').dataset.id)); });
  on(ctx.el, 'click', '[data-action=done]', async (e, b) => {
    const el = b.closest('[data-id]');
    el.classList.add('leaving');
    await save(el.dataset.id, { status: 'done' }, 'Done ✓');
  });
  on(ctx.el, 'click', '[data-action=reopen]', (e, b) => save(b.dataset.id, { status: 'open' }, 'Back on the board'));
  on(ctx.el, 'keydown', '.tb-card', (e, c) => {
    if (e.target !== c) return;
    if (e.key === 'Enter') editor(find(c.dataset.id));
    // Keyboard moves: Alt+←/→ changes column.
    if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      const t = find(c.dataset.id);
      const i = columns.findIndex((x) => x.id === t.col) + (e.key === 'ArrowRight' ? 1 : -1);
      if (columns[i]) save(t.id, { col: columns[i].id }).then(() => $(`.tb-card[data-id="${t.id}"]`, ctx.el)?.focus());
    }
  });

  // Drag and drop between and within columns.
  let dragId = null;
  on(ctx.el, 'dragstart', '.tb-card', (e, c) => { dragId = c.dataset.id; c.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragId); });
  on(ctx.el, 'dragend', '.tb-card', (e, c) => { c.classList.remove('dragging'); clearMarks(); dragId = null; });
  on(ctx.el, 'dragover', '.tb-col', (e, col) => {
    if (!dragId) return;
    e.preventDefault();
    clearMarks();
    col.classList.add('drop');
    const before = cardAfter(col, e.clientY);
    if (before) before.classList.add('drop-before');
  });
  on(ctx.el, 'drop', '.tb-col', async (e, col) => {
    if (!dragId) return;
    e.preventDefault();
    const before = cardAfter(col, e.clientY);
    const id = dragId;
    clearMarks();
    const body = { col: col.dataset.col };
    if (before && before.dataset.id !== id) body.before_id = Number(before.dataset.id);
    await save(id, body);
  });
  const clearMarks = () => { $$('.drop', ctx.el).forEach((x) => x.classList.remove('drop')); $$('.drop-before', ctx.el).forEach((x) => x.classList.remove('drop-before')); };
  const cardAfter = (col, y) => $$('.tb-card:not(.dragging)', col).find((c) => { const r = c.getBoundingClientRect(); return y < r.top + r.height / 2; });

  await load();
}
