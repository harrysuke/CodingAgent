import fs from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import ignore from 'ignore';
import { createTwoFilesPatch } from 'diff';
import type { FileNode } from '@codingagent/shared';
import { DEFAULT_IGNORE, ensureParent, isBinary, resolveSafe, toRelative, fileExists } from './paths';

const MAX_READ_BYTES = 512 * 1024;
const MAX_OUTPUT_CHARS = 60_000;

export interface ReadResult { path: string; content: string; totalLines: number; truncated: boolean }

export function readFile(root: string, rel: string, offset = 1, limit = 400): ReadResult {
  const abs = resolveSafe(root, rel);
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) throw new Error(`${rel} is a directory; use list instead.`);
  const buf = fs.readFileSync(abs);
  if (isBinary(buf)) throw new Error(`${rel} looks like a binary file.`);
  const all = buf.toString('utf8').slice(0, MAX_READ_BYTES).split(/\r?\n/);
  const start = Math.max(0, offset - 1);
  const slice = all.slice(start, start + limit);
  const width = String(start + slice.length).length;
  const content = slice.map((line, i) => `${String(start + i + 1).padStart(width, ' ')} | ${line}`).join('\n');
  return {
    path: toRelative(root, abs),
    content: content.length > MAX_OUTPUT_CHARS ? content.slice(0, MAX_OUTPUT_CHARS) + '\n…(truncated)' : content,
    totalLines: all.length,
    truncated: start + slice.length < all.length,
  };
}

export function writeFile(root: string, rel: string, content: string): { path: string; before: string | null; after: string; patch: string } {
  const abs = resolveSafe(root, rel);
  const before = fileExists(abs) ? fs.readFileSync(abs, 'utf8') : null;
  ensureParent(abs);
  fs.writeFileSync(abs, content, 'utf8');
  return { path: toRelative(root, abs), before, after: content, patch: makePatch(toRelative(root, abs), before ?? '', content) };
}

export function editFile(
  root: string, rel: string, oldString: string, newString: string, replaceAll = false,
): { path: string; before: string; after: string; patch: string; replacements: number } {
  const abs = resolveSafe(root, rel);
  if (!fileExists(abs)) throw new Error(`File not found: ${rel}`);
  const before = fs.readFileSync(abs, 'utf8');
  const occurrences = before.split(oldString).length - 1;
  if (occurrences === 0) {
    const probe = oldString.split('\n')[0].slice(0, 60);
    throw new Error(`oldString not found in ${rel} (looked for "${probe}…"). Read the file first to get the exact text.`);
  }
  if (occurrences > 1 && !replaceAll) {
    throw new Error(`oldString occurs ${occurrences} times in ${rel}. Provide more context or set replaceAll=true.`);
  }
  const after = replaceAll ? before.split(oldString).join(newString) : before.replace(oldString, newString);
  fs.writeFileSync(abs, after, 'utf8');
  return {
    path: toRelative(root, abs), before, after,
    patch: makePatch(toRelative(root, abs), before, after),
    replacements: replaceAll ? occurrences : 1,
  };
}

export function makePatch(rel: string, before: string, after: string): string {
  const patch = createTwoFilesPatch(`a/${rel}`, `b/${rel}`, before, after, undefined, undefined, { context: 3 });
  return patch.length > MAX_OUTPUT_CHARS ? patch.slice(0, MAX_OUTPUT_CHARS) + '\n…(diff truncated)' : patch;
}

export function listDir(root: string, rel = '.'): FileNode[] {
  const abs = resolveSafe(root, rel || '.');
  if (!fileExists(abs)) return [];
  const ig = ignore().add(DEFAULT_IGNORE);
  return fs.readdirSync(abs, { withFileTypes: true })
    .filter(entry => {
      const candidate = toRelative(root, path.join(abs, entry.name));
      try { return !ig.ignores(candidate); } catch { return true; }
    })
    .sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1))
    .map(entry => {
      const full = path.join(abs, entry.name);
      const node: FileNode = { name: entry.name, path: toRelative(root, full), type: entry.isDirectory() ? 'dir' : 'file' };
      if (entry.isFile()) {
        try { node.size = fs.statSync(full).size; } catch { /* ignore */ }
      }
      return node;
    });
}

export function tree(root: string, rel = '.', depth = 3): FileNode[] {
  if (depth <= 0) return [];
  return listDir(root, rel).map(node => {
    if (node.type === 'dir') node.children = tree(root, node.path, depth - 1);
    return node;
  });
}

export interface GlobOptions { cwd?: string; max?: number; filesOnly?: boolean }

export function glob(root: string, pattern: string, options: GlobOptions = {}): string[] {
  const cwd = options.cwd ? resolveSafe(root, options.cwd) : root;
  const matches = fg.sync(pattern, {
    cwd, dot: false, onlyFiles: options.filesOnly ?? true, followSymbolicLinks: false,
    ignore: DEFAULT_IGNORE, suppressErrors: true,
  });
  return matches.slice(0, options.max ?? 200).map(m => toRelative(root, path.join(cwd, m)));
}

export interface GrepMatch { path: string; line: number; text: string }

export function grep(root: string, pattern: string, opts: { include?: string; path?: string; max?: number; caseSensitive?: boolean } = {}): GrepMatch[] {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, opts.caseSensitive ? 'g' : 'gi');
  } catch (err) {
    throw new Error(`Invalid regex: ${(err as Error).message}`);
  }
  const scope = opts.path ? resolveSafe(root, opts.path) : root;
  const stat = fs.existsSync(scope) ? fs.statSync(scope) : null;
  const candidates = stat?.isFile()
    ? [scope]
    : fg.sync(opts.include ? `**/${opts.include}` : '**/*', {
        cwd: scope, absolute: true, onlyFiles: true, dot: false,
        ignore: DEFAULT_IGNORE, suppressErrors: true,
      });
  const out: GrepMatch[] = [];
  const max = opts.max ?? 100;
  for (const file of candidates) {
    let text: string;
    try {
      const buf = fs.readFileSync(file);
      if (isBinary(buf)) continue;
      text = buf.toString('utf8');
    } catch { continue; }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length && out.length < max; i++) {
      const line = lines[i];
      if (line.length > 2000) continue;
      regex.lastIndex = 0;
      if (regex.test(line)) {
        out.push({ path: toRelative(root, file), line: i + 1, text: line.length > 300 ? line.slice(0, 300) + '…' : line });
      }
    }
    if (out.length >= max) break;
  }
  return out;
}

export async function webfetch(url: string, maxChars = 20_000): Promise<string> {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only http/https URLs are supported.');
  const res = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
    headers: { 'User-Agent': 'CodingAgent/0.1 (+https://github.com)' },
  });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  const text = await res.text();
  const stripped = text
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return stripped.slice(0, maxChars) + (stripped.length > maxChars ? '\n…(truncated)' : '');
}

export function fileStat(root: string, rel: string) {
  const abs = resolveSafe(root, rel);
  const s = fs.statSync(abs);
  return { path: toRelative(root, abs), size: s.size, isDirectory: s.isDirectory(), modifiedAt: s.mtime.toISOString() };
}
