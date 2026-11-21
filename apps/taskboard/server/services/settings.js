import { bad, str } from '../util.js';
import { encrypt, decrypt } from '../crypto.js';

export const getSetting = (db, key, fallback = null) => db.get('SELECT value FROM settings WHERE key = ?', key)?.value ?? fallback;
export const setSetting = (db, key, value) => (value === null || value === undefined
  ? db.run('DELETE FROM settings WHERE key = ?', key)
  : db.run('INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value)));

export const SYNC_CHOICES = [0, 5, 15, 30, 60]; // minutes; 0 = only when you press Sync now

/** Google OAuth client: environment variables win over what was saved in Settings. */
export function googleClient(db) {
  const id = process.env.GOOGLE_CLIENT_ID || getSetting(db, 'google_client_id');
  const secretEnc = getSetting(db, 'google_client_secret_enc');
  const secret = process.env.GOOGLE_CLIENT_SECRET || (secretEnc ? decrypt(secretEnc) : null);
  return id && secret ? { id, secret, fromEnv: !!process.env.GOOGLE_CLIENT_ID } : null;
}

export function publicSettings(db) {
  const client = googleClient(db);
  return {
    google_client_id: client?.id ?? getSetting(db, 'google_client_id'),
    google_client_configured: !!client,
    google_client_from_env: !!client?.fromEnv,
    sync_minutes: Number(getSetting(db, 'sync_minutes', 15)),
    primary_account_id: Number(getSetting(db, 'primary_account_id')) || null,
    gtasks_list_title: getSetting(db, 'gtasks_list_title', 'Taskboard'),
  };
}

export function saveSettings(db, body) {
  if (body.google_client_id !== undefined) {
    const id = str(body.google_client_id, 300);
    if (id && !/\.apps\.googleusercontent\.com$/.test(id)) throw bad('The client ID should end in .apps.googleusercontent.com');
    setSetting(db, 'google_client_id', id);
  }
  if (body.google_client_secret) setSetting(db, 'google_client_secret_enc', encrypt(str(body.google_client_secret, 300)));
  if (body.sync_minutes !== undefined) {
    const m = Number(body.sync_minutes);
    if (!SYNC_CHOICES.includes(m)) throw bad('Choose a sync interval from the list');
    setSetting(db, 'sync_minutes', m);
  }
  if (body.primary_account_id !== undefined) {
    const id = Number(body.primary_account_id) || null;
    if (id && !db.get('SELECT 1 FROM accounts WHERE id = ?', id)) throw bad('Unknown account');
    setSetting(db, 'primary_account_id', id);
  }
  if (body.gtasks_list_title !== undefined) {
    const t = str(body.gtasks_list_title, 100);
    if (!t) throw bad('Give the Google Tasks list a name');
    if (t !== getSetting(db, 'gtasks_list_title', 'Taskboard')) db.run('UPDATE accounts SET gtasks_list_id = NULL'); // new tasks go to a list with the new name
    setSetting(db, 'gtasks_list_title', t);
  }
  return publicSettings(db);
}
