# McKay's Taskboard: multi-account Google Workspace task agent

Product name everywhere (page title, header, README, desktop shortcut, Start .bat, Google OAuth consent screen app name): **McKay's Taskboard**. Folder/package stay `apps/taskboard` / `mckays-taskboard`.

## Context
McKay works across several Google Workspace accounts on different domains. Tasks are buried in email threads, calendar invites and Google Tasks lists spread across all of them. The goal is one agent that:
- watches every account's Gmail, Calendar and Google Tasks on a schedule
- uses Claude to turn emails and events into concrete to-dos (with a due date, a reason and a link back to the source)
- shows the tasks on a board with the columns **Today / This week / Later / Waiting**
- syncs board tasks into Google Tasks so they appear on McKay's phone

Decisions already made: build it as a **new app beside Ledger** (`apps/taskboard`) on the same stack. Access is **read-only for Gmail and Calendar**. The only write access is **Google Tasks**: the agent never sends email and never changes calendar events.

## Approach

### Stack (reuse the Ledger conventions)
- Node ≥ 22.5, ES modules, built-in `node:sqlite`, a vanilla-JS single-page app, Windows `.bat` launchers, and the Tailscale server setup from `apps/ledger/SERVER-SETUP.md`.
- Copy these from Ledger with small edits, rather than writing new ones:
  - `server/db.js` (the Db wrapper)
  - `server/router.js`
  - `server/util.js` (AppError/bad)
  - `server/auth.js` (local admin login + session cookie)
  - `server/backup.js` (encrypted backups)
  - `public/css/app.css`, the fonts and the Trendwise logo
- Talk to Google through plain `fetch` against the REST APIs, the same way `server/services/ghl.js` calls GHL. No `googleapis` package.
- **One dependency: `@anthropic-ai/sdk`** for the Claude calls. This is the first npm dependency in the repo, so `npm install` becomes part of setup.

### Google access (one-time setup, documented in `apps/taskboard/GOOGLE-SETUP.md`)
1. Create one Google Cloud project in McKay's main Workspace and enable the Gmail, Calendar and Tasks APIs.
2. Set up the OAuth consent screen as **External** and **publish it to "In production"**. In "Testing" mode Google expires refresh tokens after 7 days. An unverified app is fine for personal use (fewer than 100 users).
3. Create an OAuth client of type **Web application**, with the redirect URI `http://127.0.0.1:3100/oauth/callback` (plus the Tailscale hostname if the app is hosted).
4. **In each domain's Admin console:** Security → API controls → App access control → add the client ID as **Trusted**. This removes the "unverified app" block for that domain's users.
5. Scopes:
   - `gmail.readonly`
   - `calendar.readonly`
   - `tasks` (read/write)
   - `openid email`
6. In the app, Settings → **Accounts → Connect Google account** runs the OAuth flow once per account, with `access_type=offline` and `prompt=consent`. Repeat for each domain.
7. Refresh tokens are stored **encrypted** (AES-256-GCM, key file in the data folder, created with mode 0600). The data folder is `~/McKaysTaskboard`, outside the repo, like Ledger's.

### Data model (`server/schema.sql`)
- **`accounts`**: id, email, domain, display color, encrypted refresh token, Gmail `history_id`, per-calendar `sync_token` (JSON), last sync time and result.
- **`sources`**: one row per email thread, event or Google Task seen, keyed by account and external id. Holds the snippet, a link (Gmail thread URL or event `htmlLink`), and a processed flag/hash so Claude never re-reads unchanged items.
- **`tasks`**:
  - title, notes, `column` (today | week | later | waiting), due date
  - `source_id`, account id, origin (ai | manual | gtasks)
  - status (open | done | dismissed), position within its column
  - `ai_reason`, `gtask_id` / `gtask_list_id`
  - `pinned` (set when McKay moves a card by hand, so the agent won't move it back)
- **`rules`**: optional per-account or per-sender hints (e.g. "newsletters → ignore", "IRS / client X → Today").
- `audit`: copied from Ledger.

### Sync engine (`server/services/google.js`, `sync.js`)
- **Token refresh:** POST to `oauth2.googleapis.com/token`. Cache the access token in memory until it expires.
- **Gmail:**
  - First run: `users.messages.list?q=newer_than:14d -category:promotions -category:social`.
  - Later runs: incremental via `users.history.list` from the stored `historyId`. If Google returns 404 (history too old), fall back to the full query.
  - Fetch with `format=metadata` plus the snippet. Fetch the plain-text body (truncated per thread) only for candidate threads.
- **Calendar:** `calendarList`, then `events.list` with `syncToken` (first run: from today to +14 days, `singleEvents=true`). Events where McKay is an attendee and needs to respond or prepare become candidates.
- **Google Tasks:** `tasklists` + `tasks.list?updatedMin=…`, so tasks created on the phone flow onto the board, and tasks completed on the phone complete on the board.
- **Scheduler:** an in-process interval (default every 15 min, set in Settings), the same pattern as Ledger's GHL schedule. There is also a **Sync now** button. Each account syncs on its own, so an error in one account doesn't block the others.

### AI triage (`server/services/triage.js`)
- **Input:** new or changed sources are batched, about 20 per request: sender, subject, snippet/body excerpt, account, received date, event time.
- **Request:** `client.messages.create` with:
  - model `claude-opus-5-5`
  - `output_config: { effort: "low", format: <JSON schema> }`
  - beta `server-side-fallback-2026-07-01` with `fallbacks: "default"`, so a refusal reroutes automatically
- **System prompt:** a frozen prompt describing McKay's role (EA / Trendwise), the column definitions, and the user's `rules`, with `cache_control`. Today's date goes in the user message, so it doesn't break the cache.
- **Output per item:** `{source_ref, action: "create"|"update"|"complete"|"ignore", title, column, due_date, reason}`.
  - Column definitions given to Claude:
    - **Today**: due/needed today or overdue.
    - **This week**: within 7 days.
    - **Later**: no near deadline.
    - **Waiting**: McKay already replied or delegated and is waiting on someone else.
  - Dedupe against open tasks for the same thread (update rather than create).
- **Column roll-forward:** a nightly local job moves tasks into Today/This week as their due dates arrive, but never moves a pinned card.
- **Cost:** low effort plus caching and batching keeps it modest. Each run logs `usage` so spend is visible in Settings. The model can be changed in Settings (e.g. Haiku 5.5 if volume is high) if McKay chooses.
- **Data handling:** the API key comes from the `ANTHROPIC_API_KEY` env var or an `ant auth login` profile. It is never stored in the database or the repo. Email content is sent to the Claude API only for triage, and is never logged in full.

### Google Tasks write-back
- Every AI or manual task gets a Google Task in a list named **"Taskboard"** in the account the task came from. The list name can be changed to a single primary account in Settings.
- Done on the board → `tasks.patch status=completed`. Done in Google Tasks → done on the board on the next sync.
- The column is written into the task notes (`[Today]`), because Google Tasks has no priority field.

### Board UI (`public/js/views/board.js`)
- Four columns, **Today / This week / Later / Waiting**, plus a collapsed **Done** strip.
- Each card shows:
  - title, due date (red when overdue)
  - an account badge (colored per domain)
  - a source icon (mail/calendar/task) that opens the Gmail thread or event in a new tab
  - the AI reason on hover
- Drag and drop between columns sets `pinned`. Cards can also be checked off, edited, dismissed ("not a task", which also teaches a rule), or added by hand with **+ New task**.
- Filters: account, source type, search. The header shows the last sync per account, with a warning chip if an account needs reconnecting.
- Settings has sections for: Accounts (connect/disconnect, color), Sync interval, Rules, AI model/usage, and Backup.

### Files to create
- `apps/taskboard/`:
  - `package.json`, `README.md`, `GOOGLE-SETUP.md`
  - `Start Taskboard.bat`, `Create Desktop Shortcut.bat`
- `server/`:
  - `index.js`, `app.js`, `router.js`*, `db.js`*, `util.js`*, `auth.js`*, `backup.js`*, `crypto.js`, `schema.sql`
  - `services/google.js`, `services/sync.js`, `services/triage.js`, `services/tasks.js`, `services/gtasks.js`, `services/rules.js`
- `public/`:
  - `index.html`, `css/app.css`*, `js/app.js`, `js/views/board.js`, `js/views/settings.js`, `js/views/auth.js`*
- `test/`:
  - `triage.test.js`, `sync.test.js`, `tasks.test.js`
- Update the root `README.md` structure table.

(* = adapted from `apps/ledger`)

### Build order (each step is a shippable PR)
1. **Scaffold:** copy the Ledger core, add the board UI with manual tasks only (columns, drag/drop, done).
2. **Google accounts:** OAuth connect flow, encrypted tokens, Google Tasks two-way sync.
3. **Gmail + Calendar read sync:** incremental sync, `sources` table, links.
4. **Claude triage:** batching, structured output, dedupe, rules, nightly roll-forward.
5. **Hosting:** Tailscale server deploy (reuse `apps/ledger/deploy`), backups, docs.

## Verification
- `npm test`: unit tests run with Google and Claude stubbed out by injecting a fake `fetch` / client. They cover:
  - history-id fallback
  - token-refresh failure marking the account "reconnect needed"
  - triage JSON → task create/update/complete
  - dedupe by thread
  - pinned cards not moved
  - roll-forward by due date
- **Manual end-to-end:**
  1. `npm start` and connect two accounts from different domains.
  2. Send a test email ("Can you send the W-9 by Friday?") to one account and click **Sync now**. Confirm a card appears in **This week** with a working Gmail link.
  3. Drag it to Today and complete it. Confirm Google Tasks on the phone shows it as completed.
  4. Create a task in Google Tasks on the phone. Confirm it appears on the board after the next sync.
  5. Revoke one account's access in Google. Confirm only that account shows "reconnect" and the other keeps syncing.
- Check the Settings → AI usage panel for token counts and `cache_read_input_tokens` > 0 on repeat runs.
