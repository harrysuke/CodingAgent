import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';

/** Compare two absolute paths with the platform's case sensitivity. */
export function samePath(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return CASE_INSENSITIVE ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export function isInside(root: string, candidate: string): boolean {
  const base = path.resolve(root);
  const target = path.resolve(candidate);
  const norm = (value: string) => (CASE_INSENSITIVE ? value.toLowerCase() : value);
  const b = norm(base);
  const t = norm(target);
  return t === b || t.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

/** `~`, `~/foo` and `~\\foo` -> the user's home directory. */
export function expandHome(input: string): string {
  const value = (input ?? '').trim();
  if (value === '~') return os.homedir();
  if (/^~[\\/]/.test(value)) return path.join(os.homedir(), value.slice(2));
  return value;
}

/**
 * Nearest existing ancestor of a path. Used to validate a file that is about
 * to be created: its parent must already be inside the sandbox.
 */
export function nearestExisting(target: string): string {
  let current = path.resolve(target);
  for (let i = 0; i < 64; i++) {
    if (fs.existsSync(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

export function realpathOrSelf(target: string): string {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return path.resolve(target);
  }
}

/**
 * Containment check that also follows symlinks on the nearest existing
 * ancestor. A textual `isInside` alone can be defeated by a directory
 * symlink placed inside a confined workspace that points at C:\\ or ~/.ssh.
 */
export function isInsideReal(root: string, candidate: string): boolean {
  return isInside(realpathOrSelf(root), realpathOrSelf(nearestExisting(candidate)));
}

/**
 * Never let a tool escape the active workspace root (blocks `..`, absolute
 * paths outside the root, and symlinks that point outside the root).
 *
 * Symlink protection matters because a repository can legitimately contain a
 * link to `~/.ssh`; resolving only the textual path would happily read it.
 */
export function resolveSafe(root: string, relative: string): string {
  const base = path.resolve(root);
  const cleaned = expandHome(relative ?? '').replace(/\\/g, '/').trim();
  if (!cleaned || cleaned === '.') return base;

  let target: string;
  if (path.isAbsolute(cleaned) || /^[A-Za-z]:\//.test(cleaned)) {
    // Absolute paths are allowed only when they are already inside the root.
    target = path.resolve(cleaned);
  } else {
    target = path.resolve(base, cleaned);
  }

  if (!isInside(base, target)) {
    throw new Error(`Path escapes the workspace: ${relative}`);
  }

  // Follow symlinks for the existing part of the path; a link pointing outside
  // the root would otherwise defeat the textual check above.
  const probe = nearestExisting(target);
  const realBase = realpathOrSelf(base);
  const realProbe = realpathOrSelf(probe);
  if (!isInside(realBase, realProbe)) {
    throw new Error(`Path escapes the workspace through a symlink: ${relative}`);
  }
  return target;
}

export function toRelative(root: string, absolute: string): string {
  return path.relative(path.resolve(root), path.resolve(absolute)).replace(/\\/g, '/');
}

export const DEFAULT_IGNORE = [
  'node_modules/**', '.git/**', 'dist/**', 'build/**', '.vite/**', 'coverage/**',
  '**/*.lock', 'data/*.db', 'data/*.db-wal', 'data/*.db-shm',
  '.env', '.env.local', '**/.DS_Store', 'apps/desktop/src-tauri/target/**',
];

/** Folders that must never be offered as a workspace (system noise / huge trees). */
export const UNBROWSABLE = new Set([
  'node_modules', '.git', 'System Volume Information', '$Recycle.Bin', 'AppData',
  'Windows', 'Program Files', 'Program Files (x86)', 'ProgramData',
]);

export function isBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 8000);
  for (const byte of sample) if (byte === 0) return true;
  return false;
}

export function ensureParent(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

export function fileExists(filePath: string): boolean {
  try { fs.statSync(filePath); return true; } catch { return false; }
}

export function isDirectory(target: string): boolean {
  try { return fs.statSync(target).isDirectory(); } catch { return false; }
}
