import { api } from '../api.js';
import { html, raw, on, field, options, toast, confirmDialog } from '../ui.js';
import { APP_NAME } from '../app.js';

export const ago = (iso) => {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
};

export function syncSummary(a) {
  const r = a.last_result;
  if (a.needs_reconnect) return 'Google stopped accepting this sign-in. Reconnect it.';
  if (!r) return 'Not synced yet';
  if (!r.ok) return `Last sync failed ${ago(a.last_sync_at)}: ${r.error}`;
  const t = r.tasks ?? {};
  const mail = (r.mail?.new ?? 0) + (r.mail?.changed ?? 0);
  const cal = (r.calendar?.new ?? 0) + (r.calendar?.changed ?? 0);
  const bits = [mail && `${mail} email${mail === 1 ? '' : 's'}`, cal && `${cal} event${cal === 1 ? '' : 's'}`, t.imported && `${t.imported} new from Google Tasks`, t.completed && `${t.completed} completed`, (t.created || t.pushed) && `${(t.created ?? 0) + (t.pushed ?? 0)} sent`].filter(Boolean);
  return `Synced ${ago(a.last_sync_at)}${bits.length ? ` · ${bits.join(', ')}` : ''}`;
}

function aiStatus(s) {
  const u = s.ai_usage;
  const run = s.ai_last_run;
  const lines = [];
  if (run?.error && run.error !== 'no_key') lines.push(html`<p class="bad">${run.error}</p>`);
  if (run?.at) lines.push(html`<p class="muted">Last ran ${ago(run.at)}: looked at ${run.sent}, added ${run.created}, updated ${run.updated}, completed ${run.completed}.</p>`);
  if (s.ai_pending) lines.push(html`<p class="muted">${s.ai_pending} email${s.ai_pending === 1 ? '' : 's'} or event${s.ai_pending === 1 ? '' : 's'} waiting${s.ai_configured ? ' for the next sync' : ' for an API key'}.</p>`);
  const tok = (n) => (n < 10_000 ? n.toLocaleString() : `${Math.round(n / 1000).toLocaleString()}k`);
  if (u.requests) lines.push(html`<p class="muted">This month: ${u.requests} request${u.requests === 1 ? '' : 's'}, ${tok(u.input_tokens)} tokens in, ${tok(u.output_tokens)} out, about $${u.est_cost_usd.toFixed(2)}.</p>`);
  return lines.join('');
}

export async function view(ctx) {
  document.title = `Settings · ${APP_NAME}`;
  if (ctx.query.connected) toast(`Connected ${ctx.query.connected}. Syncing now…`);
  if (ctx.query.error) toast(ctx.query.error, 'error');
  if (ctx.query.connected || ctx.query.error) history.replaceState(null, '', '#/settings');

  let s, accounts;
  async function load() {
    [s, accounts] = await Promise.all([api.get('/api/settings'), api.get('/api/accounts')]);
    draw();
  }

  function draw() {
    ctx.el.innerHTML = html`
      <div class="tb-toolbar"><h1>Settings</h1></div>
      <div class="tb-settings">
        <section class="card">
          <h3>Google accounts</h3>
          ${accounts.length ? '' : raw(html`<p class="muted">No accounts yet. Connect each Google Workspace account you use. ${s.google_client_configured ? '' : 'First add the Google app details below.'}</p>`)}
          <ul class="tb-accounts">${raw(accounts.map((a) => html`<li class="${a.needs_reconnect ? 'needs' : ''}">
            <input type="color" value="${a.color}" data-action="color" data-id="${a.id}" aria-label="Color for ${a.email}" title="Badge color">
            <div class="tb-acct-main">
              <b>${a.email}</b>
              <small class="${a.needs_reconnect || (a.last_result && !a.last_result.ok) ? 'bad' : 'muted'}">${syncSummary(a)}</small>
              <small class="muted">${a.open_tasks} open task${a.open_tasks === 1 ? '' : 's'}</small>
            </div>
            <label class="tb-primary" title="Tasks you add by hand go to this account's Google Tasks"><input type="radio" name="primary" value="${a.id}" ${s.primary_account_id === a.id ? raw('checked') : ''}> Primary</label>
            ${a.needs_reconnect ? raw(html`<button class="btn btn-small btn-primary" data-action="connect" data-email="${a.email}">Reconnect</button>`) : ''}
            <button class="btn btn-small btn-ghost danger" data-action="disconnect" data-id="${a.id}" data-email="${a.email}">Disconnect</button>
          </li>`).join(''))}</ul>
          <div class="btn-row">
            <button class="btn btn-primary" data-action="connect" ${s.google_client_configured ? '' : raw('disabled')}>＋ Connect Google account</button>
            ${accounts.length ? raw('<button class="btn" data-action="sync">Sync now</button>') : ''}
          </div>
          <p class="muted tb-fine">The board can <b>read</b> email and calendars and <b>add and update</b> Google Tasks. It never sends email or changes calendar events. It looks at your inbox (not the Promotions, Social, Updates or Forums tabs) and the next two weeks of your calendar.</p>
        </section>

        <section class="card">
          <h3>Assistant <small>${s.ai_configured ? '✓ on' : 'add an API key to turn email into cards'}</small></h3>
          <p class="muted">Claude reads new email and upcoming meetings and adds cards for what needs doing, with a due date and a one-line reason. Email text is sent to Anthropic only for this.</p>
          ${raw(aiStatus(s))}
          <form class="stack" data-form="ai">
            ${s.ai_from_env ? raw('<p class="muted">API key set by the ANTHROPIC_API_KEY environment variable.</p>') : raw(field('Anthropic API key', html`<input name="anthropic_api_key" type="password" autocomplete="off" placeholder="${s.ai_configured ? 'Saved. Leave blank to keep it' : 'sk-ant-…'}">`, { hint: 'From console.anthropic.com → API keys. Stored encrypted on this computer.' }))}
            ${raw(field('Model', html`<select name="ai_model">${raw(options(s.ai_models, s.ai_model))}</select>`, { hint: 'Opus is the most careful about what counts as a task; Haiku costs the least.' }))}
            ${raw(field('Notes for the assistant', html`<textarea name="ai_notes" rows="4" maxlength="3000" placeholder="e.g. Anything from the IRS or a state tax agency goes in Today. Ignore Stripe and QuickBooks notifications.">${s.ai_notes}</textarea>`, { hint: 'Plain sentences. Used for every email from now on.' }))}
            <div class="btn-row"><button class="btn btn-primary">Save assistant settings</button>${s.ai_configured && !s.ai_from_env ? raw('<button type="button" class="btn btn-ghost danger" data-action="forget-key">Forget key</button>') : ''}</div>
          </form>
        </section>

        <section class="card">
          <h3>Sync</h3>
          <form class="stack" data-form="sync">
            ${raw(field('Check Google every', html`<select name="sync_minutes">${raw(options(s.sync_choices.map((m) => ({ id: m, name: m ? `${m} minutes` : 'Only when I press Sync now' })), s.sync_minutes))}</select>`, { hint: 'Changes you make on the board are sent to Google Tasks within a few seconds either way.' }))}
            ${raw(field('Google Tasks list for new tasks', html`<input name="gtasks_list_title" value="${s.gtasks_list_title}" maxlength="100" required>`, { hint: 'Created in each account if it doesn\'t exist. Tasks already in your other lists show up on the board too.' }))}
            <div><button class="btn">Save</button></div>
          </form>
        </section>

        <section class="card">
          <h3>Google app <small>${s.google_client_configured ? '✓ set up' : 'needed before connecting'}</small></h3>
          ${s.google_client_from_env ? raw('<p class="muted">Set by the GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET environment variables.</p>') : raw(html`
          <p class="muted">A one-time setup in Google Cloud. Step-by-step instructions are in <code>apps/taskboard/GOOGLE-SETUP.md</code>.</p>
          <form class="stack" data-form="client">
            ${raw(field('Client ID', html`<input name="google_client_id" value="${s.google_client_id ?? ''}" placeholder="….apps.googleusercontent.com" autocomplete="off" required>`))}
            ${raw(field('Client secret', html`<input name="google_client_secret" type="password" autocomplete="off" placeholder="${s.google_client_configured ? 'Saved. Leave blank to keep it' : ''}" ${s.google_client_configured ? '' : raw('required')}>`, { hint: 'Stored encrypted on this computer.' }))}
            <div><button class="btn btn-primary">Save Google app</button></div>
          </form>`)}
          ${raw(field('Authorized redirect URI (add this to the OAuth client in Google Cloud)', html`<input readonly value="${s.redirect_uri}" data-action="select">`))}
        </section>
      </div>`;
  }

  on(ctx.el, 'click', '[data-action=connect]', async (e, b) => {
    b.disabled = true;
    try { location.href = (await api.post('/api/google/connect', { login_hint: b.dataset.email })).url; }
    catch (err) { toast(err.message, 'error'); b.disabled = false; }
  });
  on(ctx.el, 'click', '[data-action=disconnect]', async (e, b) => {
    if (!(await confirmDialog(`Stop syncing ${b.dataset.email}?\n\nIts tasks stay on the board as your own tasks, and the board's access to that Google account is removed.`, { okLabel: 'Disconnect' }))) return;
    await api.del(`/api/accounts/${b.dataset.id}`);
    toast('Disconnected');
    await load();
  });
  on(ctx.el, 'click', '[data-action=sync]', async (e, b) => {
    b.disabled = true; b.textContent = 'Syncing…';
    try {
      const results = await api.post('/api/sync');
      const failed = results.filter((r) => !r.ok);
      if (failed.length) toast(failed.map((r) => `${r.email}: ${r.error}`).join('\n'), 'error'); else toast('Synced');
    } finally { await load(); }
  });
  on(ctx.el, 'change', '[data-action=color]', async (e, i) => { await api.put(`/api/accounts/${i.dataset.id}`, { color: i.value }); toast('Color saved'); });
  on(ctx.el, 'change', 'input[name=primary]', async (e, i) => { await api.put('/api/settings', { primary_account_id: Number(i.value) }); toast('Primary account saved'); await load(); });
  on(ctx.el, 'focusin', '[data-action=select]', (e, i) => i.select());
  on(ctx.el, 'click', '[data-action=forget-key]', async () => {
    if (!(await confirmDialog('Forget the Anthropic API key? New email will wait until you add one again.', { okLabel: 'Forget key' }))) return;
    await api.put('/api/settings', { anthropic_api_key_remove: true });
    toast('Key forgotten');
    await load();
  });
  on(ctx.el, 'submit', '[data-form]', async (e, f) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(f));
    if (body.google_client_secret === '') delete body.google_client_secret;
    if (body.anthropic_api_key === '') delete body.anthropic_api_key;
    try { await api.put('/api/settings', body); toast('Saved'); await load(); }
    catch (err) { toast(err.message, 'error'); }
  });

  await load();
}
