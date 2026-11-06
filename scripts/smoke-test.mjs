/**
 * End-to-end smoke test for CodingAgent accounts / BYOK.
 *
 *   npm run smoke             -> API + account isolation checks
 *   npm run smoke -- --chat   -> also run one live agent turn (needs a working key)
 *   npm run smoke -- --tools  -> also run tool + permission flow
 *
 * By default this script boots its OWN server against a throwaway copy of
 * data/codingagent.db on a random port. That is deliberate: verifying the
 * first-admin setup flow requires a database with zero accounts, and doing
 * that on the real database would let a smoke run claim the owner's provider
 * keys. Nothing in the project's real DB, settings or workspaces is changed.
 *
 * The copied DB keeps the inherited model catalogue and encrypted keys, so the
 * live --chat / --tools tests still exercise real providers.
 *
 * Set AGENT_URL + SMOKE_TOKEN to test an already-running server instead
 * (SMOKE_TOKEN must be an account session token, not AGENT_TOKEN).
 */
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = fs.readFileSync(path.join(root, '.env'), 'utf8');
const get = (key, fallback) => (envFile.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1] ?? fallback).trim();
const liveChat = process.argv.includes('--chat');
const testTools = process.argv.includes('--tools');

let passed = 0;
let failed = 0;
function ok(name, condition, detail = '') {
  if (condition) { passed++; console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.once('listening', () => { const p = s.address().port; s.close(() => resolve(p)); });
  s.listen(0, '127.0.0.1');
});

/**
 * better-sqlite3 is a native addon compiled for one Node ABI. Agent shells
 * often inject a different Node into PATH, so pick a binary that can actually
 * open an in-memory database instead of assuming process.execPath works.
 */
function workingNode() {
  const candidates = [
    process.env.CA_NODE_BIN,
    process.execPath,
    path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'nodejs', 'node.exe'),
    path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'nodejs', 'node.exe'),
    '/usr/bin/node', '/usr/local/bin/node',
  ].filter(Boolean);
  for (const bin of candidates) {
    try {
      execFileSync(bin, ['-e', "const D=require('better-sqlite3');const d=new D(':memory:');d.close();"],
        { cwd: root, stdio: 'ignore', timeout: 15_000 });
      return bin;
    } catch { /* wrong ABI or not installed */ }
  }
  throw new Error('No Node binary can load better-sqlite3. Run `npm rebuild better-sqlite3` with your normal Node, or set CA_NODE_BIN.');
}

let base = process.env.AGENT_URL ?? '';
let token = process.env.SMOKE_TOKEN ?? '';
let child = null;
let tmpDir = null;
let serverOutput = '';
/** All file writes from the isolated run must land here, never in the real workspace. */
let smokeWorkspace = path.join(root, 'workspace');

// ---------------------------------------------------------------------------
// Boot an isolated server (default) or use an explicitly supplied one
// ---------------------------------------------------------------------------
if (!base) {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-smoke-'));
  const dbPath = path.join(tmpDir, 'codingagent.db');
  const sourceDb = path.join(root, 'data', 'codingagent.db');
  if (!fs.existsSync(sourceDb)) {
    console.error('Missing data/codingagent.db — run `npm run setup` first.');
    process.exit(1);
  }
  // Copy the DB and its WAL so recent committed pages survive. The -shm file is
  // a process-local index and must NOT be copied; SQLite rebuilds it.
  fs.copyFileSync(sourceDb, dbPath);
  if (fs.existsSync(sourceDb + '-wal')) fs.copyFileSync(sourceDb + '-wal', dbPath + '-wal');

  // The live DB may already have an owner account (after migration) with keys,
  // sessions and settings bound to it. The smoke suite deliberately tests the
  // first-run setup flow, so its throwaway COPY must be reset to a pristine
  // pre-account state. The real DB is never touched.
  const nodeBin = workingNode();
  const sanitizeSql = [
    'DELETE FROM agent_user_sessions;',
    'DELETE FROM agent_users;',
    'DELETE FROM agent_user_settings;',
    'DELETE FROM agent_sessions;',
    'DELETE FROM agent_permissions;',
    'DELETE FROM requests;',
    "DELETE FROM settings WHERE key LIKE 'agent:%';",
    'UPDATE api_keys SET user_id = NULL;',
    'UPDATE projects SET user_id = NULL;',
  ].join('\n');
  execFileSync(nodeBin, ['-e', `
    const D = require('better-sqlite3');
    const db = new D(process.env.CA_SMOKE_DB_PATH);
    db.pragma('journal_mode = DELETE');
    db.exec(${JSON.stringify(sanitizeSql)});
    db.exec('VACUUM');
    db.close();
  `], {
    cwd: root,
    env: { ...process.env, CA_SMOKE_DB_PATH: dbPath },
    stdio: 'ignore',
  });

  const workspaceRoot = path.join(tmpDir, 'workspaces');
  fs.mkdirSync(workspaceRoot, { recursive: true });
  smokeWorkspace = path.join(tmpDir, 'workspace');
  fs.mkdirSync(smokeWorkspace, { recursive: true });
  fs.writeFileSync(path.join(smokeWorkspace, 'README.md'), '# smoke workspace\n');
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const setupToken = crypto.randomBytes(24).toString('base64url');

  const entry = path.join(root, 'apps', 'server', 'dist', 'index.js');
  if (!fs.existsSync(entry)) {
    console.error('Missing apps/server/dist/index.js — run `npm run build -w @codingagent/server` first.');
    process.exit(1);
  }
  child = spawn(nodeBin, [entry], {
    cwd: root,
    env: {
      ...process.env,
      DB_PATH: dbPath,
      PORT: String(port),
      HOST: '127.0.0.1',
      USER_WORKSPACES_ROOT: workspaceRoot,
      ENCRYPTION_KEY: get('ENCRYPTION_KEY', ''),
      AGENT_TOKEN: setupToken,
      AGENT_ALLOW_USER_SHELL: 'false',
      ALLOW_REGISTRATION: 'true',
      CODINGAGENT_SMOKE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', d => { serverOutput += d.toString(); });
  child.stderr.on('data', d => { serverOutput += d.toString(); });

  let ready = false;
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) break;
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) { ready = true; break; }
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 200));
  }
  if (!ready) {
    console.error(`[smoke] isolated server did not start.\n${serverOutput.slice(-3000)}`);
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
    process.exit(1);
  }
  // Keep the setup token for the first-admin registration below.
  process.env.CA_SMOKE_SETUP_TOKEN = setupToken;
}

function cleanup() {
  if (child) {
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
    setTimeout(() => { if (child && child.exitCode === null) child.kill('SIGKILL'); }, 500).unref?.();
  }
  if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } }
}
process.on('exit', cleanup);

console.log(`CodingAgent smoke test → ${base}\n`);

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------
async function raw(pathname, init = {}, bearer = '') {
  const headers = {
    ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    ...(init.headers ?? {}),
  };
  const res = await fetch(`${base}${pathname}`, { ...init, headers });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}
const request = (p, init = {}) => raw(p, init, token);
const asUser = (p, init = {}, t = token) => raw(p, init, t);

// ---------------------------------------------------------------------------
// Accounts / BYOK
// ---------------------------------------------------------------------------
console.log('  Accounts / BYOK…');
const useExternal = !!process.env.AGENT_URL;
let userBToken = '';
const userBEmail = `userb-${Date.now()}@smoke.test`;
const userBPassword = 'smoke-user-b-password';

if (!useExternal) {
  const status = await raw('/api/auth/status');
  ok('GET /api/auth/status (first run needs setup)', status.status === 200 && status.body.needsSetup === true);

  const anonymous = await raw('/api/models');
  ok('Anonymous API request is rejected', anonymous.status === 401, `HTTP ${anonymous.status}`);

  const wrongToken = await raw('/api/auth/register', {
    method: 'POST', body: JSON.stringify({ email: 'stranger@smoke.test', password: 'stranger-password', setupToken: 'wrong' }),
  });
  ok('Wrong setup token cannot claim the owner keys', wrongToken.status === 403, `HTTP ${wrongToken.status}`);

  const setup = await raw('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      email: `owner-${Date.now()}@smoke.test`, password: 'smoke-owner-password',
      name: 'Owner', setupToken: process.env.CA_SMOKE_SETUP_TOKEN,
    }),
  });
  token = setup.body?.token ?? '';
  ok('First admin registers with the setup token', setup.status === 201 && !!token, `HTTP ${setup.status}`);
  ok('First admin is an administrator', setup.body?.user?.isAdmin === true);
  ok('First admin claims the inherited provider keys', (setup.body?.user?.keyCount ?? 0) >= 10,
    `${setup.body?.user?.keyCount ?? 0} keys`);

  const statusAfter = await raw('/api/auth/status');
  ok('Setup closes after the first account', statusAfter.body?.needsSetup === false);
  ok('Setup-token weakness is no longer disclosed', statusAfter.body?.setupTokenIsDefault === false);
} else if (!token) {
  console.error('AGENT_URL requires SMOKE_TOKEN (an account session token).');
  process.exit(1);
}

const me = await request('/api/auth/me');
ok('GET /api/auth/me', me.status === 200 && typeof me.body?.email === 'string', me.body?.email);

// The copied DB carries an active-project pointer into the owner's real
// folders. Rebind it immediately so every new session (and every write tool)
// stays inside the throwaway workspace for this run.
if (!useExternal) {
  const openedIsolated = await request('/api/workspace/open', {
    method: 'POST', body: JSON.stringify({ path: smokeWorkspace, name: 'smoke' }),
  });
  ok('Isolated run rebinds the sandbox to a temp workspace',
    openedIsolated.status === 200 && String(openedIsolated.body?.root).includes('ca-smoke-'),
    openedIsolated.body?.root);
}

const oldSecret = await raw('/api/models', {}, get('AGENT_TOKEN', 'change-me-local-dev-token'));
ok('AGENT_TOKEN is not an API credential', oldSecret.status === 401, `HTTP ${oldSecret.status}`);

// ---------------------------------------------------------------------------
// Existing API surface (now authenticated)
// ---------------------------------------------------------------------------
const health = await request('/api/health');
ok('GET /api/health', health.status === 200 && health.body.ok === true, `${health.body.models} models`);
ok('Health is authenticated', health.body.authenticated === true);
ok('DB is the reused codingagent.db', String(health.body.dbPath).includes('codingagent.db'));
ok('Reused model catalog is intact', health.body.models >= 100, `${health.body.models} rows`);
ok('Providers configured from copied keys', health.body.providersConfigured >= 10, `${health.body.providersConfigured} providers`);

const models = await request('/api/models');
ok('GET /api/models', Array.isArray(models.body) && models.body.length === health.body.models);
ok('Tool-capable models present', models.body.filter(m => m.supportsTools && m.hasKey).length > 10);

const keys = await request('/api/keys');
ok('GET /api/keys (decryption works)', Array.isArray(keys.body) && keys.body.length >= 16 && keys.body.every(k => k.decryptable),
  `${keys.body.filter(k => k.decryptable).length}/${keys.body.length} decryptable`);

const settings = await request('/api/settings');
ok('GET /api/settings', settings.status === 200 && typeof settings.body.permissionMode === 'string',
  `permission=${settings.body.permissionMode}`);

const session = await request('/api/sessions', { method: 'POST', body: JSON.stringify({ title: 'Smoke test session' }) });
ok('POST /api/sessions', session.status === 201 && !!session.body.id, session.body.id);
const id = session.body.id;

const detail = await request(`/api/sessions/${id}`);
ok('GET /api/sessions/:id', detail.status === 200 && Array.isArray(detail.body.messages));

const patched = await request(`/api/sessions/${id}`, { method: 'PATCH', body: JSON.stringify({ title: 'Renamed', agent: 'plan' }) });
ok('PATCH /api/sessions/:id', patched.status === 200 && patched.body.title === 'Renamed' && patched.body.agent === 'plan');

const files = await request('/api/files/tree?depth=2');
ok('GET /api/files/tree', files.status === 200 && Array.isArray(files.body.entries));

const analytics = await request('/api/analytics');
ok('GET /api/analytics (reused requests table)', analytics.status === 200 && typeof analytics.body.requests === 'number',
  `${analytics.body.requests} logged requests`);

// SSE handshake (GET with token in query, as mobile WebViews do).
const controller = new AbortController();
const sse = await fetch(`${base}/api/sessions/${id}/events?token=${encodeURIComponent(token)}`, {
  headers: { Accept: 'text/event-stream' }, signal: controller.signal,
});
const reader = sse.body.getReader();
const first = await Promise.race([
  reader.read(),
  new Promise(resolve => setTimeout(() => resolve({ value: new TextEncoder().encode('event: timeout') }), 4000)),
]);
const firstChunk = new TextDecoder().decode(first.value ?? new Uint8Array());
controller.abort();
ok('GET /api/sessions/:id/events (SSE ready)', sse.status === 200 && firstChunk.includes('event: ready'), firstChunk.split('\n')[0]);

// ---------------------------------------------------------------------------
// Second account: BYOK + isolation assertions
// ---------------------------------------------------------------------------
console.log('\n  Multi-user isolation…');
const regB = await raw('/api/auth/register', {
  method: 'POST', body: JSON.stringify({ email: userBEmail, password: userBPassword, name: 'User B' }),
});
userBToken = regB.body?.token ?? '';
ok('A new account can register without a setup token', regB.status === 201 && !!userBToken, `HTTP ${regB.status}`);
ok('New account is not an administrator', regB.body?.user?.isAdmin === false);
ok('New account starts with ZERO provider keys (BYOK)', regB.body?.user?.keyCount === 0,
  `${regB.body?.user?.keyCount} keys`);

const keysB = await asUser('/api/keys', {}, userBToken);
ok('User B cannot see the owner keys', keysB.status === 200 && keysB.body.length === 0, `${keysB.body?.length} keys`);

const providersB = await asUser('/api/providers', {}, userBToken);
ok('User B has no configured paid provider', providersB.body.filter(p => p.configured && !p.keyless).length === 0);

const modelsB = await asUser('/api/models', {}, userBToken);
ok('User B has no models with a usable key', modelsB.body.filter(m => m.hasKey).length === 0);

const sessionsB = await asUser('/api/sessions', {}, userBToken);
ok('User B cannot see the owner sessions', Array.isArray(sessionsB.body) && !sessionsB.body.some(s => s.id === id));

const crossSession = await asUser(`/api/sessions/${id}`, {}, userBToken);
ok('User B cannot read an owner session by id', crossSession.status === 404, `HTTP ${crossSession.status}`);

const crossChat = await asUser(`/api/sessions/${id}/chat`, {
  method: 'POST', body: JSON.stringify({ text: 'hello from user B' }),
}, userBToken);
ok('User B cannot spend owner keys via chat', crossChat.status === 404, `HTTP ${crossChat.status}`);

const crossSse = await asUser(`/api/sessions/${id}/events`, {}, userBToken);
ok('User B cannot subscribe to owner SSE', crossSse.status === 404, `HTTP ${crossSse.status}`);

const workspaceB = await asUser('/api/workspace', {}, userBToken);
ok('User B gets its own private workspace', !!workspaceB.body?.active?.root
  && String(workspaceB.body.active.root).includes('workspaces'), workspaceB.body?.active?.root);

const escapeOpen = await asUser('/api/workspace/open', {
  method: 'POST', body: JSON.stringify({ path: root }),
}, userBToken);
ok('User B cannot open a folder outside its sandbox', escapeOpen.status === 400, `HTTP ${escapeOpen.status}`);

const escapeProject = await asUser('/api/projects', {
  method: 'POST', body: JSON.stringify({ name: 'escape', rootPath: root }),
}, userBToken);
ok('User B cannot register an external project root', escapeProject.status === 403, `HTTP ${escapeProject.status}`);

const escapeAttach = await asUser('/api/attachments/resolve', {
  method: 'POST', body: JSON.stringify({ paths: [{ path: path.join(root, '.env') }] }),
}, userBToken);
ok('User B cannot attach a host file', escapeAttach.status === 200
  && escapeAttach.body?.attachments?.length === 0
  && escapeAttach.body?.errors?.length === 1, JSON.stringify(escapeAttach.body?.errors?.[0]?.error ?? ''));

const shellB = await asUser('/api/terminal', { method: 'POST' }, userBToken);
ok('User B has no shell by default', shellB.status === 403, `HTTP ${shellB.status}`);

const ownKey = await asUser('/api/keys', {
  method: 'POST', body: JSON.stringify({ platform: 'custom', key: 'sk-smoke-user-b', label: 'smoke', baseUrl: 'http://127.0.0.1:1/v1' }),
}, userBToken);
ok('User B can add its own key', ownKey.status === 201 && !!ownKey.body?.id, `key #${ownKey.body?.id}`);
const keysBAfter = await asUser('/api/keys', {}, userBToken);
ok('User B sees only its own key', keysBAfter.body.length === 1);
const keysOwnerAfter = await request('/api/keys');
ok('Owner key ring is unchanged by User B', keysOwnerAfter.body.length === keys.body.length
  && !keysOwnerAfter.body.some(k => k.id === ownKey.body?.id));
const meBAfter = await asUser('/api/auth/me', {}, userBToken);
ok('keyCount updates after BYOK onboarding', meBAfter.body?.keyCount === 1, `${meBAfter.body?.keyCount}`);

const pwChange = await asUser('/api/auth/password', {
  method: 'POST', body: JSON.stringify({ current: userBPassword, next: 'smoke-user-b-password-2' }),
}, userBToken);
ok('Password change succeeds', pwChange.status === 200, `HTTP ${pwChange.status}`);
const afterPw = await asUser('/api/models', {}, userBToken);
ok('Password change invalidates all sessions', afterPw.status === 401, `HTTP ${afterPw.status}`);
const ownerStillValid = await request('/api/models');
ok('Owner session survives another account password change', ownerStillValid.status === 200);

// ---------------------------------------------------------------------------
// Live agent turn (optional)
// ---------------------------------------------------------------------------
if (liveChat) {
  console.log('\n  Running a live agent turn…');
  const model = models.body.find(m => m.platform === 'groq' && m.supportsTools && m.hasKey && m.enabled)
    ?? models.body.find(m => m.supportsTools && m.hasKey && m.enabled);
  const chat = await request(`/api/sessions/${id}/chat`, {
    method: 'POST',
    body: JSON.stringify({ text: 'Reply with exactly: SMOKE_OK', modelPlatform: model.platform, modelId: model.modelId, maxSteps: 2 }),
  });
  ok('POST /api/sessions/:id/chat', chat.status === 202, `${model.platform}/${model.modelId}`);
  const events = [];
  const stream = await fetch(`${base}/api/sessions/${id}/events?token=${encodeURIComponent(token)}`, {
    headers: { Accept: 'text/event-stream' }, signal: AbortSignal.timeout(90_000),
  });
  const r = stream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (events.length < 400) {
      const { done, value } = await r.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const name = frame.match(/^event:\s*(.+)$/m)?.[1];
        const data = frame.match(/^data:\s*(.+)$/m)?.[1];
        if (name && data && !['ping', 'ready'].includes(name)) {
          try { events.push({ name, data: JSON.parse(data) }); } catch { /* ignore */ }
        }
      }
      if (events.some(e => e.name === 'done')) break;
    }
  } catch { /* timeout */ }
  const text = events.filter(e => e.name === 'part-delta').map(e => e.data.delta).join('');
  ok('SSE streamed a response', text.length > 0 || events.some(e => e.name === 'error'), `${events.length} events, ${text.length} chars`);
  ok('Agent loop finished', events.some(e => e.name === 'done'));
  const final = await request(`/api/sessions/${id}`);
  ok('Messages persisted to SQLite', final.body.messages.length >= 2, `${final.body.messages.length} messages`);
  if (text) console.log(`\n  Model replied: ${text.slice(0, 200)}\n`);
}

if (testTools) {
  console.log('\n  Running tool + permission flow…');
  const model = models.body.find(m => m.platform === 'groq' && m.supportsTools && m.hasKey && m.enabled)
    ?? models.body.find(m => m.supportsTools && m.hasKey && m.enabled);
  const toolSession = await request('/api/sessions', {
    method: 'POST', body: JSON.stringify({ title: 'Tool test', agent: 'build' }),
  });
  const tid = toolSession.body.id;
  await request(`/api/sessions/${tid}/chat`, {
    method: 'POST',
    body: JSON.stringify({
      text: 'Use the write tool to create a file named smoke-test.txt containing exactly "hello from codingagent", then tell me the file name.',
      modelPlatform: model.platform, modelId: model.modelId, maxSteps: 6,
    }),
  });

  const stream = await fetch(`${base}/api/sessions/${tid}/events?token=${encodeURIComponent(token)}`, {
    headers: { Accept: 'text/event-stream' }, signal: AbortSignal.timeout(120_000),
  });
  const r = stream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const seen = new Set();
  let toolCalls = 0;
  let permissionsApproved = 0;
  let done = false;
  try {
    while (!done) {
      const { done: ended, value } = await r.read();
      if (ended) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const name = frame.match(/^event:\s*(.+)$/m)?.[1];
        const data = frame.match(/^data:\s*(.+)$/m)?.[1];
        if (!name || !data || ['ping', 'ready'].includes(name)) continue;
        let payload;
        try { payload = JSON.parse(data); } catch { continue; }
        if (name === 'part' && payload.part.type === 'tool') toolCalls++;
        if (name === 'permission') {
          const resolved = await request(`/api/permissions/${payload.permission.id}/resolve`, {
            method: 'POST', body: JSON.stringify({ decision: 'approved' }),
          });
          if (resolved.status === 200) permissionsApproved++;
        }
        if (name === 'part-state' && payload.state === 'completed') seen.add(payload.partId);
        if (name === 'done') done = true;
      }
    }
  } catch (err) {
    console.log(`  (stream ended: ${err?.name ?? 'unknown'})`);
  }

  ok('Agent emitted tool calls', toolCalls > 0, `${toolCalls} tool parts`);
  ok('Permission gate asked and was resolved', permissionsApproved > 0, `${permissionsApproved} approvals`);
  const toolFile = path.join(smokeWorkspace, 'smoke-test.txt');
  const created = fs.existsSync(toolFile);
  ok('File was actually written to the workspace', created, toolFile);
  if (created) {
    const content = fs.readFileSync(toolFile, 'utf8');
    ok('File content is correct', content.includes('hello from codingagent'), JSON.stringify(content.slice(0, 60)));
    try { fs.rmSync(toolFile, { force: true }); } catch { /* safe-delete shim */ }
  }
  const changes = await request(`/api/files/changes?sessionId=${tid}`);
  ok('File change recorded in SQLite', Array.isArray(changes.body) && changes.body.length > 0, `${changes.body.length} changes`);
  await request(`/api/sessions/${tid}`, { method: 'DELETE' });
}

// ---------------------------------------------------------------------------
// Workspace sandbox, attachments, Agent Skills, terminal (as the owner/admin)
// ---------------------------------------------------------------------------
console.log('\n  Workspace / attachments / skills / terminal…');
const bundledWorkspace = smokeWorkspace;

const workspace = await request('/api/workspace');
ok('GET /api/workspace', workspace.status === 200 && !!workspace.body.active, workspace.body.active?.root);

const browse = await request(`/api/workspace/browse?path=${encodeURIComponent(root)}`);
ok('GET /api/workspace/browse', browse.status === 200 && browse.body.entries.some(entry => entry.name === 'apps'),
  `${browse.body.entries?.length ?? 0} folders`);

const opened = await request('/api/workspace/open', {
  method: 'POST', body: JSON.stringify({ path: bundledWorkspace }),
});
ok('POST /api/workspace/open (rebinds the sandbox)', opened.status === 200 && !!opened.body.root,
  opened.body.project?.name);

const external = await request('/api/attachments/resolve', {
  method: 'POST', body: JSON.stringify({ paths: [{ path: path.join(root, 'package.json') }] }),
});
ok('POST /api/attachments/resolve (explicit external file)',
  external.status === 200 && external.body.attachments?.[0]?.external === true
  && external.body.attachments[0].content.includes('codingagent'),
  external.body.attachments?.[0]?.name);

const escape = await request('/api/attachments/resolve', {
  method: 'POST', body: JSON.stringify({ paths: [{ path: '../../../../etc/passwd' }], sessionId: id }),
});
ok('Attachments refuse a path escape',
  escape.status === 200 && escape.body.attachments.length === 0 && escape.body.errors.length === 1);

const skills0 = await request('/api/skills');
ok('GET /api/skills', skills0.status === 200 && Array.isArray(skills0.body.skills) && Array.isArray(skills0.body.directories));

const install = await request('/api/skills/install', {
  method: 'POST', body: JSON.stringify({ source: 'builtin:code-review', force: true }),
});
const installedId = install.body.installed?.[0]?.id;
ok('POST /api/skills/install (builtin skill)', [200, 201].includes(install.status) && install.body.installed?.length === 1, installedId);

const disabled = await request(`/api/skills/${encodeURIComponent(installedId)}`, {
  method: 'PATCH', body: JSON.stringify({ enabled: false }),
});
ok('PATCH /api/skills/:id (disable)', disabled.status === 200
  && disabled.body.skills.find(skill => skill.id === installedId)?.enabled === false);

const enabled = await request(`/api/skills/${encodeURIComponent(installedId)}`, {
  method: 'PATCH', body: JSON.stringify({ enabled: true }),
});
ok('PATCH /api/skills/:id (enable)', enabled.status === 200
  && enabled.body.skills.find(skill => skill.id === installedId)?.enabled === true);

const term = await request('/api/terminal', { method: 'POST' });
ok('POST /api/terminal (admin shell)', term.status === 201 && !!term.body.id, term.body.shell);
const termId = term.body.id;
let termText = '';
if (termId) {
  const controller = new AbortController();
  const res = await fetch(`${base}/api/terminal/${termId}/events?token=${encodeURIComponent(token)}`, {
    headers: { Accept: 'text/event-stream' }, signal: controller.signal,
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  await new Promise(resolve => setTimeout(resolve, 700));
  await request(`/api/terminal/${termId}/input`, {
    method: 'POST', body: JSON.stringify({ data: 'echo AGENT_TERMINAL_OK' }),
  });
  const deadline = Date.now() + 10_000;
  let buffer = '';
  while (Date.now() < deadline && !termText.includes('AGENT_TERMINAL_OK')) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    termText = buffer;
  }
  controller.abort();
}
ok('Terminal streamed command output', termText.includes('AGENT_TERMINAL_OK'));

const termDeleted = await request(`/api/terminal/${termId}`, { method: 'DELETE' });
ok('DELETE /api/terminal/:id', termDeleted.body.deleted === true);

const skillDeleted = await request(`/api/skills/${encodeURIComponent(installedId)}`, { method: 'DELETE' });
ok('DELETE /api/skills/:id', skillDeleted.status === 200
  && !skillDeleted.body.skills.some(skill => skill.id === installedId));

// Cleanup
const deleted = await request(`/api/sessions/${id}`, { method: 'DELETE' });
ok('DELETE /api/sessions/:id', deleted.status === 200 && deleted.body.deleted === true);

if (failed && serverOutput) console.log('\n[smoke] isolated server log:\n' + serverOutput.slice(-2500));
console.log(`\n${passed} passed, ${failed} failed.`);

if (child) { try { child.kill('SIGTERM'); } catch { /* ignore */ } }
process.exit(failed ? 1 : 0);
