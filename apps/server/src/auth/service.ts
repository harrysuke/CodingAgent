/**
 * Account + session service.
 *
 * Threat model: CodingAgent is one Node process with one SQLite file. The
 * owner's provider keys must never be readable or spendable by another
 * account, and must never be reachable without logging in at all.
 *
 *  - Bearer tokens are random 32 bytes; only their SHA-256 hash is stored.
 *  - The first account requires AGENT_TOKEN (a local .env secret) and claims
 *    every pre-existing unowned row, so a stranger hitting a fresh server
 *    cannot take over the owner's keys or workspaces.
 *  - Later accounts start with zero keys and their own workspace directory.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AuthResult, AuthStatus, AuthUser } from '@codingagent/shared';
import { getDb } from '../db/client';
import { env } from '../env';
import { decrypt } from '../llm/keys';
import { hashPassword, verifyPassword } from './password';

type Row = Record<string, any>;

/** Everything a request is allowed to do, resolved once by the auth middleware. */
export interface Actor {
  userId: string;
  email: string;
  name: string;
  isAdmin: boolean;
  /** Non-admin accounts are confined here; empty means full host access. */
  homeRoot: string;
  allowShell: boolean;
}

export class AuthError extends Error {
  constructor(message: string, readonly status: 400 | 401 | 403 | 409 = 400) {
    super(message);
  }
}

const nowIso = () => new Date().toISOString();
const normEmail = (email: string) => email.trim().toLowerCase();
const tokenHash = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

// ---------------------------------------------------------------------------
// Brute-force throttle (per process, best effort — enough for a self-hosted app)
// ---------------------------------------------------------------------------
const attempts = new Map<string, { fails: number; until: number }>();
const MAX_FAILS = 5;
const LOCK_MS = 60_000;

function assertNotLocked(key: string): void {
  const record = attempts.get(key);
  if (record && record.until > Date.now()) {
    throw new AuthError(`Too many failed attempts. Try again in ${Math.ceil((record.until - Date.now()) / 1000)}s.`, 401);
  }
  if (record && record.until <= Date.now()) attempts.delete(key);
}

function noteFailure(key: string): void {
  const record = attempts.get(key) ?? { fails: 0, until: 0 };
  record.fails += 1;
  if (record.fails >= MAX_FAILS) record.until = Date.now() + LOCK_MS;
  attempts.set(key, record);
}

function clearFailures(key: string): void { attempts.delete(key); }

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function userCount(): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM agent_users').get() as { n: number }).n;
}

function usableKeyCount(userId: string): number {
  const rows = getDb().prepare('SELECT encrypted_key, iv, auth_tag FROM api_keys WHERE user_id=? AND enabled=1').all(userId) as Row[];
  let count = 0;
  for (const row of rows) {
    try { decrypt(row.encrypted_key, row.iv, row.auth_tag); count++; } catch { /* wrong ENCRYPTION_KEY */ }
  }
  return count;
}

function toPublicUser(row: Row): AuthUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name ?? '',
    isAdmin: row.is_admin === 1 || row.is_admin === true,
    keyCount: usableKeyCount(row.id),
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at ?? null,
  };
}

export function authStatus(): AuthStatus {
  const needsSetup = userCount() === 0;
  return {
    needsSetup,
    registrationOpen: env.allowRegistration,
    userShellEnabled: env.allowUserShell,
    // Deliberately not disclosed once setup is done.
    setupTokenIsDefault: needsSetup && env.setupTokenIsDefault,
  };
}

/** Absolute directory a non-admin account is confined to. */
export function homeRootFor(userId: string): string {
  return path.join(env.userWorkspacesRoot, userId);
}

function actorFromRow(row: Row): Actor {
  const isAdmin = row.is_admin === 1 || row.is_admin === true;
  return {
    userId: row.id,
    email: row.email,
    name: row.name ?? '',
    isAdmin,
    homeRoot: isAdmin ? '' : homeRootFor(row.id),
    allowShell: isAdmin || env.allowUserShell,
  };
}

function createSession(userId: string): { token: string; expiresAt: number } {
  const db = getDb();
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + env.sessionTtlDays * 86_400_000;
  db.prepare('INSERT INTO agent_user_sessions (token_hash, user_id, expires_at_ms, last_seen_at) VALUES (?,?,?,?)')
    .run(tokenHash(token), userId, expiresAt, Date.now());
  // Opportunistic cleanup so the table does not grow forever.
  db.prepare('DELETE FROM agent_user_sessions WHERE expires_at_ms < ?').run(Date.now());
  return { token, expiresAt };
}

/** Give the first admin every row that predates accounts (provider keys, projects…). */
function claimLegacyRows(userId: string): void {
  const db = getDb();
  db.transaction(() => {
    for (const table of ['api_keys', 'projects', 'agent_sessions', 'agent_permissions', 'requests']) {
      db.prepare(`UPDATE ${table} SET user_id=? WHERE user_id IS NULL`).run(userId);
    }
    // Carry the owner's existing agent preferences into their personal
    // settings, so login changes nothing about how the agent behaves.
    const globals = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'agent:%'").all() as Array<{ key: string; value: string }>;
    const put = db.prepare('INSERT OR REPLACE INTO agent_user_settings (user_id, key, value) VALUES (?,?,?)');
    for (const row of globals) put.run(userId, row.key, row.value);

    // A DB copied to another machine (a desktop installer, a backup restore)
    // can still point at the previous machine's folder. Never let the first
    // admin inherit a project id whose root does not exist right here: the
    // agent would otherwise start with a bogus sandbox root, and the health
    // endpoint would disclose a path from someone else's computer.
    const activeId = globals.find(r => r.key === 'agent:active_project')?.value;
    if (activeId) {
      const project = db.prepare('SELECT root_path FROM projects WHERE id=?').get(activeId) as { root_path: string } | undefined;
      let usable = false;
      try {
        usable = !!project?.root_path && fs.statSync(path.resolve(project.root_path)).isDirectory();
      } catch { /* missing / unreadable on this machine */ }
      if (!usable) {
        db.prepare("DELETE FROM agent_user_settings WHERE user_id=? AND key='agent:active_project'").run(userId);
      }
    }
  })();
}

/** A new account gets its own workspace project, so it never inherits ours. */
function provisionWorkspace(userId: string, isAdmin: boolean): void {
  const root = homeRootFor(userId);
  fs.mkdirSync(root, { recursive: true });
  if (isAdmin) return; // the admin already owns the existing projects
  const id = crypto.randomUUID();
  const db = getDb();
  db.prepare('INSERT INTO projects (id, name, root_path, user_id, created_at, updated_at) VALUES (?,?,?,?,?,?)')
    .run(id, 'My workspace', root, userId, nowIso(), nowIso());
  db.prepare('INSERT OR REPLACE INTO agent_user_settings (user_id, key, value) VALUES (?,?,?)')
    .run(userId, 'agent:active_project', id);
}

export function register(input: { email: string; password: string; name?: string; setupToken?: string }): AuthResult {
  const email = normEmail(input.email);
  if (!email) throw new AuthError('Email is required.');
  const db = getDb();
  const first = userCount() === 0;

  if (first) {
    if (!input.setupToken || input.setupToken !== env.setupToken) {
      throw new AuthError(
        'This is the first account. Enter the AGENT_TOKEN from your .env as the setup token to claim the existing provider keys.',
        403,
      );
    }
  } else if (!env.allowRegistration) {
    throw new AuthError('Registration is closed on this server. Ask the administrator for an account.', 403);
  }

  if (db.prepare('SELECT 1 FROM agent_users WHERE email=?').get(email)) {
    throw new AuthError('An account with that email already exists.', 409);
  }

  const id = crypto.randomUUID();
  const isAdmin = first;
  db.prepare('INSERT INTO agent_users (id, email, name, password_hash, is_admin, created_at, last_login_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, email, (input.name ?? '').trim(), hashPassword(input.password), isAdmin ? 1 : 0, nowIso(), nowIso());

  if (isAdmin) claimLegacyRows(id);
  provisionWorkspace(id, isAdmin);

  const session = createSession(id);
  const row = db.prepare('SELECT * FROM agent_users WHERE id=?').get(id) as Row;
  return { ...session, user: toPublicUser(row) };
}

export function login(input: { email: string; password: string }): AuthResult {
  const email = normEmail(input.email);
  assertNotLocked(email);
  const db = getDb();
  const row = db.prepare('SELECT * FROM agent_users WHERE email=?').get(email) as Row | undefined;
  if (!row || !verifyPassword(input.password, row.password_hash)) {
    noteFailure(email);
    throw new AuthError('Incorrect email or password.', 401);
  }
  clearFailures(email);
  db.prepare('UPDATE agent_users SET last_login_at=? WHERE id=?').run(nowIso(), row.id);
  const session = createSession(row.id);
  return { ...session, user: toPublicUser({ ...row, last_login_at: nowIso() }) };
}

export function verifySession(token: string): Actor | null {
  if (!token) return null;
  const db = getDb();
  const row = db.prepare(`
    SELECT u.* FROM agent_user_sessions s
    JOIN agent_users u ON u.id = s.user_id
    WHERE s.token_hash=? AND s.expires_at_ms > ?
  `).get(tokenHash(token), Date.now()) as Row | undefined;
  if (!row) return null;
  db.prepare('UPDATE agent_user_sessions SET last_seen_at=? WHERE token_hash=?').run(Date.now(), tokenHash(token));
  return actorFromRow(row);
}

export function logout(token: string): void {
  if (!token) return;
  getDb().prepare('DELETE FROM agent_user_sessions WHERE token_hash=?').run(tokenHash(token));
}

export function logoutEverywhere(userId: string): void {
  getDb().prepare('DELETE FROM agent_user_sessions WHERE user_id=?').run(userId);
}

export function changePassword(userId: string, current: string, next: string): AuthUser {
  const db = getDb();
  const row = db.prepare('SELECT * FROM agent_users WHERE id=?').get(userId) as Row | undefined;
  if (!row) throw new AuthError('Account not found.', 401);
  if (!verifyPassword(current, row.password_hash)) throw new AuthError('Current password is incorrect.', 401);
  db.prepare('UPDATE agent_users SET password_hash=? WHERE id=?').run(hashPassword(next), userId);
  logoutEverywhere(userId);
  return toPublicUser(db.prepare('SELECT * FROM agent_users WHERE id=?').get(userId) as Row);
}

export function actorById(userId: string): Actor | null {
  const row = getDb().prepare('SELECT * FROM agent_users WHERE id=?').get(userId) as Row | undefined;
  return row ? actorFromRow(row) : null;
}

export function currentUser(userId: string): AuthUser | null {
  const row = getDb().prepare('SELECT * FROM agent_users WHERE id=?').get(userId) as Row | undefined;
  return row ? toPublicUser(row) : null;
}
