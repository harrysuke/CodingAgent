/**
 * First-run regression check: "someone cloned the repo, there is no database".
 *
 *   npm run smoke:fresh
 *
 * Creates a throwaway database in the OS temp directory (nothing in `data/` is
 * touched), bootstraps it through the real `db:migrate` entry point, and then
 * asserts that:
 *   - the file and every required table now exist,
 *   - the model catalog was seeded (an empty catalog means no chat is possible),
 *   - a second run is a no-op (idempotent: no duplicate models, no data loss).
 *
 * No build step is needed: it drives `tsx src/db/cli.ts`, the same code the
 * server calls from `initDb()`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverDir = path.join(root, 'apps', 'server');

const REQUIRED_TABLES = [
  // inherited from FreeLLMAPI (baseSchema.ts)
  'models', 'api_keys', 'requests', 'rate_limit_usage', 'rate_limit_cooldowns',
  'fallback_config', 'settings', 'users', 'sessions', 'embedding_models',
  // additive agent schema (schema.ts)
  'agent_users', 'agent_user_sessions', 'agent_user_settings', 'projects',
  'agent_sessions', 'agent_messages', 'agent_parts', 'agent_permissions',
  'agent_permission_grants', 'agent_todos', 'agent_file_changes',
];

let passed = 0;
let failed = 0;
function ok(name, condition, detail = '') {
  if (condition) { passed++; console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

/** Pick a Node binary that can actually load the native better-sqlite3 addon. */
function workingNode() {
  const candidates = [
    process.env.CA_NODE_BIN,
    process.execPath,
    path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'nodejs', 'node.exe'),
    '/usr/bin/node', '/usr/local/bin/node',
  ].filter(Boolean);
  for (const bin of candidates) {
    try {
      execFileSync(bin, ['-e', "const D=require('better-sqlite3');new D(':memory:').close();"],
        { cwd: root, stdio: 'ignore', timeout: 15_000 });
      return bin;
    } catch { /* wrong ABI or not installed */ }
  }
  throw new Error('No Node binary can load better-sqlite3. Run `npm rebuild better-sqlite3`, or set CA_NODE_BIN.');
}

const nodeBin = workingNode();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-fresh-'));
const dbPath = path.join(tmpDir, 'codingagent.db');
const env = {
  ...process.env,
  DB_PATH: dbPath,
  // A fresh clone has a generated .env, but this check must not depend on it.
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY || '0'.repeat(64),
  WORKSPACE_ROOT: path.join(tmpDir, 'workspace'),
  USER_WORKSPACES_ROOT: path.join(tmpDir, 'workspaces'),
};

const migrate = () => execFileSync(
  nodeBin,
  [path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'src/db/cli.ts'],
  { cwd: serverDir, env, stdio: 'pipe', encoding: 'utf8' },
);

/** Read-only inspection with the same driver the server uses. */
function inspect() {
  const script = `
    const D = require('better-sqlite3');
    const db = new D(process.env.CA_DB, { readonly: true });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name);
    const count = t => db.prepare('SELECT COUNT(*) AS n FROM ' + t).get().n;
    const cols = t => db.prepare('PRAGMA table_info(' + t + ')').all().map(c => c.name);
    const out = {
      tables,
      models: count('models'),
      projects: count('projects'),
      fallback: count('fallback_config'),
      settings: count('settings'),
      requestCols: cols('requests'),
      apiKeyCols: cols('api_keys'),
    };
    db.close();
    console.log(JSON.stringify(out));
  `;
  const raw = execFileSync(nodeBin, ['-e', script], { cwd: root, env: { ...env, CA_DB: dbPath }, encoding: 'utf8' });
  return JSON.parse(raw.trim().split('\n').pop());
}

const headline = log => log.split('\n').find(l => /^(Created|Upgraded) /.test(l)) ?? log.split('\n')[0];

console.log(`First-run database check → ${dbPath}\n`);

try {
  ok('Database file does not exist before the run', !fs.existsSync(dbPath));

  const firstLog = migrate();
  ok('db:migrate creates the missing database', fs.existsSync(dbPath));
  ok('First run reports a creation (not an upgrade)', /^Created /m.test(firstLog), headline(firstLog));

  const first = inspect();
  const missing = REQUIRED_TABLES.filter(t => !first.tables.includes(t));
  ok('Every required table exists', missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : `${first.tables.length} tables`);
  ok('Inherited upgrade columns were applied', first.requestCols.includes('user_id') && first.requestCols.includes('session_id') && first.apiKeyCols.includes('user_id'));
  ok('Model catalog was seeded', first.models > 0, `${first.models} models`);
  ok('Fallback chain was seeded', first.fallback > 0, `${first.fallback} slots`);
  ok('Default project was seeded', first.projects === 1);
  ok('Default settings were seeded', first.settings > 0, `${first.settings} keys`);

  const secondLog = migrate();
  const second = inspect();
  ok('Second run upgrades in place instead of recreating', /^Upgraded /m.test(secondLog), headline(secondLog));
  ok('Re-running does not duplicate models', second.models === first.models, `${second.models} models`);
  ok('Re-running keeps the seeded project', second.projects === first.projects);
  ok('Table set is stable', second.tables.length === first.tables.length);
} finally {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
