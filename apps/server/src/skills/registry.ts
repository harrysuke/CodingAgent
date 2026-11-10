import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import type { InstallSkillResult, SkillInfo, SkillScope } from '@codingagent/shared';

/**
 * Agent Skills live as plain folders with a SKILL.md inside:
 *
 *   <workspace>/.codingagent/skills/<slug>/SKILL.md   (workspace scope)
 *   ~/.codingagent/skills/<slug>/SKILL.md             (user scope)
 *
 * The frontmatter is deliberately a tiny YAML subset so the project does not
 * need a YAML dependency: scalar keys, comma/bracket lists, and a flat
 * `toolDefaults:` block of `tool.param: value` lines.
 */

const SKILL_FILE = 'SKILL.md';
const META_FILE = '.codingagent-meta.json';
const STATE_FILE = path.join('.codingagent', 'skills.json');

export interface ParsedSkill {
  name: string;
  description: string;
  version: string;
  allowedTools: string[];
  toolDefaults: Record<string, Record<string, unknown>>;
  instructions: string;
}

function coerce(value: string): unknown {
  const trimmed = value.trim();
  if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === 'true';
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed.replace(/^["']|["']$/g, '');
}

function parseList(value: string): string[] {
  const inner = value.trim().replace(/^\[|\]$/g, '');
  return inner.split(',').map(item => item.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}

export function parseSkillFile(text: string): ParsedSkill {
  const normalized = text.replace(/^\uFEFF/, '');
  const match = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const data: Record<string, string> = {};
  const toolDefaults: Record<string, Record<string, unknown>> = {};
  let body = normalized;

  if (match) {
    body = normalized.slice(match[0].length);
    let inToolDefaults = false;
    for (const rawLine of match[1].split(/\r?\n/)) {
      if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue;
      const indented = /^\s{2,}/.test(rawLine);
      const line = rawLine.trim();

      if (!indented) {
        inToolDefaults = false;
        const colon = line.indexOf(':');
        if (colon === -1) continue;
        const key = line.slice(0, colon).trim();
        const value = line.slice(colon + 1).trim();
        if (key === 'toolDefaults' && !value) { inToolDefaults = true; continue; }
        data[key] = value.replace(/^["']|["']$/g, '');
        continue;
      }

      if (inToolDefaults) {
        const colon = line.indexOf(':');
        if (colon === -1) continue;
        const [tool, param] = line.slice(0, colon).split('.');
        if (!tool || !param) continue;
        toolDefaults[tool] ??= {};
        toolDefaults[tool][param.trim()] = coerce(line.slice(colon + 1));
      }
    }
  }

  const allowed = data.allowedTools ?? data.allowed_tools ?? data.tools ?? '';
  return {
    name: data.name || '',
    description: data.description || '',
    version: data.version || '0.0.0',
    allowedTools: parseList(allowed),
    toolDefaults,
    instructions: body.trim(),
  };
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'skill';
}

export function skillDirectories(root: string): Array<{ scope: SkillScope; path: string }> {
  return [
    { scope: 'workspace', path: path.join(root, '.codingagent', 'skills') },
    { scope: 'user', path: path.join(os.homedir(), '.codingagent', 'skills') },
  ];
}

interface SkillState { enabled: Record<string, boolean> }

function readState(root: string): SkillState {
  try {
    const raw = fs.readFileSync(path.join(root, STATE_FILE), 'utf8');
    const parsed = JSON.parse(raw) as Partial<SkillState>;
    return { enabled: parsed.enabled && typeof parsed.enabled === 'object' ? parsed.enabled : {} };
  } catch {
    return { enabled: {} };
  }
}

function writeState(root: string, state: SkillState): void {
  const file = path.join(root, STATE_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
}

function readMeta(dir: string): { source: string; installedAt: string | null } {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, META_FILE), 'utf8')) as { source?: string; installedAt?: string };
    return { source: meta.source ?? 'local', installedAt: meta.installedAt ?? null };
  } catch {
    return { source: 'local', installedAt: null };
  }
}

function loadSkill(dir: string, scope: SkillScope, enabled: Record<string, boolean>): SkillInfo | null {
  const file = path.join(dir, SKILL_FILE);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = parseSkillFile(fs.readFileSync(file, 'utf8'));
    const slug = path.basename(dir);
    const id = `${scope}:${slug}`;
    const meta = readMeta(dir);
    return {
      id,
      slug,
      name: parsed.name || slug,
      description: parsed.description,
      version: parsed.version,
      scope,
      enabled: enabled[id] !== false,
      source: meta.source,
      allowedTools: parsed.allowedTools,
      toolDefaults: parsed.toolDefaults,
      instructions: parsed.instructions,
      path: dir,
      installedAt: meta.installedAt,
    };
  } catch {
    return null;
  }
}

export function listSkills(root: string): SkillInfo[] {
  const state = readState(root);
  const out: SkillInfo[] = [];
  for (const { scope, path: dir } of skillDirectories(root)) {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const skill = loadSkill(path.join(dir, entry.name), scope, state.enabled);
      if (skill) out.push(skill);
    }
  }
  return out.sort((a, b) => a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name));
}

export function getSkill(root: string, id: string): SkillInfo | null {
  return listSkills(root).find(s => s.id === id) ?? null;
}

export function setSkillEnabled(root: string, id: string, enabled: boolean): SkillInfo | null {
  const skill = getSkill(root, id);
  if (!skill) return null;
  const state = readState(root);
  state.enabled[id] = enabled;
  writeState(root, state);
  return { ...skill, enabled };
}

export function removeSkill(root: string, id: string): boolean {
  const skill = getSkill(root, id);
  if (!skill) return false;
  const allowedDirs = skillDirectories(root).map(d => path.resolve(d.path));
  const target = path.resolve(skill.path);
  // Only ever delete inside a known skills directory, never a nested path.
  if (!allowedDirs.some(dir => path.dirname(target) === dir)) return false;
  removeTree(target);
  if (fs.existsSync(target)) return false;
  const state = readState(root);
  delete state.enabled[id];
  writeState(root, state);
  return true;
}

// ---------------------------------------------------------------------------
// Built-in starter skills (no network needed, useful for a first install)
// ---------------------------------------------------------------------------

const BUILTINS: Record<string, string> = {
  'code-review': `---
name: Code Review
description: Review a diff or module for correctness, security and regressions before shipping.
version: 1.0.0
allowedTools: read, grep, glob, list
toolDefaults:
  read.limit: 800
---

You are reviewing code, not rewriting it.

## Checklist
1. Correctness: off-by-one, null/undefined, async races, error swallowing.
2. Security: unvalidated input, path traversal, secret leakage, injection.
3. Compatibility: breaking API or schema changes, migrations, mobile/web parity.
4. Tests: what is not covered by an existing test.

## Output
- One line per finding: \`severity | file:line | problem | fix\`.
- Severity is one of: blocker, major, minor, nit.
- End with the single highest-value change to make next.
- Never claim a file or line exists unless you read it.
`,
  'test-first': `---
name: Test First
description: Add or repair tests before changing production code.
version: 1.0.0
allowedTools: read, grep, glob, edit, write, bash
toolDefaults:
  bash.timeoutMs: 300000
---

Work test-first on every behaviour change.

## Loop
1. Find the existing test runner and conventions (\`package.json\`, \`pytest.ini\`, \`*_test.go\`).
2. Write the smallest failing test that expresses the requested behaviour.
3. Run only that test file, confirm it fails for the expected reason.
4. Implement the change.
5. Re-run the focused test, then the full suite when it is fast enough.

## Rules
- Mirror the existing assertion style; do not introduce a new test framework.
- Prefer real objects over mocks unless the dependency is a network or clock.
- Report the exact command you ran and its pass/fail counts.
`,
};

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

function copySkillDir(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) copySkillDir(source, target);
    else if (entry.isFile()) fs.copyFileSync(source, target);
  }
}

/**
 * Delete a directory tree. `fs.rmSync` is intercepted by some Windows
 * environments (recycle-bin shims) and throws; fall back to a manual walk so
 * uninstalling a skill never leaves the UI stuck on a 500.
 */
function removeTree(target: string): void {
  if (!fs.existsSync(target)) return;
  try {
    fs.rmSync(target, { recursive: true, force: true });
    if (!fs.existsSync(target)) return;
  } catch { /* fall through to the manual walk */ }

  const walk = (dir: string): void => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else { try { fs.unlinkSync(full); } catch { /* locked */ } }
    }
    try { fs.rmdirSync(dir); } catch { /* locked */ }
  };
  walk(target);
}

/** Find SKILL.md files: at the root, or one/two levels down (repo of skills). */
function discoverSkills(dir: string): Array<{ dir: string; file: string }> {
  const found: Array<{ dir: string; file: string }> = [];
  const rootFile = path.join(dir, SKILL_FILE);
  if (fs.existsSync(rootFile)) return [{ dir, file: rootFile }];

  const walk = (current: string, depth: number): void => {
    if (depth > 2) return;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === '.git' || entry.name === 'node_modules') continue;
      const full = path.join(current, entry.name);
      const file = path.join(full, SKILL_FILE);
      if (fs.existsSync(file)) found.push({ dir: full, file });
      else walk(full, depth + 1);
    }
  };
  walk(dir, 0);
  return found;
}

function resolveGitUrl(source: string): string | null {
  if (/^git@/.test(source) || /\.git$/.test(source)) return source;
  if (/^https?:\/\//.test(source)) return source;
  // github shorthand: owner/repo
  if (/^[\w.-]+\/[\w.-]+$/.test(source)) return `https://github.com/${source}.git`;
  return null;
}

export async function installSkill(
  root: string,
  input: { source: string; scope?: SkillScope; force?: boolean },
): Promise<InstallSkillResult> {
  const log: string[] = [];
  const scope: SkillScope = input.scope === 'user' ? 'user' : 'workspace';
  const targetRoot = skillDirectories(root).find(d => d.scope === scope)!.path;
  fs.mkdirSync(targetRoot, { recursive: true });

  const source = input.source.trim();
  let staging: string | null = null;
  let cleanup: (() => void) | null = null;

  const builtin = source.replace(/^builtin:/, '');
  if (source.startsWith('builtin:') || BUILTINS[source]) {
    const content = BUILTINS[builtin];
    if (!content) throw new Error(`Unknown built-in skill: ${builtin}. Available: ${Object.keys(BUILTINS).join(', ')}`);
    const parsed = parseSkillFile(content);
    const slug = slugify(parsed.name || builtin);
    staging = fs.mkdtempSync(path.join(os.tmpdir(), 'codingagent-skill-'));
    fs.mkdirSync(path.join(staging, slug), { recursive: true });
    fs.writeFileSync(path.join(staging, slug, SKILL_FILE), content, 'utf8');
    log.push(`Prepared built-in skill "${parsed.name || builtin}".`);
  } else if (fs.existsSync(source) || fs.existsSync(path.resolve(source))) {
    const local = fs.existsSync(source) ? source : path.resolve(source);
    log.push(`Reading local skill source ${local}`);
    if (fs.statSync(local).isFile()) {
      if (path.basename(local).toLowerCase() !== SKILL_FILE.toLowerCase()) {
        throw new Error('A local skill file must be named SKILL.md.');
      }
      const content = fs.readFileSync(local, 'utf8');
      const parsed = parseSkillFile(content);
      const slug = slugify(parsed.name || path.basename(path.dirname(local)));
      staging = fs.mkdtempSync(path.join(os.tmpdir(), 'codingagent-skill-'));
      fs.mkdirSync(path.join(staging, slug), { recursive: true });
      fs.writeFileSync(path.join(staging, slug, SKILL_FILE), content, 'utf8');
    } else {
      staging = fs.mkdtempSync(path.join(os.tmpdir(), 'codingagent-skill-'));
      copySkillDir(local, path.join(staging, 'src'));
      log.push(`Copied ${local}`);
    }
  } else {
    const url = resolveGitUrl(source);
    if (!url) throw new Error(`Cannot resolve "${source}" — pass a git URL, owner/repo, builtin:<name>, or an existing folder.`);
    staging = fs.mkdtempSync(path.join(os.tmpdir(), 'codingagent-skill-'));
    const checkout = path.join(staging, 'repo');
    log.push(`$ git clone --depth 1 ${url}`);
    const result = await execa('git', ['clone', '--depth', '1', url, checkout], {
      reject: false, timeout: 180_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
    if (output) log.push(...output.split(/\r?\n/).slice(-12));
    if (result.exitCode !== 0) throw new Error(`git clone failed (exit ${result.exitCode}). Is git installed and the URL reachable?`);
    copySkillDir(checkout, path.join(staging, 'src'));
    cleanup = () => removeTree(checkout);
  }

  const stagingRoot = staging!;
  const searchRoot = fs.existsSync(path.join(stagingRoot, 'src')) ? path.join(stagingRoot, 'src') : stagingRoot;
  const discovered = discoverSkills(searchRoot);
  if (!discovered.length) {
    removeTree(stagingRoot);
    throw new Error('No SKILL.md found in that source (looked at the root and two levels down).');
  }

  const installed: SkillInfo[] = [];
  for (const found of discovered) {
    const content = fs.readFileSync(found.file, 'utf8');
    const parsed = parseSkillFile(content);
    const slug = slugify(parsed.name || path.basename(found.dir) || 'skill');
    const destination = path.join(targetRoot, slug);
    if (fs.existsSync(destination) && !input.force) {
      log.push(`Skipped "${slug}" — already installed (use force to overwrite).`);
      continue;
    }
    removeTree(destination);
    copySkillDir(found.dir, destination);
    fs.writeFileSync(
      path.join(destination, META_FILE),
      JSON.stringify({ source: source.startsWith('builtin:') ? source : source, installedAt: new Date().toISOString() }, null, 2),
      'utf8',
    );
    log.push(`Installed "${parsed.name || slug}" -> ${destination}`);
    const skill = loadSkill(destination, scope, readState(root).enabled);
    if (skill) installed.push(skill);
  }

  cleanup?.();
  removeTree(stagingRoot);

  return { installed, log, skills: listSkills(root) };
}

// ---------------------------------------------------------------------------
// Injection into the agent
// ---------------------------------------------------------------------------

export function activeSkills(root: string): SkillInfo[] {
  return listSkills(root).filter(skill => skill.enabled);
}

export function mergeToolDefaults(skills: SkillInfo[]): Record<string, Record<string, unknown>> {
  const merged: Record<string, Record<string, unknown>> = {};
  for (const skill of skills) {
    for (const [tool, params] of Object.entries(skill.toolDefaults ?? {})) {
      merged[tool] = { ...(merged[tool] ?? {}), ...params };
    }
  }
  return merged;
}

/**
 * Union of the tools that skills allow. Empty means "no restriction", so a
 * single opinionated skill can narrow the toolset without a second skill
 * accidentally opening it back up.
 */
export function allowedToolsFor(skills: SkillInfo[]): string[] {
  const declared = skills.filter(skill => skill.allowedTools.length > 0);
  if (!declared.length) return [];
  const union = new Set<string>();
  for (const skill of declared) for (const tool of skill.allowedTools) union.add(tool);
  return [...union];
}

export function buildSkillPrompt(skills: SkillInfo[]): string {
  const active = skills.filter(skill => skill.enabled);
  if (!active.length) return '';
  const sections = active.map(skill => {
    const header = `### ${skill.name}${skill.version ? ` (v${skill.version})` : ''}`;
    const meta = [
      skill.description ? `_${skill.description}_` : '',
      skill.allowedTools.length ? `Allowed tools: ${skill.allowedTools.join(', ')}` : '',
      Object.keys(skill.toolDefaults).length
        ? `Tool defaults: ${Object.entries(skill.toolDefaults).map(([tool, params]) => `${tool}(${Object.entries(params).map(([k, v]) => `${k}=${v}`).join(', ')})`).join('; ')}`
        : '',
    ].filter(Boolean).join('\n');
    return [header, meta, skill.instructions].filter(Boolean).join('\n\n');
  });

  return [
    '',
    '## Installed Agent Skills (active)',
    'These skills were installed by the user for this workspace. Their instructions are part of your standing guidance: follow them unless the current request explicitly overrides them.',
    '',
    sections.join('\n\n---\n\n'),
  ].join('\n');
}
