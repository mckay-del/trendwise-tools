// Runs the sync for every connected account. One run at a time; each account on its own so one failure
// (expired sign-in, Google outage) never blocks the others.
import { syncAccount as syncTasks } from './gtasks.js';
import { syncMail } from './mail.js';
import { syncCalendar } from './calendar.js';
import { triage, saveRun } from './triage.js';
import { ReconnectNeeded } from './google.js';
import { getSetting } from './settings.js';

let running = null;
let lastRunAt = 0;
let soonTimer = null;

export function syncAll(db) {
  if (running) return running;
  running = (async () => {
    const results = [];
    for (let account of db.all('SELECT * FROM accounts WHERE needs_reconnect = 0 ORDER BY id')) {
      const at = new Date().toISOString();
      // Each part on its own: a Gmail hiccup shouldn't stop Google Tasks, and so on.
      const result = { ok: true };
      const errors = [];
      for (const [part, fn] of [['tasks', syncTasks], ['mail', syncMail], ['calendar', syncCalendar]]) {
        try { result[part] = await fn(db, account); }
        catch (e) {
          if (e instanceof ReconnectNeeded) { Object.assign(result, { ok: false, reconnect: true }); errors.length = 0; errors.push(e.message); break; }
          console.error(`${part} sync for ${account.email} failed:`, e.message);
          errors.push(`${{ tasks: 'Google Tasks', mail: 'Gmail', calendar: 'Calendar' }[part]}: ${e.message}`);
          result.ok = false;
        }
        account = db.get('SELECT * FROM accounts WHERE id = ?', account.id) ?? account; // pick up saved sync tokens
      }
      if (errors.length) result.error = errors.join(' · ');
      db.run('UPDATE accounts SET last_sync_at = ?, last_result = ? WHERE id = ?', at, JSON.stringify(result), account.id);
      results.push({ account_id: account.id, email: account.email, ...result });
    }
    // Then the assistant turns new email and events into cards, and those go to Google Tasks right away.
    try {
      const t = await triage(db);
      if (t.sent || t.error) saveRun(db, t);
      if (t.error && t.error !== 'no_key') console.error('Assistant:', t.error);
      if (t.created || t.updated || t.completed) {
        for (const account of db.all('SELECT * FROM accounts WHERE needs_reconnect = 0 ORDER BY id')) {
          try { await syncTasks(db, account); } catch (e) { console.error(`Google Tasks push for ${account.email} failed:`, e.message); }
        }
      }
    } catch (e) { console.error('Assistant failed:', e); }
    lastRunAt = Date.now();
    return results;
  })().finally(() => { running = null; });
  return running;
}

/** After a change on the board, push it to Google Tasks within a few seconds (several quick edits share one sync). */
export function syncSoon(db, delayMs = Number(process.env.TASKBOARD_SYNC_DELAY_MS ?? 5000)) {
  if (!db.get('SELECT 1 FROM accounts WHERE needs_reconnect = 0 LIMIT 1')) return;
  clearTimeout(soonTimer);
  soonTimer = setTimeout(() => syncAll(db).catch((e) => console.error('Sync failed:', e.message)), delayMs);
  soonTimer.unref?.();
}

/** Called every minute by the server: sync when the chosen interval has passed. */
export function syncIfDue(db) {
  const minutes = Number(getSetting(db, 'sync_minutes', 15));
  if (!minutes || Date.now() - lastRunAt < minutes * 60_000) return null;
  return syncAll(db);
}
