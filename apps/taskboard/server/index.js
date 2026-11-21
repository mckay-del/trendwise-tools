import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { openDb, defaultDbPath } from './db.js';
import { createHandler } from './app.js';
import { rollForward } from './services/tasks.js';
import { syncIfDue } from './services/sync.js';

const NAME = "McKay's Taskboard";
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`${NAME} needs Node.js 22.13 or newer (you have ${process.versions.node}). Install the LTS version from https://nodejs.org`);
  process.exit(1);
}

const port = Number(process.env.PORT) || 3100;
const host = process.env.HOST || '127.0.0.1';
const dbPath = defaultDbPath();
const db = openDb(dbPath);
const server = createServer(createHandler(db));

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`Port ${port} is already in use: ${NAME} is probably already running. Close the other window (or use "Start Taskboard.bat", which does this for you).`);
  else console.error(e);
  process.exit(1);
});

// Move cards toward Today as their due dates arrive: on start, then every hour (cheap, and catches local midnight).
function roll() {
  try { const r = rollForward(db); if (r.moved) console.log(`Moved ${r.moved} task${r.moved === 1 ? '' : 's'} forward as due dates arrived`); }
  catch (e) { console.error('Roll-forward failed:', e.message); }
}
roll();
setInterval(roll, 60 * 60 * 1000).unref();

// Google sync: check every minute whether the interval chosen in Settings has passed (first check 30 seconds after start).
const syncTick = () => syncIfDue(db)?.then((results) => {
  for (const r of results) if (!r.ok) console.error(`Sync for ${r.email}: ${r.error}`);
}).catch((e) => console.error('Sync failed:', e.message));
setTimeout(syncTick, 30_000).unref();
setInterval(syncTick, 60_000).unref();

server.listen(port, host, () => {
  const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`;
  console.log(`\n${NAME} v${version} is running at ${url}`);
  console.log(`Data: ${dbPath}`);
  console.log('Leave this window open while you work. Close it (or press Ctrl+C) to stop the app.\n');
  if (process.env.TASKBOARD_OPEN_BROWSER === '1') openBrowser(url);
});

function openBrowser(url) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref(); } catch { /* user can open it manually */ }
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { server.close(() => { db.close(); process.exit(0); }); });
}
