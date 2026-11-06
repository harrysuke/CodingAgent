#!/usr/bin/env node
/**
 * Boot the *packaged* desktop runtime (bundled Node + bundled server + copied
 * SQLite DB) exactly the way the Tauri Rust sidecar does, and exercise the API.
 * Uses a throwaway DB copy / workspace / port so nothing in the project moves.
 *
 * Also audits the shipped DB for private data: an installer must never carry
 * the developer's chat history, telemetry, project paths, dashboard password
 * hash, plaintext unified_api_key, or provider keys they did not opt in to.
 *
 *   npm run verify:desktop
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
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
function readEnv(file) {
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx > 0) out[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}
const vars = readEnv(path.join(SERVER_DIR, '.env'));
check('packaged ENCRYPTION_KEY present', /^[0-9a-fA-F]{64}$/.test(vars.ENCRYPTION_KEY ?? ''));
check('packaged AGENT_TOKEN is not the placeholder',
  !!vars.AGENT_TOKEN && vars.AGENT_TOKEN !== 'change-me-local-dev-token');
const sourceEnvPath = path.join(ROOT, '.env');
if (vars.CODINGAGENT_INCLUDE_KEYS !== '1' && fs.existsSync(sourceEnvPath)) {
  check('packaged ENCRYPTION_KEY is not the developer key',
    vars.ENCRYPTION_KEY !== readEnv(sourceEnvPath).ENCRYPTION_KEY);
}

/**
 * Inspect the SHIPPED database with the packaged Node (its ABI matches the
 * bundled better-sqlite3 addon). This catches leaks that no HTTP endpoint can
 * reveal, because the app itself never exposes these rows.
 */
function auditPackagedDb() {
  const script = [
    "const D = require('better-sqlite3');",
    "const db = new D(process.argv[1], { readonly: true });",
    "const names = new Set(db.prepare(\"SELECT name FROM sqlite_master WHERE type='table'\").all().map(r => r.name));",
    'const n = t => names.has(t) ? db.prepare(\'SELECT COUNT(*) n FROM "\' + t + \'"\').get().n : 0;',
    "const settings = names.has('settings') ? db.prepare('SELECT key FROM settings').all().map(r => r.key) : [];",
    "console.log(JSON.stringify({ models:n('models'), api_keys:n('api_keys'), projects:n('projects'),",
    "  agent_sessions:n('agent_sessions'), agent_messages:n('agent_messages'), agent_parts:n('agent_parts'),",
    "  requests:n('requests'), users:n('users'), sessions:n('sessions'), settings }));",
    'db.close();',
  ].join('\n');
  return JSON.parse(execFileSync(node, ['-e', script, path.join(SERVER_DIR, 'data', 'codingagent.db')], {
    cwd: SERVER_DIR, encoding: 'utf8', timeout: 30_000,
  }));
}

let audit = null;
try {
  audit = auditPackagedDb();
  check('packaged DB keeps the model catalogue', audit.models > 100, `${audit.models} models`);
  check('packaged DB has no chat history',
    audit.agent_sessions === 0 && audit.agent_messages === 0 && audit.agent_parts === 0);
  check('packaged DB has no usage telemetry', audit.requests === 0);
  check('packaged DB has no legacy dashboard credentials', audit.users === 0 && audit.sessions === 0);
  check('packaged DB has no machine-specific project paths', audit.projects === 0);
  check('packaged DB has no plaintext secrets or stale workspace pointer',
    !audit.settings.some(k => /unified_api_key|encryption_key|agent:active_project/i.test(k)));
} catch (err) {
  check('packaged DB privacy audit ran', false, err?.message ?? String(err));
}
const shippedKeys = audit?.api_keys ?? 0;

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

/** AGENT_TOKEN is only the one-time setup secret; API calls use a session token. */
let sessionToken = '';
async function req(pathname, init = {}) {
  const headers = { ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}), ...(init.headers ?? {}) };
  return fetch(`${base}${pathname}`, { ...init, headers });
}

async function waitHealthy() {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) return false;
    try {
      const res = await fetch(`${base}/api/health`);
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
    // --- accounts / BYOK -------------------------------------------------
    const status = await (await fetch(`${base}/api/auth/status`)).json();
    check('first run advertises owner setup', status.needsSetup === true);

    const setupWrong = await fetch(`${base}/api/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'attacker@example.com', password: 'password123', setupToken: 'wrong' }),
    });
    check('setup token blocks a stranger claiming the keys', setupWrong.status === 403, `HTTP ${setupWrong.status}`);

    const setup = await fetch(`${base}/api/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.com', password: 'owner-password-123', name: 'Owner', setupToken: TOKEN }),
    });
    const account = setup.ok ? await setup.json() : null;
    sessionToken = account?.token ?? '';
    check('owner account created with a session token', !!sessionToken, `HTTP ${setup.status}`);
    // keyCount counts *usable* (enabled + decryptable) keys, which can be less
    // than the raw api_keys row count if one shipped key is stale/disabled.
    const baselineKeys = account?.user?.keyCount ?? 0;
    check('first admin key ring matches the shipped DB',
      shippedKeys === 0 ? baselineKeys === 0 : (baselineKeys > 0 && baselineKeys <= shippedKeys),
      `${baselineKeys} usable keys, ${shippedKeys} shipped`);
    if (shippedKeys === 0) check('fresh install starts BYOK-only', baselineKeys === 0);

    const samePath = (a, b) => path.resolve(String(a)).toLowerCase() === path.resolve(String(b)).toLowerCase();
    const health = await (await req('/api/health')).json();
    check('health reports reused database', health.ok === true && health.models > 0, `${health.models} models, ${health.providersConfigured} providers`);
    check('health is authenticated', health.authenticated === true);
    check('health uses per-user DB path', String(health.dbPath).includes('codingagent-verify-'), health.dbPath);
    // Regression: a stale agent:active_project from the developer's machine
    // used to override the injected WORKSPACE_ROOT here.
    check('health uses the injected per-user workspace',
      samePath(health.workspaceRoot, workspace), health.workspaceRoot);

    const models = await (await req('/api/models')).json();
    check('model catalogue served from copied DB', Array.isArray(models) && models.length > 100, `${models.length} models`);

    const providers = await (await req('/api/providers')).json();
    // Three providers are keyless public endpoints and always report
    // configured=true; only key-backed providers tell us anything about BYOK.
    const keyedConfigured = Array.isArray(providers)
      ? providers.filter(p => p.configured && !p.keyless).length : -1;
    check('no account can use a key-backed provider without its own key',
      keyedConfigured >= 0 && (shippedKeys > 0 ? keyedConfigured > 0 : keyedConfigured === 0),
      `${keyedConfigured} key-backed, ${Array.isArray(providers) ? providers.filter(p => p.keyless).length : '?'} keyless`);

    const keys = await (await req('/api/keys')).json();
    check('API key ring is account-scoped', Array.isArray(keys) && keys.length === shippedKeys, `${keys.length} keys`);

    const ws = await (await req('/api/workspace')).json();
    check('active workspace is the injected per-user folder',
      samePath(ws?.active?.root, workspace), ws?.active?.root);
    const projects = await (await req('/api/projects')).json();
    check('no stale project paths inherited',
      Array.isArray(projects) && projects.every(p => samePath(p.rootPath, workspace)),
      `${Array.isArray(projects) ? projects.length : '?'} projects`);
    const beforeSessions = await (await req('/api/sessions')).json();
    check('fresh install has no chat history',
      Array.isArray(beforeSessions) && beforeSessions.length === 0);

    const ui = await req('/');
    const html = await ui.text();
    check('bundled Vue UI served', ui.ok && html.includes('<div id="app"'), `${html.length} bytes`);

    const noAuth = await fetch(`${base}/api/models`);
    check('API rejects anonymous requests', noAuth.status === 401, `HTTP ${noAuth.status}`);
    const oldToken = await fetch(`${base}/api/models`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    check('AGENT_TOKEN is not an API credential', oldToken.status === 401, `HTTP ${oldToken.status}`);

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

    // --- BYOK end to end -------------------------------------------------
    // A fresh install has no provider keys. Saving one must immediately make
    // that provider's models usable and select a working default model.
    const added = await req('/api/keys', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'openrouter', key: 'sk-desktop-verify-placeholder', label: 'verify' }),
    });
    check('account can save its own provider key (BYOK)', added.status === 201, `HTTP ${added.status}`);
    const me = await (await req('/api/auth/me')).json();
    check('BYOK key is credited to this account', me?.keyCount === baselineKeys + 1, `${me?.keyCount} keys`);
    const after = await (await req('/api/models')).json();
    check('BYOK unlocks that provider models',
      Array.isArray(after) && after.some(m => m.platform === 'openrouter' && m.hasKey));
    const settings = await (await req('/api/settings')).json();
    check('BYOK selects a model this account can actually pay for',
      !!settings?.defaultPlatform && after.some(m =>
        m.platform === settings.defaultPlatform && m.modelId === settings.defaultModelId && m.hasKey),
      `${settings?.defaultPlatform}/${settings?.defaultModelId}`);
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
