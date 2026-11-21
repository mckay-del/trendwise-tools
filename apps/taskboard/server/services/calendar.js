// Google Calendar, read-only: upcoming events that may need a reply or preparation.
// First sync: the next 14 days. After that: Google's sync token, so only changed events come back.
import { gfetch } from './google.js';
import { upsertSource, findSource, clip, htmlToText } from './sources.js';

const API = 'https://www.googleapis.com/calendar/v3';
const enc = encodeURIComponent;
const DAY = 86400_000;

/** Turn an event into a source row, or null if it doesn't need attention. `existing` keeps tracked events updated. */
export function eventToSource(account, calendarId, ev, { now = Date.now(), existing = false } = {}) {
  const externalId = `${calendarId}/${ev.id}`;
  const start = ev.start?.dateTime ?? ev.start?.date;
  const startMs = start ? Date.parse(start) : NaN;
  const self = (ev.attendees ?? []).find((a) => a.self);
  const response = self?.responseStatus ?? (ev.organizer?.self ? 'organizer' : 'none');
  const others = (ev.attendees ?? []).filter((a) => !a.self && !a.resource).length;
  const gone = ev.status === 'cancelled' || response === 'declined';

  if (gone || (ev.eventType && ev.eventType !== 'default')) {
    // Only tracked events matter here: tell the assistant it's off, so it can close the card.
    if (!existing || !gone) return null;
  } else if (!existing) {
    if (!(startMs >= now - DAY && startMs <= now + 14 * DAY)) return null;
    const needsReply = response === 'needsAction';
    const soonWithPeopleOrNotes = startMs <= now + 7 * DAY && (others > 0 || (ev.description ?? '').trim());
    if (!needsReply && !soonWithPeopleOrNotes) return null;
  }
  return {
    kind: 'event',
    external_id: externalId,
    title: clip(ev.summary || '(no title)', 300),
    snippet: null,
    link: ev.htmlLink ?? null,
    content_hash: `${ev.updated ?? ''}|${ev.status ?? ''}|${response}`,
    occurred_at: Number.isNaN(startMs) ? null : new Date(startMs).toISOString(),
    meta: {
      start, end: ev.end?.dateTime ?? ev.end?.date, all_day: !!ev.start?.date,
      organizer: ev.organizer?.self ? 'me' : (ev.organizer?.email ?? undefined),
      my_response: response, other_attendees: others,
      location: ev.location ? clip(ev.location, 200) : undefined,
      cancelled: ev.status === 'cancelled' || undefined, declined: response === 'declined' || undefined,
    },
    excerpt: clip(htmlToText(ev.description ?? ''), 800),
  };
}

async function calendars(db, account) {
  const out = [];
  let pageToken = null;
  do {
    const r = await gfetch(db, account, `${API}/users/me/calendarList?minAccessRole=owner&maxResults=250${pageToken ? `&pageToken=${enc(pageToken)}` : ''}`);
    for (const c of r?.items ?? []) if (c.primary || c.selected) out.push(c.primary ? 'primary' : c.id);
    pageToken = r?.nextPageToken;
  } while (pageToken);
  return out.length ? out : ['primary'];
}

async function listEvents(db, account, calendarId, syncToken) {
  const events = [];
  let pageToken = null;
  let next = null;
  do {
    const u = new URL(`${API}/calendars/${enc(calendarId)}/events`);
    u.searchParams.set('singleEvents', 'true');
    u.searchParams.set('maxResults', '250');
    if (syncToken) u.searchParams.set('syncToken', syncToken);
    else {
      u.searchParams.set('timeMin', new Date(Date.now() - DAY).toISOString());
      u.searchParams.set('timeMax', new Date(Date.now() + 14 * DAY).toISOString());
    }
    if (pageToken) u.searchParams.set('pageToken', pageToken);
    const r = await gfetch(db, account, u.toString());
    events.push(...(r?.items ?? []));
    pageToken = r?.nextPageToken;
    next = r?.nextSyncToken ?? next;
  } while (pageToken);
  return { events, syncToken: next };
}

export async function syncCalendar(db, account, { now = Date.now() } = {}) {
  const stats = { checked: 0, new: 0, changed: 0 };
  const tokens = JSON.parse(account.calendar_sync || '{}');
  const fresh = {};
  for (const calendarId of await calendars(db, account)) {
    let res;
    try { res = await listEvents(db, account, calendarId, tokens[calendarId]); }
    catch (e) {
      if (e.googleStatus !== 410) throw e; // 410: the sync token expired, so start over
      res = await listEvents(db, account, calendarId, null);
    }
    for (const ev of res.events) {
      stats.checked++;
      const existing = !!findSource(db, account.id, 'event', `${calendarId}/${ev.id}`);
      const src = eventToSource(account, calendarId, ev, { now, existing });
      if (!src) continue;
      const r = upsertSource(db, account.id, src);
      if (r !== 'same') stats[r]++;
    }
    if (res.syncToken) fresh[calendarId] = res.syncToken;
  }
  db.run('UPDATE accounts SET calendar_sync = ? WHERE id = ?', JSON.stringify(fresh), account.id);
  return stats;
}
