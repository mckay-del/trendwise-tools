// Runs the sync for every connected account. One run at a time; each account on its own so one failure
// (expired sign-in, Google outage) never blocks the others.
import { syncAccount as syncTasks } from './gtasks.js';
import { ReconnectNeeded } from './google.js';
import { getSetting } from './settings.js';

let running = null;
let lastRunAt = 0;
let soonTimer = null;

export function syncAll(db) {
  if (running) return running;
  running = (async () => {
    const results = [];
    for (const account of db.all('SELECT * FROM accounts WHERE needs_reconnect = 0 ORDER BY id')) {
      const at = new Date().toISOString();
      let result;
      try {
        result = { ok: true, tasks: await syncTasks(db, account) };
      } catch (e) {
        if (!(e instanceof ReconnectNeeded)) console.error(`Sync for ${account.email} failed:`, e.message);
        result = { ok: false, error: e.message, reconnect: e instanceof ReconnectNeeded };
      }
      db.run('UPDATE accounts SET last_sync_at = ?, last_result = ? WHERE id = ?', at, JSON.stringify(result), account.id);
      results.push({ account_id: account.id, email: account.email, ...result });
    }
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
