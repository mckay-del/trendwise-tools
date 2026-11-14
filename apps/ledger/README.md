# Trendwise Ledger

A double-entry bookkeeping application modeled on QuickBooks Online workflows, built for Trendwise Business Services to keep books for multiple client companies.

**Zero dependencies.** Node.js ≥ 22.5 (uses the built-in `node:sqlite`), a vanilla-JS single-page app, and one SQLite file. Nothing to `npm install`.

## Quick start

**Windows:** double-click **`Start Ledger.bat`** in this folder. It stops any copy that's already running, starts the app and opens your browser. Run **`Create Desktop Shortcut.bat`** once to put a "Trendwise Ledger" icon on your desktop. Keep the black window open while you work; close it to stop the app.

**Any system:**
```bash
cd apps/ledger
npm run seed:demo     # optional: creates an admin login + a demo company with 4 months of activity
npm start             # http://127.0.0.1:3000
```

Requires Node.js 22.13 or newer (install the LTS from nodejs.org). Without the demo seed, the first visit asks you to create the administrator account. The app version is shown at the bottom of the left menu.

### Running it on a cloud server (no computer needs to stay on)

See **[SERVER-SETUP.md](SERVER-SETUP.md)**. One command sets up a fresh Ubuntu server (for example a $6/month DigitalOcean Droplet): it runs as a locked-down service, takes nightly encrypted backups, installs security updates automatically, blocks the public internet, and is reachable only through your Tailscale network. Move your books over with **Restore a backup** on the first-run screen.

### Using the same books from another computer

See **[REMOTE-ACCESS.md](REMOTE-ACCESS.md)**. One computer keeps the books, and your other computers open them in a browser over Tailscale (private and encrypted). Helpers: `Share With My Other Computers.bat`, `Stop Sharing.bat`, `Start Automatically With Windows.bat`. If two people edit the same transaction at once, the second save is refused with a "reload to see their changes" message instead of overwriting.

### Where the books are stored

In a **`TrendwiseLedger`** folder in your user folder (for example `C:\Users\you\TrendwiseLedger\ledger.db`), deliberately **outside** the app folder, so client data never syncs to OneDrive or goes into git with the code. Settings → Backup shows the exact path. Books from older versions (stored in `apps/ledger/data`) are copied there automatically the first time the new version starts. The old copy is left in place with a note, and you can delete it once you've checked everything.

| Env var | Default | Purpose |
|---|---|---|
| `PORT` / `HOST` | `3000` / `127.0.0.1` | Listen address |
| `LEDGER_DATA_DIR` | `~/TrendwiseLedger` | Folder for the database and command-line backups |
| `LEDGER_DB` | `<data dir>/ledger.db` | Exact database file (overrides the folder) |
| `NODE_ENV=production` | — | Adds `Secure` to the session cookie (serve behind HTTPS) |
| `LEDGER_TZ` | `America/Los_Angeles` | Time zone for recurring due dates and for converting GHL payment times to dates |
| `LEDGER_ADMIN_EMAIL` / `LEDGER_ADMIN_PASSWORD` | `admin@example.com` / random | Used by `seed:demo` only when no users exist |

Run tests with `npm test`.

## What it does

| Area | Features |
|---|---|
| **Companies** | Multiple client companies, each seeded with a standard US service-business chart of accounts; fiscal-year start month; closing date (books lock) |
| **Sales** | Invoices (products/services, qty × rate, per-line taxable flag, sales tax), receive payment (auto-apply oldest-first, partial & over-payments), sales receipts, credit memos applied to invoices, printable invoice / PDF |
| **Expenses** | Bills, pay bills, expenses (bank/card), checks, vendor credits; billable-customer tagging on lines; vendor default categories; 1099 tracking |
| **Banking** | Upload CSV (Date/Description/Amount or Debit/Credit columns) or QFX/OFX; duplicate detection; **For review / Categorized / Excluded** tabs; add, match to existing transactions (±14 days, same amount), exclude, undo, bulk accept; **bank rules** with priority and auto-add; transfers and card payments recognized when the category is another balance-sheet account |
| **Bank file uploads** | Preview before importing, with a column picker (header row, date, description, one amount or separate money-out/in columns, flip signs) remembered per account. Handles banks that put account details above the header, Excel (.xlsx), CSV and QFX/OFX. Each account shows **bank data through** and when it was last imported, and the upload screen tells you where to start the next download |
| **Import from QuickBooks Online** | Settings → *Import from QuickBooks*. Uses QuickBooks' own Excel exports: **Account List** (types, detail types, sub-accounts, A/R and A/P linked to the system accounts, optional cleanup of unused starter accounts), **Customers**, **Vendors** (incl. 1099 flag and tax ID), and **opening balances** from a **Trial Balance** plus **A/R and A/P Aging Detail**, so open invoices, bills and customer/vendor aging carry over. Every step previews exactly what will happen; the opening-balance import can be undone |
| **Deposits** | Payments land in Undeposited Funds by default and are grouped into bank deposits, plus other funds lines |
| **Deposits from Banking** | A money-in bank line that equals a payment waiting in Undeposited Funds (a wire or check for a synced GHL invoice) shows **Match: Payment (undeposited)**; one click creates the deposit and clears it. For a Stripe payout, **From payments** lets you tick the payments it contains and records the difference as the processing fee |
| **Reconcile** | Statement ending balance/date, tick cleared items, live difference, save for later, finish only at $0.00 difference, history, undo last reconciliation. Reconciled transactions are locked |
| **Accounting** | Chart of accounts with sub-accounts, detail types, system accounts, inactive accounts; journal entries with A/R–A/P name enforcement and auto-balancing; transfers; void vs. delete; full audit log |
| **Reports** | P&L (accrual **or cash basis**, total or by month), Balance Sheet, Statement of Cash Flows, Trial Balance, General Ledger / account QuickReport, Journal, Transaction List, A/R & A/P Aging (summary + detail), Sales by Customer / by Product, Sales Tax Liability, Expenses by Vendor, **1099 Contractor Summary**, Account List. Drill-down to transactions; CSV export; print |
| **Report customization** | **P&L**: compare to previous year or previous period with $ and % change, % of income, columns by month or quarter, filter by customer or vendor, show zero rows. **Balance Sheet**: compare to prior year / prior month-end with $ and % change. **General Ledger**: pick accounts, choose columns (incl. **Split**), sort by date/number/name/amount, filter by customer or vendor |
| **Saved reports** | Save any customization by name and rerun it in one click. Relative periods (“Last month”, “This fiscal year to date”, …) are stored as the period, so a saved report stays current |
| **Client report package** | Firm-branded, print-ready statements (cover page with your note, P&L, Balance Sheet, optional GL and A/R / A/P aging), each on its own page with repeating headers and your disclaimer footer. Print or **Save as PDF** from the browser |
| **Backups** | Settings → *Download encrypted backup* (AES-256-GCM, passphrase-derived key). Command line: `npm run backup` / `npm run restore` |
| **Recurring transactions** | Invoices, sales receipts, bills, expenses, checks, deposits, transfers and journal entries on weekly / monthly / quarterly / yearly schedules (every N, a set day or the last day of the month, optional end date). **Automatic** templates are created on their date (checked hourly, catching up if the server was off); **reminders** wait on the Recurring page and dashboard for Create / Skip. Make recurring from any saved transaction; edit templates on the normal form |
| **Split bank lines** | On Banking › For review, split one bank line across several categories (loan principal + interest, a store run split between supplies and meals); it saves only when the lines add up to the bank amount |
| **Attachments** | Attach receipts, bills and statements (PDF, JPG/PNG/HEIC photos, Excel, Word, CSV; 10 MB each) to any transaction by browsing or drag-and-drop. Types are verified from file content; stored in the database so backups include them; 📎 shown in lists |
| **Month-end close** | Per-client, per-month checklist. **Automatic checks:** bank and cards reconciled through month end, nothing left For review, Uncategorized cleared, Undeposited Funds, negative bank balances, Opening Balance Equity. **Sign-offs:** P&L, Balance Sheet and A/R & A/P reviewed, filings done, package sent, plus notes. **Close the month** sets the closing date, and **Reopen** restores the previous one. The Companies page shows each client's close status |
| **GoHighLevel sync** | Per client: connect the GHL sub-account (Location ID + a read-only Private Integration key with `invoices.readonly` and `payments/transactions.readonly`). On each client's schedule (**daily overnight** by default, hourly, or manual only) or with **Sync now**, the ledger pulls new and changed **invoices** (products become Products & Services; discounts, tax, edits and voids carry over) and **payments** (applied to their invoice into Undeposited Funds; funnel or order payments become sales receipts; refunds recorded). A start date keeps earlier GHL activity out so opening A/R isn't double-counted. **Preview** shows exactly what a sync would do; anything it can't bring in is listed under *Needs attention*. Read-only on the GHL side, and outbound-only, so the server stays private |
| **Users** | Admin / Accountant / Standard / Viewer roles |

## Accounting design

- **Documents vs. ledger.** Every business document (`transactions` + `transaction_lines`) regenerates its own general-ledger postings (`journal_lines`) whenever it is saved. Posting rules live in one place — `buildJournal()` in `server/services/transactions.js` — and every posting is verified to balance before it is written.
- **Integer cents** everywhere; no floating-point money.
- **Applications** (`applications` table) link payments/credits to invoices/bills. Open balances are always derived, never stored, so they can't drift.
- **Retained earnings** are computed: the Balance Sheet and Trial Balance roll all prior-fiscal-year net income into Retained Earnings and show current-year Net Income separately, as QBO does.
- **Cash-basis P&L** recognizes invoice/bill lines proportionally on the dates they are paid; sales receipts, expenses, checks, deposits and journal entries are recognized on their own dates.
- **1099-NEC** uses only payments from bank accounts (card payments are reported on 1099-K) and applies the $600 threshold through tax year 2025 and $2,000 for payments after 2025.
- **Controls:** closing date blocks add/edit/void/delete on or before it; reconciled items can't be changed; documents with payments applied, or payments already deposited, can't be deleted or voided until unlinked; all changes are written to the audit log.

## Moving a client from QuickBooks Online

1. Create the company, then open **Settings → Import from QuickBooks**.
2. Pick a cutover date, ideally the end of a month you've reconciled in QuickBooks.
3. Export from QuickBooks (Excel is fine): Account List, Customers, Vendors, then Trial Balance, A/R Aging Detail and A/P Aging Detail **as of the cutover date, accrual basis**.
4. Import the four steps in order, previewing each.
5. Compare the Balance Sheet, Trial Balance and both aging reports with QuickBooks as of the cutover date. They should match exactly.
6. Set the closing date to the cutover date, and upload bank activity from the next day onward.

Notes: the year-to-date income and expense balances on the trial balance post on the cutover date, so monthly P&L detail before the cutover stays in QuickBooks. Choose a fiscal year-end cutover if you want clean monthly reports for the new year. The opening bank balance is a single uncleared line. In your first reconciliation, tick it along with any checks that were still outstanding in QuickBooks.

## Backups

```bash
npm run backup                                      # prompts for a passphrase; writes ~/TrendwiseLedger/backups/ledger-backup-<timestamp>.twlbak
npm run restore -- backups/<file>.twlbak --to restored.db
LEDGER_DB=restored.db npm start                     # run from the restored copy
```

Backups contain every company. They are encrypted with a key derived from your passphrase (scrypt); **a lost passphrase cannot be recovered**. Store backups off this computer. Set `LEDGER_BACKUP_PASSPHRASE` to schedule `npm run backup` with cron or Windows Task Scheduler. Settings shows the date of the last backup and turns red after 7 days.

## Recommended setup (internal firm tool)

Clients never log in; you send them the report package. Run the app on your own computer (it listens on `127.0.0.1` only by default), turn on full-disk encryption (FileVault / BitLocker), and keep regular encrypted backups off the machine. Document these controls in your written information security plan (FTC Safeguards Rule / IRS Pub. 4557).

## Security

- Passwords hashed with scrypt; 14-day HTTP-only, `SameSite=Strict` session cookies (token stored hashed); login throttling.
- CSRF defense: every mutating request must carry `X-Requested-With: ledger` (browsers can't add it cross-site without a CORS preflight, which is never granted).
- Strict Content-Security-Policy (no inline scripts), `X-Frame-Options: DENY`, `nosniff`; static file serving confined to `public/`.
- Every company-scoped query is filtered by company id. Note: all active users can access all companies (firm model) — add per-company access if clients will log in themselves.

## Layout

```
apps/ledger/
├── server/
│   ├── index.js            HTTP server entry
│   ├── app.js              routes, auth/role checks, static files
│   ├── schema.sql          database schema
│   ├── services/
│   │   ├── transactions.js validation + posting engine
│   │   ├── reports.js      financial statements & reports
│   │   ├── banking.js      import, feed, rules, reconciliation
│   │   ├── accounts.js     chart of accounts
│   │   ├── names.js        companies, customers, vendors, items, tax rates
│   │   ├── saved.js        saved (memorized) reports
│   │   ├── qboImport.js    QuickBooks Online import (accounts, names, opening balances)
│   │   ├── tabular.js      CSV and Excel (.xlsx) reader
│   │   └── firm.js         firm branding for client packages
│   ├── backup.js / backup-cli.js   encrypted backup & restore
│   └── seed-demo.js
├── public/                 single-page app (no build step)
└── test/                   node:test suites (engine + HTTP)
```

## Known gaps / next steps

Inventory (quantity on hand / FIFO), payroll, estimates & purchase orders, emailing invoices, live bank connections (Plaid), classes/locations, budgets, multi-currency, and per-company user access are not yet built. Cash basis applies to the P&L only. PDFs are produced with the browser's “Save as PDF” rather than generated on the server.
