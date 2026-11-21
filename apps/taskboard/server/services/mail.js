// Gmail, read-only: find inbox threads that are new or have new messages, and keep a short excerpt of each.
// First sync: the last 7 days of the inbox. After that: Gmail's change history since the last sync.
import { gfetch } from './google.js';
import { upsertSource, clip, htmlToText } from './sources.js';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const SKIP_LABELS = ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS', 'SPAM', 'TRASH'];
const QUERY = (days) => `in:inbox newer_than:${days}d -category:promotions -category:social -category:updates -category:forums`;
export const FIRST_SYNC_CAP = 150;
const EXCERPT_PER_MESSAGE = 1500;

async function threadIdsFromSearch(db, account, q, cap) {
  const ids = new Set();
  let pageToken = null;
  do {
    const u = new URL(`${API}/messages`);
    u.searchParams.set('q', q);
    u.searchParams.set('maxResults', '100');
    if (pageToken) u.searchParams.set('pageToken', pageToken);
    const r = await gfetch(db, account, u.toString());
    for (const m of r?.messages ?? []) { ids.add(m.threadId); if (ids.size >= cap) return [...ids]; }
    pageToken = r?.nextPageToken;
  } while (pageToken);
  return [...ids];
}

/** Thread ids with messages added to the inbox since `startHistoryId`. Returns null if Gmail no longer has that history. */
async function threadIdsFromHistory(db, account, startHistoryId) {
  const ids = new Set();
  let pageToken = null;
  let latest = startHistoryId;
  do {
    const u = new URL(`${API}/history`);
    u.searchParams.set('startHistoryId', startHistoryId);
    u.searchParams.set('historyTypes', 'messageAdded');
    u.searchParams.set('labelId', 'INBOX');
    u.searchParams.set('maxResults', '500');
    if (pageToken) u.searchParams.set('pageToken', pageToken);
    let r;
    try { r = await gfetch(db, account, u.toString()); }
    catch (e) { if (e.googleStatus === 404) return null; throw e; }
    for (const h of r?.history ?? []) for (const a of h.messagesAdded ?? []) ids.add(a.message.threadId);
    if (r?.historyId) latest = r.historyId;
    pageToken = r?.nextPageToken;
  } while (pageToken);
  return { ids: [...ids], historyId: latest };
}

const header = (msg, name) => msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
const decode = (data) => Buffer.from(String(data).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

function findPart(part, type) {
  if (!part) return null;
  if (part.mimeType === type && part.body?.data) return part;
  for (const p of part.parts ?? []) { const f = findPart(p, type); if (f) return f; }
  return null;
}

/** The new text of one message: plain text (or HTML as text), without the quoted earlier conversation. */
export function messageText(msg) {
  const plain = findPart(msg.payload, 'text/plain');
  const html = plain ? null : findPart(msg.payload, 'text/html');
  let text = plain ? decode(plain.body.data) : html ? htmlToText(decode(html.body.data)) : (msg.snippet ?? '');
  text = text.replace(/\r/g, '');
  // Cut the quoted reply chain: "On <date> <name> wrote:" (may wrap), Outlook headers, forwarded-message markers stay.
  const cut = text.search(/^\s*On [^\n]{0,200}?(\n[^\n]{0,200}?)?wrote:\s*$/m);
  if (cut > 0) text = text.slice(0, cut);
  const outlook = text.search(/^\s*(-{2,}\s*Original Message\s*-{2,}|From:\s.+\n\s*Sent:\s)/mi);
  if (outlook > 0) text = text.slice(0, outlook);
  text = text.split('\n').filter((l) => !/^\s*>/.test(l)).join('\n');
  return clip(text, EXCERPT_PER_MESSAGE);
}

/** Turn a Gmail thread into a source row, or null if it shouldn't be looked at (not in the inbox, a category tab). */
export function threadToSource(account, thread) {
  const msgs = thread.messages ?? [];
  if (!msgs.length) return null;
  const last = msgs[msgs.length - 1];
  const labels = new Set(msgs.flatMap((m) => m.labelIds ?? []));
  if (!labels.has('INBOX')) return null;
  if (SKIP_LABELS.some((l) => (last.labelIds ?? []).includes(l))) return null;
  const recent = msgs.slice(-2);
  const subject = header(msgs[0], 'Subject') || '(no subject)';
  return {
    kind: 'email',
    external_id: thread.id,
    title: clip(subject, 300),
    snippet: clip(last.snippet, 300),
    link: `https://mail.google.com/mail/?authuser=${encodeURIComponent(account.email)}#all/${thread.id}`,
    content_hash: last.id,
    occurred_at: new Date(Number(last.internalDate) || Date.now()).toISOString(),
    meta: {
      from: header(last, 'From'),
      to: header(last, 'To'),
      cc: header(last, 'Cc') || undefined,
      messages: msgs.length,
      last_from_me: (last.labelIds ?? []).includes('SENT'),
      starred: labels.has('STARRED') || undefined,
      important: labels.has('IMPORTANT') || undefined,
    },
    excerpt: recent.map((m) => `--- ${(m.labelIds ?? []).includes('SENT') ? 'Me' : header(m, 'From')} (${header(m, 'Date')}):\n${messageText(m)}`).join('\n\n'),
  };
}

export async function syncMail(db, account) {
  const stats = { checked: 0, new: 0, changed: 0 };
  let ids;
  let historyId = account.gmail_history_id;
  if (historyId) {
    const h = await threadIdsFromHistory(db, account, historyId);
    if (h) { ids = h.ids; historyId = h.historyId; }
  }
  if (!ids) {
    // First sync, or Gmail's history expired: read the recent inbox and start the history from now.
    historyId = (await gfetch(db, account, `${API}/profile`)).historyId;
    ids = await threadIdsFromSearch(db, account, QUERY(account.gmail_history_id ? 2 : 7), FIRST_SYNC_CAP);
  }
  for (const id of ids) {
    let thread;
    try { thread = await gfetch(db, account, `${API}/threads/${encodeURIComponent(id)}?format=full`); }
    catch (e) { if (e.googleStatus === 404) continue; throw e; } // deleted since
    stats.checked++;
    const src = threadToSource(account, thread);
    if (!src) continue;
    const r = upsertSource(db, account.id, src);
    if (r !== 'same') stats[r]++;
  }
  db.run('UPDATE accounts SET gmail_history_id = ? WHERE id = ?', String(historyId), account.id);
  return stats;
}
