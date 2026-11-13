import { createServer } from 'node:http';
import { openDb } from './db.js';
import { createHandler } from './app.js';

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '127.0.0.1';
const db = openDb();
const server = createServer(createHandler(db));

server.listen(port, host, () => {
  console.log(`Trendwise Ledger running at http://${host}:${port}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { server.close(() => { db.close(); process.exit(0); }); });
}
