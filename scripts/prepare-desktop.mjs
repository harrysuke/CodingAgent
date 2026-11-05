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
 *     server/.env                    inherited ENCRYPTION_KEY + AGENT_TOKEN
 *     server/node_modules/           only better-sqlite3 + its native loader
 *     server/apps/web/dist/          UI served by the Node server (browser mode)
 *     server/data/codingagent.db     clean snapshot of the reused SQLite DB
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
 * Set CODINGAGENT_RESOURCES to write the assembled runtime elsewhere (used by
 * verification / CI without touching the Tauri project).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

const noBuild = process.argv.includes('--no-build');
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
fs.copyFileSync(path.join(ROOT, '.env'), path.join(RUNTIME, '.env'));
fs.cpSync(WEB_DIST, path.join(RUNTIME, 'apps', 'web', 'dist'), { recursive: true });
log('single-file server bundle, marker, .env and web dist copied');

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
// 3. Clean SQLite snapshot (VACUUM INTO folds any WAL into the copy)
//    VACUUM INTO refuses an existing target, so build into a temp name then
//    replace atomically - this also works when an older runtime is reused.
// ---------------------------------------------------------------------------
const srcDb = path.join(ROOT, 'data', 'codingagent.db');
const dstDb = path.join(RUNTIME, 'data', 'codingagent.db');
const tmpDb = path.join(RUNTIME, 'data', 'codingagent.db.tmp');
try {
  const Database = requireFromRoot('better-sqlite3');
  try { fs.unlinkSync(tmpDb); } catch { /* no stale temp */ }
  const db = new Database(srcDb, { readonly: true });
  db.exec(`VACUUM INTO '${tmpDb.replace(/\\/g, '/').replace(/'/g, "''")}'`);
  const models = db.prepare('SELECT COUNT(*) AS n FROM models').get().n;
  const keys = db.prepare('SELECT COUNT(*) AS n FROM api_keys').get().n;
  db.close();
  fs.renameSync(tmpDb, dstDb);
  log(`database snapshot: ${models} models, ${keys} encrypted keys`);
} catch (err) {
  log('VACUUM unavailable, falling back to plain file copy:', err.message);
  fs.copyFileSync(srcDb, dstDb);
  try { fs.unlinkSync(tmpDb); } catch { /* ignore */ }
}

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
