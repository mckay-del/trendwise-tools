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

// Claude models the assistant can use, with list prices per million tokens (input, output) for the cost estimate.
export const AI_MODELS = [
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5 (best judgment)', input: 4, output: 20 },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5 (balanced)', input: 2, output: 10 },
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5 (lowest cost)', input: 0.1, output: 0.5 },
];
export const DEFAULT_MODEL = AI_MODELS[0].id;

/** The Anthropic API key: ANTHROPIC_API_KEY wins over the one saved (encrypted) in Settings. */
export function anthropicKey(db) {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const enc = getSetting(db, 'anthropic_api_key_enc');
  return enc ? decrypt(enc) : null;
}

export const usageKey = (d = new Date()) => `ai_usage_${d.toISOString().slice(0, 7)}`;
export function aiUsage(db, d = new Date()) {
  const u = JSON.parse(getSetting(db, usageKey(d), '{}'));
  const cost = Object.entries(u.by_model ?? {}).reduce((sum, [id, m]) => {
    const p = AI_MODELS.find((x) => x.id === id) ?? AI_MODELS[0];
    // Cache writes bill at 1.25x input and cache reads at 0.1x input (an estimate; see the Anthropic pricing page).
    return sum + ((m.input ?? 0) + (m.cache_write ?? 0) * 1.25 + (m.cache_read ?? 0) * 0.1) * p.input / 1e6 + (m.output ?? 0) * p.output / 1e6;
  }, 0);
  return { month: (d.toISOString().slice(0, 7)), requests: u.requests ?? 0, input_tokens: u.input ?? 0, output_tokens: u.output ?? 0, est_cost_usd: Math.round(cost * 100) / 100 };
}
export function addUsage(db, model, usage) {
  const key = usageKey();
  const u = JSON.parse(getSetting(db, key, '{}'));
  const m = ((u.by_model ??= {})[model] ??= {});
  const add = (k, v) => { m[k] = (m[k] ?? 0) + (v ?? 0); };
  add('input', usage.input_tokens); add('output', usage.output_tokens);
  add('cache_read', usage.cache_read_input_tokens); add('cache_write', usage.cache_creation_input_tokens);
  u.requests = (u.requests ?? 0) + 1;
  u.input = (u.input ?? 0) + (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  u.output = (u.output ?? 0) + (usage.output_tokens ?? 0);
  setSetting(db, key, JSON.stringify(u));
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
    ai_configured: !!anthropicKey(db),
    ai_from_env: !!process.env.ANTHROPIC_API_KEY,
    ai_model: getSetting(db, 'ai_model', DEFAULT_MODEL),
    ai_models: AI_MODELS.map(({ id, name }) => ({ id, name })),
    ai_notes: getSetting(db, 'ai_notes', ''),
    ai_usage: aiUsage(db),
    ai_last_run: JSON.parse(getSetting(db, 'ai_last_run', 'null')),
    ai_pending: db.get('SELECT COUNT(*) AS n FROM sources WHERE processed_at IS NULL AND dismissed = 0').n,
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
  if (body.anthropic_api_key) {
    const k = str(body.anthropic_api_key, 300);
    if (!/^sk-ant-[\w-]{20,}$/.test(k)) throw bad('That doesn\'t look like an Anthropic API key (they start with sk-ant-).');
    setSetting(db, 'anthropic_api_key_enc', encrypt(k));
  }
  if (body.anthropic_api_key_remove) setSetting(db, 'anthropic_api_key_enc', null);
  if (body.ai_model !== undefined) {
    if (!AI_MODELS.some((m) => m.id === body.ai_model)) throw bad('Choose a model from the list');
    setSetting(db, 'ai_model', body.ai_model);
  }
  if (body.ai_notes !== undefined) setSetting(db, 'ai_notes', str(body.ai_notes, 3000));
  return publicSettings(db);
}
