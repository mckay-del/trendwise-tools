# McKay's Taskboard

One board for the tasks hiding in every Google Workspace account: email, calendar and Google Tasks, sorted into **Today / This week / Later / Waiting**.

Built on the same stack as [Trendwise Ledger](../ledger/README.md): Node.js ≥ 22.13 (built-in `node:sqlite`), a vanilla-JS page, one SQLite file.

## Status

| Step | What | State |
|---|---|---|
| 1 | Board with manual tasks: columns, drag and drop, due dates, done list, daily roll-forward | **Done (v0.1)** |
| 2 | Connect Google accounts (OAuth, encrypted tokens), two-way Google Tasks sync | Next |
| 3 | Read-only Gmail + Calendar sync across all accounts | Planned |
| 4 | Claude triage: turns emails and events into tasks, picks the column, explains why | Planned |
| 5 | Run on the Tailscale server, backups | Planned |

Access to Google will be **read-only for Gmail and Calendar**. The only thing it writes is Google Tasks, so tasks show up on your phone. It never sends email or changes events.

## Quick start

**Windows:** double-click **`Start Taskboard.bat`**. Run **`Create Desktop Shortcut.bat`** once for a desktop icon.

**Any system:**
```bash
cd apps/taskboard
npm start            # http://127.0.0.1:3100
```

The first visit asks you to create your login.

## Using the board

- **＋ New task** (or the ＋ on a column). Leave the column blank to place it from the due date: overdue/today → **Today**, within 7 days → **This week**, otherwise **Later**.
- **Drag** cards between columns or up and down within one. With the keyboard, focus a card and press **Alt+←/→** to change its column, or **Enter** to edit it.
- Click the circle to mark a task **done**. Done tasks collect in the **Done** list at the bottom, where ↺ puts one back.
- **Roll-forward:** each hour, cards with a due date move toward Today as the date gets close (Later → This week → Today). Cards never move backward, Waiting is left alone, and a card you placed yourself (gold dot ●) is never moved by the app.

## Where the data lives

`~/McKaysTaskboard/taskboard.db` (for example `C:\Users\you\McKaysTaskboard`). This is outside the app folder, so task data (and, later, Google tokens) never goes into git or OneDrive.

| Env var | Default | Purpose |
|---|---|---|
| `PORT` / `HOST` | `3100` / `127.0.0.1` | Listen address (Ledger uses 3000, so both can run) |
| `TASKBOARD_DATA_DIR` | `~/McKaysTaskboard` | Data folder |
| `TASKBOARD_DB` | `<data dir>/taskboard.db` | Exact database file |
| `TASKBOARD_TZ` | `America/Los_Angeles` | When "today" starts |
| `NODE_ENV=production` | — | Secure session cookie (serve behind HTTPS) |

Run the tests with `npm test`.
