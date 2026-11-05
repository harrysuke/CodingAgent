#!/usr/bin/env node
/**
 * Boot the *packaged* desktop runtime (bundled Node + bundled server + copied
 * SQLite DB) exactly the way the Tauri Rust sidecar does, and exercise the API.
 * Uses a throwaway DB copy / workspace / port so nothing in the project moves.
 *
 *   npm run verify:desktop
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Override to test an alternative assembled runtime without touching the project.
const RES = process.env.CODINGAGENT_RESOURCES
  ? path.resolve(process.env.CODINGAGENT_RESOURCES)
  : path.join(ROOT, 'apps', 'desktop', 'src-tauri', 'resources');
const SERVER_DIR = path.join(RES, 'server');
const TOKEN = 'desktop-verify-token';

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`  PASS  ${name}${detail ? ` - ${detail}` : ''}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`); }
};

function fail(message) {
  console.error(`[verify-desktop] ${message}`);
  process.exit(1);
}

const manifestPath = path.join(RES, 'manifest.json');
if (!fs.existsSync(manifestPath)) {
  fail('resources missing - run `npm run desktop:build` (or `node scripts/prepare-desktop.mjs`) first.');
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const node = path.join(RES, manifest.nodeBinary);
const entry = path.join(SERVER_DIR, 'index.js');
for (const p of [node, entry, path.join(SERVER_DIR, 'server-runtime.json'), path.join(SERVER_DIR, 'data', 'codingagent.db')]) {
  if (!fs.existsSync(p)) fail(`missing packaged asset: ${p}`);
}

// Mirror Rust's env injection: parse the shipped .env, then override the
// per-user paths / port with real environment variables (dotenv won't clobber).
const vars = {};
for (const line of fs.readFileSync(path.join(SERVER_DIR, '.env'), 'utf8').split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const idx = trimmed.indexOf('=');
  if (idx > 0) vars[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
}
check('inherited ENCRYPTION_KEY present', /^[0-9a-fA-F]{64}$/.test(vars.ENCRYPTION_KEY ?? ''));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codingagent-verify-'));
const dbPath = path.join(tmp, 'codingagent.db');
const workspace = path.join(tmp, 'workspace');
fs.copyFileSync(path.join(SERVER_DIR, 'data', 'codingagent.db'), dbPath);
fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(path.join(workspace, 'README.md'), '# verify workspace\n');

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.once('listening', () => { const p = s.address().port; s.close(() => resolve(p)); });
  s.listen(0, '127.0.0.1');
});

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
console.log(`[verify-desktop] booting ${manifest.nodeBinary} on ${base}`);

const child = spawn(node, [entry], {
  cwd: SERVER_DIR,
  env: {
    ...process.env,
    ...vars,
    HOST: '127.0.0.1',
    PORT: String(port),
    DB_PATH: dbPath,
    WORKSPACE_ROOT: workspace,
    AGENT_TOKEN: TOKEN,
    CODINGAGENT_DESKTOP: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', d => { output += d.toString(); });
child.stderr.on('data', d => { output += d.toString(); });

async function req(pathname, init = {}) {
  const headers = { Authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) };
  return fetch(`${base}${pathname}`, { ...init, headers });
}

async function waitHealthy() {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) return false;
    try {
      const res = await req('/api/health');
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

let healthy = false;
try {
  healthy = await waitHealthy();
  check('packaged server becomes healthy', healthy, healthy ? `${base}/api/health` : output.slice(-800));

  if (healthy) {
    const health = await (await req('/api/health')).json();
    check('health reports reused database', health.ok === true && health.models > 0, `${health.models} models, ${health.providersConfigured} providers`);
    check('health uses per-user DB path', String(health.dbPath).includes('codingagent-verify-'), health.dbPath);
    check('health uses per-user workspace', String(health.workspaceRoot).includes('codingagent-verify-'), health.workspaceRoot);

    const models = await (await req('/api/models')).json();
    check('model catalogue served from copied DB', Array.isArray(models) && models.length > 100, `${models.length} models`);

    const providers = await (await req('/api/providers')).json();
    check('provider registry decrypts inherited keys', Array.isArray(providers) && providers.some(p => p.configured), `${providers.filter(p => p.configured).length} configured`);

    const keys = await (await req('/api/keys')).json();
    check('encrypted API keys readable', Array.isArray(keys) && keys.length > 0, `${keys.length} keys`);

    const ui = await req('/');
    const html = await ui.text();
    check('bundled Vue UI served', ui.ok && html.includes('<div id="app"'), `${html.length} bytes`);

    const noAuth = await fetch(`${base}/api/health`);
    check('token gate rejects anonymous requests', noAuth.status === 401, `HTTP ${noAuth.status}`);

    const created = await req('/api/sessions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'desktop verification' }),
    });
    const session = created.ok ? await created.json() : null;
    check('agent session can be created', !!session?.id, session?.id ?? `HTTP ${created.status}`);
    if (session?.id) {
      const sessions = await (await req('/api/sessions')).json();
      check('created session persists in SQLite', Array.isArray(sessions) && sessions.some(s => s.id === session.id));
    }

    const tree = await req('/api/files/tree');
    check('workspace sandbox reachable', tree.ok, `HTTP ${tree.status}`);
  }
} catch (err) {
  check('API exercise completed without exceptions', false, err?.message ?? String(err));
} finally {
  child.kill();
  await new Promise(r => setTimeout(r, 300));
  if (child.exitCode === null) child.kill('SIGKILL');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

if (!healthy || failed) {
  console.error('\n[verify-desktop] server output:\n' + output.slice(-3000));
}
console.log(`\n[verify-desktop] ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
