import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fg from 'fast-glob';
import type { BrowseResult, DirEntry, Project, WorkspaceInfo } from '@codingagent/shared';
import { env } from '../env';
import {
  createProject, findProjectByPath, getActiveProject, getProject, getSession, listProjects,
  setActiveProjectId, setSessionProject, touchProject,
} from '../db/repo';
import type { Actor } from '../auth/service';
import { DEFAULT_IGNORE, UNBROWSABLE, expandHome, isDirectory, isInside, isInsideReal, samePath } from './paths';

const MAX_COUNTED_FILES = 6000;

/**
 * Read the branch straight out of .git/HEAD. Avoids shelling out to git on
 * every workspace open, and still works for worktrees where .git is a file.
 */
export function gitBranch(root: string): string | null {
  try {
    let gitPath = path.join(root, '.git');
    const stat = fs.statSync(gitPath);
    if (stat.isFile()) {
      const pointer = fs.readFileSync(gitPath, 'utf8').match(/gitdir:\s*(.+)/i)?.[1]?.trim();
      if (!pointer) return null;
      gitPath = path.resolve(root, pointer);
    }
    const head = fs.readFileSync(path.join(gitPath, 'HEAD'), 'utf8').trim();
    const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/);
    if (ref) return ref[1];
    return head.slice(0, 8) || null;
  } catch {
    return null;
  }
}

function hasAnyEntry(dir: string): boolean {
  try {
    const handle = fs.opendirSync(dir);
    try {
      return handle.readSync() !== null;
    } finally {
      handle.closeSync();
    }
  } catch {
    return false;
  }
}

function safeReaddir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

export function workspaceInfo(project: Project, opts: { counts?: boolean } = {}): WorkspaceInfo {
  const root = path.resolve(project.rootPath || env.workspaceRoot);
  const exists = isDirectory(root);
  let fileCount = 0;
  let dirCount = 0;
  let bytes = 0;

  if (exists && (opts.counts ?? true)) {
    try {
      const files = fg.sync('**/*', {
        cwd: root, onlyFiles: true, dot: false, ignore: DEFAULT_IGNORE,
        suppressErrors: true, followSymbolicLinks: false,
      }).slice(0, MAX_COUNTED_FILES);
      fileCount = files.length;
      for (const rel of files) {
        try { bytes += fs.statSync(path.join(root, rel)).size; } catch { /* vanished */ }
      }
      dirCount = fg.sync('**/*', {
        cwd: root, onlyFiles: false, onlyDirectories: true, dot: false,
        ignore: DEFAULT_IGNORE, suppressErrors: true, followSymbolicLinks: false,
      }).slice(0, MAX_COUNTED_FILES).length;
    } catch { /* unreadable tree: report zeros */ }
  }

  return {
    project,
    root,
    exists,
    isGit: exists && fs.existsSync(path.join(root, '.git')),
    branch: exists ? gitBranch(root) : null,
    fileCount,
    dirCount,
    skillCount: countSkills(root),
    bytes,
  };
}

function countSkills(root: string): number {
  try {
    const dir = path.join(root, '.codingagent', 'skills');
    return safeReaddir(dir).filter(entry => entry.isDirectory()).length;
  } catch {
    return 0;
  }
}

/**
 * Regular accounts are confined to their own folder. An admin (the owner)
 * has no homeRoot and can open any folder on this machine, as before.
 */
function confined(actor: Actor): boolean { return !actor.isAdmin && !!actor.homeRoot; }

export function userHome(actor: Actor): string {
  const home = confined(actor) ? path.resolve(actor.homeRoot) : path.resolve(env.workspaceRoot);
  // Both branches must exist: an unbound session is confined here, and a
  // folder picker may register it as a project (which requires a real dir).
  fs.mkdirSync(home, { recursive: true });
  return home;
}

/** Clamp an arbitrary path into the account's sandbox (symlinks included). */
export function clampPath(actor: Actor, target: string): string {
  const resolved = path.resolve(expandHome(target));
  if (!confined(actor)) return resolved;
  const home = path.resolve(actor.homeRoot);
  return isInside(home, resolved) && isInsideReal(home, resolved) ? resolved : home;
}

/**
 * Reject a path that escapes the account's sandbox instead of silently
 * clamping it. Used by endpoints where the caller explicitly supplies a root.
 */
export function assertAllowedRoot(actor: Actor, target: string): string {
  const resolved = clampPath(actor, target);
  if (confined(actor) && !samePath(resolved, path.resolve(expandHome(target)))) {
    throw new Error('This account can only use folders inside its own workspace. Ask the administrator for host access.');
  }
  return resolved;
}

/**
 * Clamp *any* project root before it is handed to a file/attachment tool.
 * Project rows are user-owned but can be created through the API, so every
 * consumer must re-check instead of trusting the stored rootPath.
 */
export function safeRoot(actor: Actor, root: string): string {
  const home = userHome(actor);
  const candidate = path.resolve(root || home);
  if (!confined(actor)) return candidate;
  return clampPath(actor, candidate);
}

/** Absolute root the agent is allowed to touch right now. */
export function activeRoot(actor: Actor): string {
  const home = userHome(actor);
  const project = getActiveProject(actor.userId);
  const candidate = project?.rootPath || home;
  const safe = safeRoot(actor, candidate);
  if (safe && isDirectory(safe)) return safe;
  // Fall back to the account's own workspace so tools never get an empty root.
  return home;
}

/** The project bound to one session. Never falls back to the account pointer. */
export function sessionProject(sessionId: string, actor: Actor): Project | null {
  const session = getSession(sessionId, actor.userId);
  return session ? getProject(session.projectId, actor.userId) : null;
}

/**
 * THE single resolver for a session's sandbox. Everything that can read or
 * write files for a session (the agent loop, file tree, attachments, terminal,
 * health) must go through this.
 *
 * It deliberately never consults `activeRoot()`: that account-wide pointer
 * belongs to whichever session last opened a folder, so using it as a fallback
 * is exactly how a fresh session ended up writing into an older session's
 * directory. An unbound session is confined to the account's private home.
 */
export function runWorkspace(
  sessionId: string,
  actor: Actor,
): { root: string; project: Project | null } {
  const project = sessionProject(sessionId, actor);
  const raw = project?.rootPath?.trim();
  if (raw) {
    const root = safeRoot(actor, raw);
    // safeRoot() clamps a confined account back to its home. Treat a clamped
    // or vanished folder as "unbound" instead of letting the model believe it
    // is writing into the folder shown in the UI.
    if (samePath(root, path.resolve(raw)) && isDirectory(root)) {
      return { root, project };
    }
  }
  return { root: userHome(actor), project: null };
}

/** Sandbox root for one session; identical to the root the agent loop uses. */
export function sessionRoot(sessionId: string, actor: Actor): string {
  return runWorkspace(sessionId, actor).root;
}

/** Workspace info for one session: its own folder, independent of other sessions. */
export function sessionWorkspace(sessionId: string, actor: Actor): WorkspaceInfo {
  const { root, project } = runWorkspace(sessionId, actor);
  if (project) return workspaceInfo({ ...project, rootPath: root });
  // The session's folder vanished (or was never chosen): show the account's
  // private home instead of silently reporting another session's project.
  const fallback = findProjectByPath(root, actor.userId)
    ?? ensureProject(root, path.basename(root) || 'workspace', actor);
  return workspaceInfo(fallback);
}

export function activeWorkspace(actor: Actor): WorkspaceInfo {
  const project = getActiveProject(actor.userId);
  if (project && samePath(clampPath(actor, project.rootPath), path.resolve(project.rootPath))) {
    const info = workspaceInfo(project);
    if (info.exists) return info;
  }
  const home = userHome(actor);
  const fallback = findProjectByPath(home, actor.userId)
    ?? ensureProject(home, path.basename(home) || 'workspace', actor);
  return workspaceInfo(fallback);
}

export function ensureProject(rootPath: string, name: string | undefined, actor: Actor): Project {
  const resolved = clampPath(actor, rootPath);
  const existing = findProjectByPath(resolved, actor.userId);
  if (existing) {
    touchProject(existing.id);
    return existing;
  }
  return createProject(name || path.basename(resolved) || resolved, resolved, actor.userId);
}

/**
 * Validate a folder and register it as a project, WITHOUT changing which
 * workspace is active. Used when a single session claims its own directory.
 */
export function registerWorkspaceFolder(input: string, name: string | undefined, actor: Actor): Project {
  const raw = expandHome(input);
  if (!raw.trim()) throw new Error('A folder path is required.');
  const resolved = assertAllowedRoot(actor, raw);
  if (!fs.existsSync(resolved)) throw new Error(`Folder does not exist: ${resolved}`);
  if (!isDirectory(resolved)) throw new Error(`Not a folder: ${resolved}`);
  return ensureProject(resolved, name, actor);
}

/**
 * Open a folder as the agent's workspace: validates it, registers a project
 * (reusing one for the same path) and binds it either to one session or, for
 * older clients with no sessionId, to the account-wide active pointer.
 *
 * Binding to a session does NOT touch the account pointer, so other sessions
 * (and other tabs signed into the same account) keep their own folders.
 */
export function openWorkspace(
  input: string,
  name: string | undefined,
  actor: Actor,
  options: { sessionId?: string } = {},
): WorkspaceInfo {
  const project = registerWorkspaceFolder(input, name, actor);
  if (options.sessionId) {
    if (!setSessionProject(actor.userId, options.sessionId, project.id)) {
      throw new Error('Session not found.');
    }
  } else {
    setActiveProjectId(project.id, actor.userId);
  }
  touchProject(project.id);
  return workspaceInfo(project);
}

export function recentWorkspaces(actor: Actor, limit = 8): WorkspaceInfo[] {
  const projects = listProjects(actor.userId)
    .filter(p => p.rootPath && isDirectory(p.rootPath))
    .filter(p => samePath(clampPath(actor, p.rootPath), path.resolve(p.rootPath)))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, limit);
  return projects.map(p => workspaceInfo(p, { counts: false }));
}

function driveRoots(): Array<{ name: string; path: string }> {
  const roots: Array<{ name: string; path: string }> = [];
  for (let code = 65; code <= 90; code++) {
    const letter = String.fromCharCode(code);
    const candidate = `${letter}:\\`;
    try {
      if (fs.existsSync(candidate)) roots.push({ name: `${letter}:`, path: candidate });
    } catch { /* unreadable drive */ }
  }
  return roots;
}

function posixRoots(): Array<{ name: string; path: string }> {
  const home = os.homedir();
  const roots = [{ name: 'Home', path: home }];
  for (const candidate of ['/Users', '/home', '/workspace', '/tmp', '/']) {
    if (fs.existsSync(candidate) && !roots.some(r => samePath(r.path, candidate))) {
      roots.push({ name: candidate === '/' ? 'Root' : candidate, path: candidate });
    }
  }
  return roots;
}

/**
 * Where the picker starts when the client gives no path: the workspace the
 * agent already has open, then the user's home, then the first drive/root.
 * Starting at `C:\` would be technically valid but useless.
 */
function defaultBrowseRoot(actor: Actor, roots: Array<{ name: string; path: string }>): string {
  const active = activeRoot(actor);
  if (isDirectory(active)) return active;
  if (!confined(actor)) {
    const home = os.homedir();
    if (isDirectory(home)) return home;
  }
  return roots[0]?.path ?? os.homedir();
}

/**
 * Server-side folder browser. Deliberately directory-only: the UI picks a
 * workspace root, it never reads file contents through this endpoint.
 * Non-admin accounts only ever see their own sandbox subtree.
 */
export function browse(target: string | undefined, actor: Actor): BrowseResult {
  const roots = confined(actor)
    ? [{ name: 'My workspace', path: actor.homeRoot }]
    : (process.platform === 'win32' ? driveRoots() : posixRoots());
  const fallback = defaultBrowseRoot(actor, roots);
  let requested = target?.trim() ? clampPath(actor, expandHome(target)) : fallback;

  // Walk up to the nearest real directory instead of failing outright.
  let guard = 0;
  while (!isDirectory(requested) && guard++ < 32) {
    const parent = path.dirname(requested);
    if (parent === requested) break;
    requested = parent;
  }

  const parent = path.dirname(requested);
  const parentAllowed = !confined(actor) || isInside(actor.homeRoot, parent);
  const entries: DirEntry[] = safeReaddir(requested)
    .filter(entry => entry.isDirectory())
    .filter(entry => !entry.name.startsWith('$') && !UNBROWSABLE.has(entry.name))
    .filter(entry => {
      const full = path.join(requested, entry.name);
      try { return fs.statSync(full).isDirectory(); } catch { return false; }
    })
    .map(entry => {
      const full = path.join(requested, entry.name);
      return {
        name: entry.name,
        path: full,
        isGit: fs.existsSync(path.join(full, '.git')),
        hasChildren: hasAnyEntry(full),
      };
    })
    .sort((a, b) => Number(b.isGit) - Number(a.isGit) || a.name.localeCompare(b.name));

  return {
    path: requested,
    parent: parentAllowed && parent !== requested ? parent : null,
    separator: path.sep,
    roots,
    entries,
  };
}

/** True when `candidate` is the active workspace or lives inside it. */
export function isInActiveWorkspace(candidate: string, actor: Actor): boolean {
  return isInside(activeRoot(actor), candidate);
}
