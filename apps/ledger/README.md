# Trendwise Ledger

A double-entry bookkeeping application modeled on QuickBooks Online workflows, built for Trendwise Business Services to keep books for multiple client companies.

**Zero dependencies.** Node.js ≥ 22.5 (uses the built-in `node:sqlite`), a vanilla-JS single-page app, and one SQLite file. Nothing to `npm install`.

## Quick start

```bash
cd apps/ledger
npm run seed:demo     # optional: creates an admin login + a demo company with 4 months of activity
npm start             # http://127.0.0.1:3000
```

Without the demo seed, the first visit asks you to create the administrator account.

| Env var | Default | Purpose |
|---|---|---|
| `PORT` / `HOST` | `3000` / `127.0.0.1` | Listen address |
| `LEDGER_DB` | `apps/ledger/data/ledger.db` | SQLite database path (back this file up) |
| `NODE_ENV=production` | — | Adds `Secure` to the session cookie (serve behind HTTPS) |
| `LEDGER_ADMIN_EMAIL` / `LEDGER_ADMIN_PASSWORD` | `admin@example.com` / random | Used by `seed:demo` only when no users exist |

Run tests with `npm test`.

## What it does

| Area | Features |
|---|---|
| **Companies** | Multiple client companies, each seeded with a standard US service-business chart of accounts; fiscal-year start month; closing date (books lock) |
| **Sales** | Invoices (products/services, qty × rate, per-line taxable flag, sales tax), receive payment (auto-apply oldest-first, partial & over-payments), sales receipts, credit memos applied to invoices, printable invoice / PDF |
| **Expenses** | Bills, pay bills, expenses (bank/card), checks, vendor credits; billable-customer tagging on lines; vendor default categories; 1099 tracking |
| **Banking** | Upload CSV (Date/Description/Amount or Debit/Credit columns) or QFX/OFX; duplicate detection; **For review / Categorized / Excluded** tabs; add, match to existing transactions (±14 days, same amount), exclude, undo, bulk accept; **bank rules** with priority and auto-add; transfers and card payments recognized when the category is another balance-sheet account |
| **Deposits** | Payments land in Undeposited Funds by default and are grouped into bank deposits, plus other funds lines |
| **Reconcile** | Statement ending balance/date, tick cleared items, live difference, save for later, finish only at $0.00 difference, history, undo last reconciliation. Reconciled transactions are locked |
| **Accounting** | Chart of accounts with sub-accounts, detail types, system accounts, inactive accounts; journal entries with A/R–A/P name enforcement and auto-balancing; transfers; void vs. delete; full audit log |
| **Reports** | P&L (accrual **or cash basis**, total or by month), Balance Sheet, Statement of Cash Flows, Trial Balance, General Ledger / account QuickReport, Journal, Transaction List, A/R & A/P Aging (summary + detail), Sales by Customer / by Product, Sales Tax Liability, Expenses by Vendor, **1099 Contractor Summary**, Account List. Drill-down to transactions; CSV export; print |
| **Users** | Admin / Accountant / Standard / Viewer roles |

## Accounting design

- **Documents vs. ledger.** Every business document (`transactions` + `transaction_lines`) regenerates its own general-ledger postings (`journal_lines`) whenever it is saved. Posting rules live in one place — `buildJournal()` in `server/services/transactions.js` — and every posting is verified to balance before it is written.
- **Integer cents** everywhere; no floating-point money.
- **Applications** (`applications` table) link payments/credits to invoices/bills. Open balances are always derived, never stored, so they can't drift.
- **Retained earnings** are computed: the Balance Sheet and Trial Balance roll all prior-fiscal-year net income into Retained Earnings and show current-year Net Income separately, as QBO does.
- **Cash-basis P&L** recognizes invoice/bill lines proportionally on the dates they are paid; sales receipts, expenses, checks, deposits and journal entries are recognized on their own dates.
- **1099-NEC** uses only payments from bank accounts (card payments are reported on 1099-K) and applies the $600 threshold through tax year 2025 and $2,000 for payments after 2025.
- **Controls:** closing date blocks add/edit/void/delete on or before it; reconciled items can't be changed; documents with payments applied, or payments already deposited, can't be deleted or voided until unlinked; all changes are written to the audit log.

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
│   │   └── names.js        companies, customers, vendors, items, tax rates
│   └── seed-demo.js
├── public/                 single-page app (no build step)
└── test/                   node:test suites (engine + HTTP)
```

## Known gaps / next steps

Inventory (quantity on hand / FIFO), payroll, estimates & purchase orders, recurring transactions, emailing invoices, live bank connections (Plaid), classes/locations, budgets, multi-currency, attachments, and per-company user access are not yet built. Cash basis applies to the P&L only.
