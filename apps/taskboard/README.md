# McKay's Taskboard

One board for the tasks hiding in every Google Workspace account: email, calendar and Google Tasks, sorted into **Today / This week / Later / Waiting**.

Built on the same stack as [Trendwise Ledger](../ledger/README.md): Node.js ≥ 22.13 (built-in `node:sqlite`), a vanilla-JS page, one SQLite file. The assistant uses Anthropic's official SDK (`@anthropic-ai/sdk`), the app's one dependency.

## Status

| Step | What | State |
|---|---|---|
| 1 | Board with manual tasks: columns, drag and drop, due dates, done list, daily roll-forward | **Done (v0.1)** |
| 2 | Connect Google accounts (OAuth, encrypted tokens), two-way Google Tasks sync | **Done (v0.2)** |
| 3 | Read-only Gmail + Calendar sync across all accounts | **Done (v0.3)** |
| 4 | Claude triage: turns emails and events into tasks, picks the column, explains why | **Done (v0.3)** |
| 5 | Run on the Tailscale server, backups | Next |

Access to Google will be **read-only for Gmail and Calendar**. The only thing it writes is Google Tasks, so tasks show up on your phone. It never sends email or changes events.

## Quick start

**Windows:** double-click **`Start Taskboard.bat`**. Run **`Start Automatically With Windows.bat`** once to have the board start quietly (minimized) every time you sign in, so it keeps syncing whenever the computer is on. To undo that, press Win+R, type `shell:startup`, and delete "McKay's Taskboard". The first time (and after an update that needs it), it installs the Anthropic SDK with `npm install`, which takes under a minute and needs an internet connection. Run **`Create Desktop Shortcut.bat`** once for a desktop icon.

**Any system:**
```bash
cd apps/taskboard
npm install          # once: installs the Anthropic SDK
npm start            # http://127.0.0.1:3100
```

The first visit asks you to create your login.

## Connecting Google accounts

Follow **[GOOGLE-SETUP.md](GOOGLE-SETUP.md)** once. Then use **Settings → Connect Google account** for each account.

How Google Tasks sync works:
- **From Google:** open tasks in every list of every connected account appear on the board, with the account's colored badge. Tasks added, edited, completed or deleted on your phone show up here on the next sync. The board refreshes itself every minute.
- **To Google:** board tasks are written to a **Taskboard** list in their account; tasks you add by hand go to the **Primary** account. The column is noted at the end of the task's notes, e.g. `[Taskboard: Today]`, because Google Tasks has no columns. Changes are sent a few seconds after you make them.
- **Both sides changed:** the board's version wins, but completing a task anywhere completes it.
- **When the computer is off:** nothing syncs, but Google keeps everything. Your phone's Google Tasks work as usual. When the board starts again it catches up: Google Tasks and Calendar pick up where they left off. For Gmail, if the board was off longer than Gmail keeps its change history (about a week), it searches the inbox back to the last good sync, up to 60 days.
- **Schedule:** every 15 minutes by default (Settings → Sync), or press **Sync now**. Each account syncs separately, so one that needs reconnecting doesn't hold up the others.
- **Disconnect** removes the board's access to that account. Its tasks stay on the board as your own.

## The assistant (email and calendar → cards)

**Turning it on:**
1. Create an API key at **console.anthropic.com** (API keys). It's billed per use, separately from a Claude subscription.
2. Paste it into **Settings → Assistant** and click Save. It's stored encrypted, like the Google sign-ins.

**What it reads** on every sync, in each connected account:
- **Gmail, read-only:** the inbox, but not the Promotions, Social, Updates or Forums tabs. The first sync looks at the last 7 days (up to 150 threads); after that, only threads with new messages.
- **Calendar, read-only:** the next 14 days. Only events that need your reply, or that have other people or notes and are within a week.

**What it does:**
- Claude reads the latest messages in each thread and decides whether each one needs a card. If it does, it chooses the column and due date and writes a one-line reason, which shows on hover and in the edit dialog.
- Cards it adds are marked ✦ and link back to the email or event.
- When a thread moves on, the same card is updated: you replied, so it moves to **Waiting**; they confirmed, so it's completed.
- New cards go to Google Tasks too.

**Ways to steer it:**
- **Notes for the assistant** (Settings): plain sentences, e.g. "Anything from the IRS goes in Today. Ignore Stripe notifications."
- **Not a task** (in a card's edit dialog) or deleting the card: that email or event won't produce a card again.
- **Moving a card yourself:** it stays where you put it.

**Cost and model:**
- The default model is Claude Opus 5.5, the most careful about what counts as a task, run at low effort. Sonnet 5.5 and Haiku 5.5 are cheaper options in Settings.
- Emails are sent in batches of 20, so a typical day of mail costs a few cents with Opus.
- Settings shows this month's requests, tokens and estimated cost.

**Safety:**
- Claude gets no tools. It only returns a list of suggested cards in a fixed format, which the app checks before changing anything.
- An email that tries to give it instructions can at most produce a wrong card. It can't send, delete or forward anything.
- Email text is sent to Anthropic only for this. See [`legal/privacy-policy.html`](legal/privacy-policy.html).

**If something goes wrong:**
- Without a key, or if Anthropic is unavailable, email is still read and simply waits. The board shows how many items are waiting.
- An item Claude can't answer three times is set aside.

## Using the board

- **＋ New task** (or the ＋ on a column). Leave the column blank to place it from the due date: overdue/today → **Today**, within 7 days → **This week**, otherwise **Later**.
- **Drag** cards between columns or up and down within one. With the keyboard, focus a card and press **Alt+←/→** to change its column, or **Enter** to edit it.
- Click the circle to mark a task **done**. Done tasks collect in the **Done** list at the bottom, where ↺ puts one back.
- **Roll-forward:** each hour, cards with a due date move toward Today as the date gets close (Later → This week → Today). Cards never move backward, Waiting is left alone, and a card you placed yourself (gold dot ●) is never moved by the app.

## Where the data lives

`~/McKaysTaskboard/` (for example `C:\Users\you\McKaysTaskboard`): `taskboard.db` holds the tasks, and `secret.key` encrypts the Google sign-ins stored in it. The folder is outside the app folder, so none of it goes into git or OneDrive. Keep both files together when moving computers.

| Env var | Default | Purpose |
|---|---|---|
| `PORT` / `HOST` | `3100` / `127.0.0.1` | Listen address (Ledger uses 3000, so both can run) |
| `TASKBOARD_DATA_DIR` | `~/McKaysTaskboard` | Data folder |
| `TASKBOARD_DB` | `<data dir>/taskboard.db` | Exact database file |
| `TASKBOARD_TZ` | `America/Los_Angeles` | When "today" starts |
| `NODE_ENV=production` | — | Secure session cookie (serve behind HTTPS) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | — | Google app details, instead of entering them in Settings |
| `ANTHROPIC_API_KEY` | — | API key for the assistant, instead of entering it in Settings |
| `TASKBOARD_PUBLIC_URL` | address you opened | Fixes the OAuth redirect address, e.g. `https://taskboard.your-tailnet.ts.net` |

Run the tests with `npm test`.
