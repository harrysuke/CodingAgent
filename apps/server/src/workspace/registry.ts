import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fg from 'fast-glob';
import type { BrowseResult, DirEntry, Project, WorkspaceInfo } from '@codingagent/shared';
import { env } from '../env';
import {
  createProject, findProjectByPath, getActiveProject, listProjects, setActiveProjectId, touchProject,
} from '../db/repo';
import { DEFAULT_IGNORE, UNBROWSABLE, expandHome, isDirectory, isInside, samePath } from './paths';

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

/** Absolute root the agent is allowed to touch right now. */
export function activeRoot(): string {
  const project = getActiveProject();
  const root = project?.rootPath || env.workspaceRoot;
  if (root && isDirectory(root)) return path.resolve(root);
  // Fall back to the bundled workspace so tools never operate on an empty root.
  fs.mkdirSync(env.workspaceRoot, { recursive: true });
  return path.resolve(env.workspaceRoot);
}

export function activeWorkspace(): WorkspaceInfo {
  const project = getActiveProject();
  if (project) {
    const info = workspaceInfo(project);
    if (info.exists) return info;
    // The folder was moved or deleted: fall back to the bundled workspace.
    return workspaceInfo(ensureProject(env.workspaceRoot, path.basename(env.workspaceRoot) || 'workspace'));
  }
  return workspaceInfo(ensureProject(env.workspaceRoot, path.basename(env.workspaceRoot) || 'workspace'));
}

export function ensureProject(rootPath: string, name?: string): Project {
  const resolved = path.resolve(expandHome(rootPath));
  const existing = findProjectByPath(resolved);
  if (existing) {
    touchProject(existing.id);
    return existing;
  }
  return createProject(name || path.basename(resolved) || resolved, resolved);
}

/**
 * Open a folder as the agent's workspace: validates it, registers a project
 * (reusing one for the same path) and makes it the active sandbox root.
 */
export function openWorkspace(input: string, name?: string): WorkspaceInfo {
  const raw = expandHome(input);
  if (!raw.trim()) throw new Error('A folder path is required.');
  const resolved = path.resolve(raw);
  if (!fs.existsSync(resolved)) throw new Error(`Folder does not exist: ${resolved}`);
  if (!isDirectory(resolved)) throw new Error(`Not a folder: ${resolved}`);

  const project = ensureProject(resolved, name);
  setActiveProjectId(project.id);
  touchProject(project.id);
  return workspaceInfo(project);
}

export function recentWorkspaces(limit = 8): WorkspaceInfo[] {
  const projects = listProjects()
    .filter(p => p.rootPath && isDirectory(p.rootPath))
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
function defaultBrowseRoot(roots: Array<{ name: string; path: string }>): string {
  const active = activeRoot();
  if (isDirectory(active)) return active;
  const home = os.homedir();
  if (isDirectory(home)) return home;
  return roots[0]?.path ?? os.homedir();
}

/**
 * Server-side folder browser. Deliberately directory-only: the UI picks a
 * workspace root, it never reads file contents through this endpoint.
 */
export function browse(target?: string): BrowseResult {
  const roots = process.platform === 'win32' ? driveRoots() : posixRoots();
  const fallback = defaultBrowseRoot(roots);
  let requested = target?.trim() ? path.resolve(expandHome(target)) : fallback;

  // Walk up to the nearest real directory instead of failing outright.
  let guard = 0;
  while (!isDirectory(requested) && guard++ < 32) {
    const parent = path.dirname(requested);
    if (parent === requested) break;
    requested = parent;
  }

  const parent = path.dirname(requested);
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
    parent: parent === requested ? null : parent,
    separator: path.sep,
    roots,
    entries,
  };
}

/** True when `candidate` is the active workspace or lives inside it. */
export function isInActiveWorkspace(candidate: string): boolean {
  return isInside(activeRoot(), candidate);
}
