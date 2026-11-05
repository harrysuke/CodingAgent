/**
 * End-to-end smoke test against a running agent server.
 *   npm run smoke            -> offline-safe API checks
 *   npm run smoke -- --chat  -> also run one live agent turn (needs a working key)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = fs.readFileSync(path.join(root, '.env'), 'utf8');
const get = (key, fallback) => (envFile.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1] ?? fallback).trim();
const port = fs.existsSync(path.join(root, 'data/server.port'))
  ? fs.readFileSync(path.join(root, 'data/server.port'), 'utf8').trim()
  : get('PORT', '4317');
const base = process.env.AGENT_URL ?? `http://127.0.0.1:${port}`;
const token = get('AGENT_TOKEN', 'change-me-local-dev-token');
const liveChat = process.argv.includes('--chat');
const testTools = process.argv.includes('--tools');

let passed = 0;
let failed = 0;

function ok(name, condition, detail = '') {
  if (condition) { passed++; console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function request(pathname, init = {}) {
  const headers = { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers ?? {}) };
  const res = await fetch(`${base}${pathname}`, { ...init, headers });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

console.log(`CodingAgent smoke test → ${base}\n`);

const health = await request('/api/health');
ok('GET /api/health', health.status === 200 && health.body.ok === true, `${health.body.models} models`);
ok('DB is the reused codingagent.db', String(health.body.dbPath).includes('codingagent.db'));
ok('Reused model catalog is intact', health.body.models >= 100, `${health.body.models} rows`);
ok('Providers configured from copied keys', health.body.providersConfigured >= 10, `${health.body.providersConfigured} providers`);

const unauthorized = await fetch(`${base}/api/health`, { headers: { Authorization: 'Bearer wrong' } });
ok('Auth guard rejects bad token', unauthorized.status === 401);

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
  const created = fs.existsSync(path.join(root, 'workspace/smoke-test.txt'));
  ok('File was actually written to the workspace', created);
  if (created) {
    const content = fs.readFileSync(path.join(root, 'workspace/smoke-test.txt'), 'utf8');
    ok('File content is correct', content.includes('hello from codingagent'), JSON.stringify(content.slice(0, 60)));
    fs.rmSync(path.join(root, 'workspace/smoke-test.txt'), { force: true });
  }
  const changes = await request(`/api/files/changes?sessionId=${tid}`);
  ok('File change recorded in SQLite', Array.isArray(changes.body) && changes.body.length > 0, `${changes.body.length} changes`);
  await request(`/api/sessions/${tid}`, { method: 'DELETE' });
}

// ---------------------------------------------------------------------------
// Workspace sandbox, attachments, Agent Skills, terminal
// ---------------------------------------------------------------------------
console.log('\n  Workspace / attachments / skills / terminal…');
const bundledWorkspace = path.join(root, 'workspace');

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
ok('POST /api/terminal', term.status === 201 && !!term.body.id, term.body.shell);
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

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
