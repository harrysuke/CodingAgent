/**
 * One-shot bootstrap for the Coding Agent workspace.
 *
 *  - Copies & renames the FreeLLMAPI SQLite database into data/codingagent.db
 *    (VACUUM INTO is used when the sqlite3 CLI is available so WAL contents are
 *    folded in; otherwise a plain file copy is used).
 *  - Carries the source ENCRYPTION_KEY over so the existing encrypted provider
 *    keys stay readable, or generates a fresh one for a clean install.
 *  - Creates the workspace directory the agent operates on.
 *
 * Safe to run repeatedly: it never overwrites an existing database or .env.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceProject = process.env.SOURCE_PROJECT ?? 'D:/laragon/www/playground/freellmapi_bak';
const sourceDb = path.join(sourceProject, 'server/data/freeapi.db');
const sourceEnv = path.join(sourceProject, '.env');
const targetDb = path.join(root, 'data/codingagent.db');
const targetEnv = path.join(root, '.env');
const workspace = path.join(root, 'workspace');

fs.mkdirSync(path.dirname(targetDb), { recursive: true });
fs.mkdirSync(workspace, { recursive: true });

function readSourceKey() {
  if (!fs.existsSync(sourceEnv)) return null;
  const matches = fs.readFileSync(sourceEnv, 'utf8').match(/^ENCRYPTION_KEY\s*=\s*([0-9a-fA-F]{64})\s*$/gm);
  if (!matches?.length) return null;
  return matches[matches.length - 1].split('=')[1].trim();
}

if (!fs.existsSync(targetDb)) {
  if (!fs.existsSync(sourceDb)) {
    console.warn(`[setup] Source database not found at ${sourceDb}; a fresh database will be created on first run.`);
  } else {
    let copied = false;
    try {
      const sqlite = process.env.SQLITE3_BIN ?? 'sqlite3';
      execFileSync(sqlite, [sourceDb, `VACUUM INTO '${targetDb.replace(/\\/g, '/')}';`], { stdio: 'pipe' });
      copied = fs.existsSync(targetDb);
      if (copied) console.log('[setup] Copied DB with VACUUM INTO (WAL folded into a clean snapshot).');
    } catch {
      /* sqlite3 CLI absent - fall through to plain copy */
    }
    if (!copied) {
      for (const suffix of ['', '-wal', '-shm']) {
        const from = sourceDb + suffix;
        if (fs.existsSync(from)) fs.copyFileSync(from, targetDb + suffix);
      }
      console.log('[setup] Copied DB files directly (WAL sidecars included).');
    }
  }
} else {
  console.log('[setup] data/codingagent.db already exists - kept as is.');
}

if (!fs.existsSync(targetEnv)) {
  const key = readSourceKey() ?? crypto.randomBytes(32).toString('hex');
  // AGENT_TOKEN is the one-time first-admin setup secret. Never ship the
  // public placeholder into a real install: anyone on the LAN could otherwise
  // register first and claim the owner's provider keys.
  const template = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  const env = template
    .replace('your-64-char-hex-key-here', key)
    .replace('change-me-local-dev-token', crypto.randomBytes(24).toString('base64url'));
  fs.writeFileSync(targetEnv, env, 'utf8');
  console.log(`[setup] Wrote .env (encryption key ${readSourceKey() ? 'inherited from source project' : 'newly generated'}; fresh setup token).`);
  console.log('[setup] Save the AGENT_TOKEN line — it is needed once to create your admin account.');
} else {
  console.log('[setup] .env already exists - kept as is.');
}

console.log('[setup] Done. Run `npm install` then `npm run dev`.');
