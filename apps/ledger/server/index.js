import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { openDb, defaultDbPath, migrateLegacyDb } from './db.js';
import { createHandler } from './app.js';
import { runDue } from './services/recurring.js';
import { syncAll as syncGhl } from './services/ghl.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`Trendwise Ledger needs Node.js 22.13 or newer (you have ${process.versions.node}). Install the LTS version from https://nodejs.org`);
  process.exit(1);
}

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '127.0.0.1';
const moved = migrateLegacyDb();
if (moved) console.log(`Moved your books out of the app folder:\n  from ${moved.from}\n  to   ${moved.to}`);
const dbPath = defaultDbPath();
const db = openDb(dbPath);
const server = createServer(createHandler(db));

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`Port ${port} is already in use — Trendwise Ledger is probably already running. Close the other window (or use "Start Ledger.bat", which does this for you).`);
  else console.error(e);
  process.exit(1);
});

// Recurring transactions: create anything due now, then check every hour.
function runRecurring() {
  try {
    const r = runDue(db);
    if (r.created || r.errors) console.log(`Recurring transactions: ${r.created} created${r.errors ? `, ${r.errors} need attention` : ''}`);
  } catch (e) { console.error('Recurring transactions failed:', e.message); }
}
runRecurring();
setInterval(runRecurring, 60 * 60 * 1000).unref();

// GoHighLevel: every hour, sync the clients that are due (daily ones overnight, hourly ones each hour; first check 2 minutes after start).
let ghlRunning = false;
async function runGhl() {
  if (ghlRunning) return;
  ghlRunning = true;
  try {
    for (const r of await syncGhl(db)) {
      if (r.error) console.error(`GHL sync for company ${r.company_id} failed: ${r.error}`);
      else if (r.invoices.created + r.invoices.updated + r.payments.created + r.payments.refunds) console.log(`GHL sync company ${r.company_id}: ${r.invoices.created} invoices, ${r.payments.created} payments${r.issues ? `, ${r.issues} need attention` : ''}`);
    }
  } catch (e) { console.error('GHL sync failed:', e.message); } finally { ghlRunning = false; }
}
setTimeout(runGhl, 2 * 60 * 1000).unref();
setInterval(runGhl, 60 * 60 * 1000).unref();

server.listen(port, host, () => {
  const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`;
  console.log(`\nTrendwise Ledger v${version} is running at ${url}`);
  console.log(`Books: ${dbPath}`);
  console.log('Leave this window open while you work. Close it (or press Ctrl+C) to stop the app.\n');
  if (process.env.LEDGER_OPEN_BROWSER === '1') openBrowser(url);
});

function openBrowser(url) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref(); } catch { /* user can open it manually */ }
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { server.close(() => { db.close(); process.exit(0); }); });
}
