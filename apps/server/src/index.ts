import { serve } from '@hono/node-server';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { env } from './env';
import { initDb, closeDb } from './db/client';
import { createApp } from './http/app';
import { disposeAllTerminals } from './terminal/manager';

function freePort(start: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && start < env.port + 20) {
        resolve(freePort(start + 1, host));
      } else reject(err);
    });
    probe.once('listening', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : start;
      probe.close(() => resolve(port));
    });
    probe.listen(start, host);
  });
}

async function main() {
  initDb();
  const app = createApp();
  const port = await freePort(env.port, env.host);
  const portFile = path.join(path.dirname(env.dbPath), 'server.port');
  fs.mkdirSync(path.dirname(portFile), { recursive: true });
  fs.writeFileSync(portFile, String(port), 'utf8');

  if (port !== env.port) {
    console.warn(`[CodingAgent] port ${env.port} is already in use — listening on ${port} instead.`);
    console.warn(`[CodingAgent] A browser tab still pointed at ${env.port} would keep talking to the OLD process.`);
    console.warn('[CodingAgent] Kill the stale server and start again to get your configured port back.');
  }

  serve({ fetch: app.fetch, port, hostname: env.host }, (info) => {
    const url = `http://${env.host === '0.0.0.0' ? '127.0.0.1' : env.host}:${info.port}`;
    console.log(`[CodingAgent] server ready at ${url}`);
    // Machine-readable marker for the Tauri Rust sidecar supervisor.
    console.log(`CODINGAGENT_SERVER_READY=${info.port}`);
  });

  const shutdown = () => {
    try { fs.rmSync(portFile, { force: true }); } catch { /* ignore */ }
    try { disposeAllTerminals(); } catch { /* shells may already be gone */ }
    closeDb();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => {
  console.error('[CodingAgent] failed to start:', err);
  process.exit(1);
});
