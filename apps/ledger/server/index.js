import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { openDb, defaultDbPath, migrateLegacyDb } from './db.js';
import { createHandler } from './app.js';

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
