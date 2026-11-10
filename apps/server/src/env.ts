import dotenv from 'dotenv';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Project root, works both from `src/` (tsx) and `dist/` (bundled esbuild). */
export function projectRoot(): string {
  let dir = here;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, '.env.example'))) return dir;
    // also accept a packaged resources/server/ layout
    if (fs.existsSync(path.join(dir, 'server-runtime.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(here, '../../..');
}

const ROOT = projectRoot();
dotenv.config({ path: path.join(ROOT, '.env') });
// A packaged desktop build keeps its .env next to the server bundle.
if (!process.env.ENCRYPTION_KEY) dotenv.config({ path: path.join(here, '.env') });

function int(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

export const env = {
  root: ROOT,
  port: int(process.env.PORT, 4317),
  host: process.env.HOST ?? '127.0.0.1',
  token: process.env.AGENT_TOKEN ?? 'change-me-local-dev-token',
  encryptionKey: process.env.ENCRYPTION_KEY ?? '',
  dbPath: path.resolve(ROOT, process.env.DB_PATH ?? './data/codingagent.db'),
  workspaceRoot: path.resolve(process.env.WORKSPACE_ROOT ?? path.join(ROOT, 'workspace')),
  maxSteps: int(process.env.AGENT_MAX_STEPS, 30),
  permissionMode: (process.env.AGENT_PERMISSION_MODE ?? 'ask') as 'ask' | 'allow' | 'deny',
  extraOrigins: (process.env.EXTRA_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean),

  // --- accounts / BYOK -----------------------------------------------------
  /** AGENT_TOKEN is no longer an API credential: it is the one-time setup
   *  secret for the first admin account and the desktop sidecar health probe. */
  setupToken: process.env.AGENT_TOKEN ?? 'change-me-local-dev-token',
  /** True when the owner never rotated the shipped placeholder. */
  setupTokenIsDefault: !process.env.AGENT_TOKEN
    || process.env.AGENT_TOKEN.trim() === 'change-me-local-dev-token',
  allowRegistration: (process.env.ALLOW_REGISTRATION ?? 'true').toLowerCase() !== 'false',
  sessionTtlDays: int(process.env.AGENT_SESSION_TTL_DAYS, 30),
  /** Non-admin accounts are confined to their own folder under this root. */
  userWorkspacesRoot: path.resolve(ROOT, process.env.USER_WORKSPACES_ROOT ?? './data/workspaces'),
  /**
   * A shell can `cd ..` out of any in-process sandbox. Disabled for regular
   * accounts by default so they cannot reach the host .env / database.
   */
  allowUserShell: (process.env.AGENT_ALLOW_USER_SHELL ?? 'false').toLowerCase() === 'true',
};

export function assertEncryptionKey(): void {
  if (!/^[0-9a-fA-F]{64}$/.test(env.encryptionKey)) {
    throw new Error(
      'ENCRYPTION_KEY must be 64 hex chars. Run `npm run setup`, or copy the key from the source project .env ' +
      'so the pre-existing encrypted provider keys in codingagent.db can be decrypted.',
    );
  }
}
