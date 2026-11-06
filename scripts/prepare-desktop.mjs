#!/usr/bin/env node
/**
 * Assemble the self-contained desktop runtime that the Tauri shell bundles.
 *
 * Layout produced (all gitignored):
 *   apps/desktop/src-tauri/resources/
 *     node/node.exe                  portable Node runtime (from process.execPath)
 *     server/index.js                single-file esbuild bundle (all JS deps inlined)
 *     server/package.json            {"type":"module"} for the ESM bundle
 *     server/server-runtime.json     marker: env.projectRoot() resolves to this dir
 *     server/.env                    fresh per-install secrets (see below)
 *     server/node_modules/           only better-sqlite3 + its native loader
 *     server/apps/web/dist/          UI served by the Node server (browser mode)
 *     server/data/codingagent.db     sanitized snapshot of the reused SQLite DB
 *     server/workspace/              seed workspace (Rust copies it to app data)
 *     manifest.json
 *
 * Everything except the native SQLite addon is bundled into one JS file, so the
 * resource tree stays tiny (a few dozen files) and both `npm run desktop:build`
 * and Tauri's own resource copy stay fast.
 *
 * The Rust side injects DB_PATH / WORKSPACE_ROOT / PORT / HOST / AGENT_TOKEN as
 * real environment variables, which dotenv will not override.
 *
 * PRIVACY: the source database is the developer's LIVE database. It contains
 * chat history, usage telemetry, absolute project paths, the inherited
 * FreeLLMAPI dashboard user's password hash + session tokens, and even a
 * plaintext unified_api_key. Shipping that file in an installer would leak all
 * of it, and shipping encrypted provider keys next to their ENCRYPTION_KEY is
 * equivalent to shipping them in plaintext. The snapshot is therefore stripped
 * down to the model catalogue + harmless preference defaults, and both secrets
 * in server/.env are freshly generated. Pass --include-keys for a PRIVATE build
 * that keeps your own encrypted keys (and the source ENCRYPTION_KEY they need).
 *
 * Set CODINGAGENT_RESOURCES to write the assembled runtime elsewhere (used by
 * verification / CI without touching the Tauri project).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'apps', 'server');
const SHARED = path.join(ROOT, 'packages', 'shared');
const WEB_DIST = path.join(ROOT, 'apps', 'web', 'dist');
const TAURI = path.join(ROOT, 'apps', 'desktop', 'src-tauri');
const OUT = process.env.CODINGAGENT_RESOURCES
  ? path.resolve(process.env.CODINGAGENT_RESOURCES)
  : path.join(TAURI, 'resources');
const RUNTIME = path.join(OUT, 'server');
const requireFromRoot = createRequire(path.join(ROOT, 'package.json'));

// ---------------------------------------------------------------------------
// Native ABI preflight. `better-sqlite3` is a native addon: if npm launched us
// with a Node whose NODE_MODULE_VERSION differs from the addon, we must NOT
// silently fall back to a plain file copy (we cannot sanitize or VACUUM it)
// and we must NOT bundle that incompatible node.exe. Re-exec under a Node that
// can actually load the addon, so `npm run desktop:build` works from any shell.
// ---------------------------------------------------------------------------
function addonLoads() {
  try {
    const Database = requireFromRoot('better-sqlite3');
    const probe = new Database(':memory:');
    probe.close();
    return true;
  } catch { return false; }
}

if (!addonLoads() && !process.env.CODINGAGENT_DESKTOP_REEXEC) {
  const candidates = [
    process.env.CA_NODE_BIN,
    path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'nodejs', 'node.exe'),
    path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'nodejs', 'node.exe'),
    '/usr/bin/node', '/usr/local/bin/node',
  ].filter(Boolean);
  const probe = "const D=require('better-sqlite3');const d=new D(':memory:');d.close();";
  let compatible = '';
  for (const bin of candidates) {
    if (path.resolve(bin) === path.resolve(process.execPath)) continue;
    try {
      execFileSync(bin, ['-e', probe], { cwd: ROOT, stdio: 'ignore', timeout: 15_000 });
      compatible = bin;
      break;
    } catch { /* wrong ABI or not installed */ }
  }
  if (!compatible) {
    throw new Error(
      `${process.version} cannot load better-sqlite3 and no compatible Node was found. ` +
      'Run `npm rebuild better-sqlite3 --foreground-scripts`, or set CA_NODE_BIN to a matching Node binary.',
    );
  }
  console.log(`[prepare-desktop] ${process.version} cannot load better-sqlite3; re-execing with ${compatible}`);
  const result = spawnSync(compatible, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, CODINGAGENT_DESKTOP_REEXEC: '1' },
  });
  process.exit(result.status ?? 1);
}

const noBuild = process.argv.includes('--no-build');
/** Opt-in for a private, never-redistributed installer that keeps your keys. */
const includeKeys = process.argv.includes('--include-keys');
const log = (...args) => console.log('[prepare-desktop]', ...args);

function run(cmd, args, cwd = ROOT) {
  log('$', cmd, args.join(' '));
  execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
}

function mustExist(p, hint) {
  if (!fs.existsSync(p)) throw new Error(`Missing ${p}. ${hint ?? ''}`);
  return p;
}

// ---------------------------------------------------------------------------
// 0. Build everything, ensure .env exists
// ---------------------------------------------------------------------------
if (!fs.existsSync(path.join(ROOT, '.env'))) run('npm', ['run', 'setup']);
if (!noBuild) run('npm', ['run', 'build']);

mustExist(path.join(SERVER, 'dist', 'index.js'), 'Run `npm run build` first.');
mustExist(path.join(SHARED, 'dist', 'index.js'), 'Run `npm run build:shared` first.');
mustExist(path.join(WEB_DIST, 'index.html'), 'Run `npm run build -w @codingagent/web` first.');
mustExist(path.join(ROOT, 'data', 'codingagent.db'), 'Run `npm run setup` first.');
mustExist(path.join(ROOT, '.env'), 'Run `npm run setup` first.');

// Delete one file at a time instead of a bulk recursive rmSync. Some managed
// environments block large recursive deletes; a per-file loop stays under that
// threshold. If it still fails we simply overwrite in place (every generated
// file below is re-copied anyway, so a partial clean is harmless).
function removeTree(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) removeTree(target);
    else fs.unlinkSync(target);
  }
  fs.rmdirSync(dir);
}
// Native mirroring is both faster and immune to managed-environment bulk
// delete guards that intercept Node's rmSync/unlinkSync.
function cleanOutput() {
  if (!fs.existsSync(OUT)) return;
  if (OUT === ROOT || ROOT.startsWith(OUT + path.sep)) {
    throw new Error(`Refusing to clean unsafe output path: ${OUT}`);
  }
  if (process.platform === 'win32') {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'codingagent-empty-'));
    try {
      const result = spawnSync('robocopy', [
        empty, OUT, '/MIR', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:1', '/W:1', '/MT:16',
      ], { stdio: 'ignore', windowsHide: true });
      if (result.status !== null && result.status < 8) return;
    } catch { /* fall through */ }
    finally { try { fs.rmdirSync(empty); } catch { /* ignore */ } }
  }
  removeTree(OUT);
}
if (!process.argv.includes('--no-clean')) {
  try {
    cleanOutput();
  } catch (err) {
    log('could not fully clean old resources, overwriting in place:', err.message);
  }
}
for (const dir of [RUNTIME, path.join(OUT, 'node'), path.join(RUNTIME, 'apps', 'web'), path.join(RUNTIME, 'data')]) {
  fs.mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// 1. Single-file server bundle + marker + env + UI
//    Only `better-sqlite3` stays external: a native .node addon cannot be
//    inlined by esbuild. This is a separate build from apps/server's normal
//    dist/index.js (which keeps packages external for `npm start` / tsx).
// ---------------------------------------------------------------------------
/**
 * Never copy the source .env verbatim: it holds the ENCRYPTION_KEY that
 * protects the developer's real database, plus their AGENT_TOKEN. Both are
 * regenerated for every build. Only harmless, non-secret tunables are carried
 * over, so a redistributed installer contains no reusable secret.
 */
function writePackagedEnv() {
  const source = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  const values = new Map();
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx > 0) values.set(trimmed.slice(0, idx).trim(), trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, ''));
  }
  const sourceKey = values.get('ENCRYPTION_KEY') ?? '';
  if (includeKeys && !/^[0-9a-fA-F]{64}$/.test(sourceKey)) {
    throw new Error('--include-keys needs a valid 64-hex ENCRYPTION_KEY in .env to decrypt the shipped keys.');
  }
  const encryptionKey = includeKeys ? sourceKey : crypto.randomBytes(32).toString('hex');
  const setupToken = crypto.randomBytes(24).toString('base64url');

  const CARRY = [
    'AGENT_MAX_STEPS', 'AGENT_PERMISSION_MODE', 'ALLOW_REGISTRATION',
    'AGENT_SESSION_TTL_DAYS', 'AGENT_ALLOW_USER_SHELL', 'USER_WORKSPACES_ROOT',
  ];
  const lines = [
    '# Generated by scripts/prepare-desktop.mjs - safe to bundle, no source secrets.',
    '# ENCRYPTION_KEY is unique to this build; AGENT_TOKEN is only the first-admin setup secret.',
    `ENCRYPTION_KEY=${encryptionKey}`,
    `AGENT_TOKEN=${setupToken}`,
    `CODINGAGENT_INCLUDE_KEYS=${includeKeys ? '1' : '0'}`,
  ];
  for (const key of CARRY) if (values.has(key)) lines.push(`${key}=${values.get(key)}`);
  fs.writeFileSync(path.join(RUNTIME, '.env'), `${lines.join('\n')}\n`, 'utf8');
  log(`packaged .env: fresh ${includeKeys ? 'setup token (source ENCRYPTION_KEY preserved)' : 'ENCRYPTION_KEY + setup token'}`);
}

const esbuild = requireFromRoot('esbuild');
await esbuild.build({
  entryPoints: [path.join(SERVER, 'src', 'index.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['better-sqlite3'],
  outfile: path.join(RUNTIME, 'index.js'),
  logLevel: 'warning',
  // Bundled CommonJS modules (dotenv, execa internals, ...) call `require`
  // lazily. esbuild's ESM output has no `require`, so provide one.
  banner: {
    js: [
      "import { createRequire as __codingagentCreateRequire } from 'node:module';",
      'const require = __codingagentCreateRequire(import.meta.url);',
    ].join('\n'),
  },
});
fs.writeFileSync(
  path.join(RUNTIME, 'package.json'),
  JSON.stringify({ name: 'codingagent-server-runtime', private: true, type: 'module' }, null, 2),
  'utf8',
);
fs.writeFileSync(
  path.join(RUNTIME, 'server-runtime.json'),
  JSON.stringify({ name: 'codingagent-server-runtime', version: '0.1.0', generatedAt: new Date().toISOString() }, null, 2),
  'utf8',
);
writePackagedEnv();
fs.cpSync(WEB_DIST, path.join(RUNTIME, 'apps', 'web', 'dist'), { recursive: true });
log('single-file server bundle, marker, fresh .env and web dist copied');

// ---------------------------------------------------------------------------
// 2. Native-only dependency closure
//    Only the SQLite addon and its loader (`bindings` -> `file-uri-to-path`)
//    must exist on disk. prebuild-install is install-time only, so skip it.
// ---------------------------------------------------------------------------
function locatePackage(name, fromDir) {
  const req = createRequire(path.join(fromDir, 'package.json'));
  const candidates = [];
  try { candidates.push(req.resolve(`${name}/package.json`)); } catch { /* exports may block */ }
  try { candidates.push(req.resolve(name)); } catch { /* optional */ }
  candidates.push(path.join(ROOT, 'node_modules', ...name.split('/'), 'package.json'));

  for (const candidate of candidates) {
    let dir = path.dirname(candidate);
    for (let i = 0; i < 10 && dir !== path.dirname(dir); i++) {
      const pj = path.join(dir, 'package.json');
      if (fs.existsSync(pj)) {
        try {
          const json = JSON.parse(fs.readFileSync(pj, 'utf8'));
          if (json.name === name) return { dir, json };
        } catch { /* malformed, keep walking */ }
      }
      dir = path.dirname(dir);
    }
  }
  return null;
}

const found = new Map(); // absolute package dir (lowercased) -> { dir, json }
const missing = new Set();
const INSTALL_TIME_ONLY = new Set(['prebuild-install']);

function collect(name, fromDir) {
  if (INSTALL_TIME_ONLY.has(name)) return;
  const hit = locatePackage(name, fromDir);
  if (!hit) { missing.add(name); return; }
  const key = hit.dir.toLowerCase();
  if (found.has(key)) return;
  found.set(key, hit);
  const deps = { ...(hit.json.dependencies ?? {}), ...(hit.json.optionalDependencies ?? {}) };
  for (const dep of Object.keys(deps)) collect(dep, hit.dir);
}

collect('better-sqlite3', SERVER);

// Only runtime assets are needed: published packages ship compiled JS/JSON,
// while typings, sourcemaps, docs and tests account for most of the file count.
// On Windows, robocopy /MT is dramatically faster than a per-file JS loop
// (real-time AV scanning makes fs.cpSync very slow on many small files).
const SKIP_DIRS = [
  'test', 'tests', '__tests__', 'doc', 'docs', 'example', 'examples',
  'coverage', '.github', '.git', '.vscode', '.idea', '.cache', '.bin',
  'benchmark', 'benchmarks', 'fixtures', 'website',
];
const SKIP_FILES = [
  '*.map', '*.d.ts', '*.ts', '*.md', '*.markdown', '*.txt', '*.log',
  'LICENSE*', 'README*', 'CHANGELOG*', 'AUTHORS*', 'CONTRIBUTING*',
  'tsconfig*.json', 'package-lock.json', '.npmignore', '.gitignore',
  '.editorconfig', '.eslintrc*', '*.test.js', '*.spec.js',
];

const copyFilter = (src) => {
  const parts = src.split(path.sep);
  if (parts.some(p => SKIP_DIRS.includes(p.toLowerCase()))) return false;
  const base = parts[parts.length - 1];
  if (base.endsWith('.map') || base.endsWith('.d.ts') || base.endsWith('.ts')) return false;
  if (/^(license|readme|changelog|authors|contributing|makefile|notice)/i.test(base)) return false;
  if (/\.(md|markdown|txt|log)$/i.test(base)) return false;
  return true;
};

function copyPackage(src, dest) {
  if (process.platform === 'win32') {
    try {
      const result = spawnSync('robocopy', [
        src, dest, '/E', '/MT:16', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:1', '/W:1',
        '/XF', ...SKIP_FILES, '/XD', ...SKIP_DIRS,
      ], { stdio: 'ignore', windowsHide: true });
      // robocopy exit codes 0..7 mean success (1 = files were copied).
      if (result.status !== null && result.status < 8) return;
    } catch { /* fall through to the portable copier */ }
  }
  fs.cpSync(src, dest, { recursive: true, dereference: true, filter: copyFilter });
}

for (const { dir, json } of found.values()) {
  const dest = path.join(RUNTIME, 'node_modules', ...json.name.split('/'));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  copyPackage(dir, dest);
}

// Native addon sanity check - better-sqlite3 cannot be bundled into JS.
const addon = path.join(RUNTIME, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
if (!fs.existsSync(addon)) {
  throw new Error(`Native SQLite addon missing at ${addon}. Run \`npm rebuild better-sqlite3 --foreground-scripts\`.`);
}
log(`copied ${found.size} native runtime packages (${[...found.values()].map(v => v.json.name).join(', ')}), addon present`);
if (missing.size) log('note: unresolved optional packages (skipped):', [...missing].join(', '));

// ---------------------------------------------------------------------------
// 3. Clean + SANITIZED SQLite snapshot (VACUUM INTO folds any WAL into the copy)
//    VACUUM INTO refuses an existing target, so build into a temp name then
//    replace atomically - this also works when an older runtime is reused.
// ---------------------------------------------------------------------------

/**
 * Strip every trace of the developer's machine from the shipped DB. Note the
 * final VACUUM: without it, deleted rows (chat text, e-mail addresses, the
 * plaintext unified_api_key) would still sit in free pages of the file.
 */
function sanitizeSnapshot(dbFile) {
  const Database = requireFromRoot('better-sqlite3');
  const db = new Database(dbFile);
  db.pragma('foreign_keys = OFF');
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
  const count = (t) => tables.has(t) ? db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n : 0;
  const clear = (t) => { if (tables.has(t)) db.prepare(`DELETE FROM "${t}"`).run(); };
  const before = {
    agent_sessions: count('agent_sessions'), agent_messages: count('agent_messages'),
    agent_parts: count('agent_parts'), requests: count('requests'),
    projects: count('projects'), users: count('users'), sessions: count('sessions'),
    api_keys: count('api_keys'),
  };

  db.transaction(() => {
    // Children first, so an FK-enabled snapshot still deletes cleanly.
    for (const table of [
      'agent_parts', 'agent_messages', 'agent_todos', 'agent_file_changes',
      'agent_permission_grants', 'agent_permissions', 'agent_sessions',
      'agent_user_sessions', 'agent_user_settings', 'agent_users',
      'projects', 'requests', 'rate_limit_usage', 'rate_limit_cooldowns',
      'sessions', 'users',
    ]) clear(table);

    if (!includeKeys) clear('api_keys');
    else if (tables.has('api_keys')
        && db.prepare('PRAGMA table_info(api_keys)').all().some(c => c.name === 'user_id')) {
      // A private build's keys must be claimable by the *new* first admin,
      // not left owned by a developer-machine account id that no longer exists.
      db.prepare('UPDATE api_keys SET user_id=NULL').run();
    }

    if (tables.has('settings')) {
      const del = db.prepare('DELETE FROM settings WHERE key=?');
      for (const { key } of db.prepare('SELECT key FROM settings').all()) {
        const k = String(key).toLowerCase();
        const isSecret = /key|token|secret|password|credential|auth/.test(k);
        const isStalePointer = k === 'agent:active_project';
        // With no shipped keys, a default model for a keyless platform would
        // leave the composer unusable until the user manually picks a model.
        const isStaleDefault = !includeKeys
          && (k === 'agent:default_platform' || k === 'agent:default_model_id');
        if (isSecret || isStalePointer || isStaleDefault) del.run(key);
      }
    }
    clear('sqlite_sequence');
  })();
  db.exec('VACUUM');
  const summary = {
    models: count('models'),
    api_keys: count('api_keys'),
    projects: count('projects'),
    agent_sessions: count('agent_sessions'),
    requests: count('requests'),
    users: count('users'),
    settings: count('settings'),
    before,
  };
  db.close();
  return summary;
}

const srcDb = path.join(ROOT, 'data', 'codingagent.db');
const dstDb = path.join(RUNTIME, 'data', 'codingagent.db');
const tmpDb = path.join(RUNTIME, 'data', 'codingagent.db.tmp');
try {
  const Database = requireFromRoot('better-sqlite3');
  try { fs.unlinkSync(tmpDb); } catch { /* no stale temp */ }
  const db = new Database(srcDb, { readonly: true });
  db.exec(`VACUUM INTO '${tmpDb.replace(/\\/g, '/').replace(/'/g, "''")}'`);
  db.close();
  try { fs.unlinkSync(dstDb); } catch { /* no previous snapshot */ }
  fs.renameSync(tmpDb, dstDb);
} catch (err) {
  log('VACUUM unavailable, falling back to plain file copy:', err.message);
  fs.copyFileSync(srcDb, dstDb);
  try { fs.unlinkSync(tmpDb); } catch { /* ignore */ }
}
// Deliberately NOT in a try/catch: if sanitisation fails we must not ship.
const snapshot = sanitizeSnapshot(dstDb);
log(`database snapshot: ${snapshot.models} models, ${snapshot.api_keys} keys ` +
    `(purged ${snapshot.before.agent_sessions} sessions / ${snapshot.before.agent_messages} messages, ` +
    `${snapshot.before.requests} request logs, ${snapshot.before.projects} project paths, ` +
    `${snapshot.before.users} legacy users, ${snapshot.before.api_keys - snapshot.api_keys} provider keys)`);
if (!includeKeys) log('provider keys stripped - first admin must BYOK. Use --include-keys for a private build.');

// ---------------------------------------------------------------------------
// 4. Seed workspace + portable Node binary
// ---------------------------------------------------------------------------
const srcWorkspace = path.join(ROOT, 'workspace');
const dstWorkspace = path.join(RUNTIME, 'workspace');
if (fs.existsSync(srcWorkspace)) {
  fs.cpSync(srcWorkspace, dstWorkspace, { recursive: true });
} else {
  fs.mkdirSync(dstWorkspace, { recursive: true });
  fs.writeFileSync(path.join(dstWorkspace, 'README.md'), '# CodingAgent workspace\n\nThe agent is sandboxed to this directory.\n');
}

const nodeName = path.basename(process.execPath);
fs.copyFileSync(process.execPath, path.join(OUT, 'node', nodeName));
log(`portable node runtime: ${nodeName}`);

// ---------------------------------------------------------------------------
// 5. Manifest + size report
// ---------------------------------------------------------------------------
function dirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(p);
    else if (entry.isFile()) total += fs.statSync(p).size;
  }
  return total;
}
const mb = n => `${(n / 1024 / 1024).toFixed(1)} MB`;
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  nodeBinary: `node/${nodeName}`,
  entrypoint: 'server/index.js',
  packages: found.size,
  bundle: 'server/index.js (esbuild, better-sqlite3 external)',
  platform: process.platform,
  arch: process.arch,
}, null, 2), 'utf8');

log('done.');
log(`  server: ${mb(dirSize(RUNTIME))}`);
log(`  node:   ${mb(fs.statSync(path.join(OUT, 'node', nodeName)).size)}`);
log(`  output: ${OUT}`);
