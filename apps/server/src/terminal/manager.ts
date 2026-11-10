import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { IPty } from 'node-pty';
import type { TerminalChunk, TerminalShellInfo, TerminalShellsResponse, TerminalState } from '@codingagent/shared';

const MAX_BUFFER_CHUNKS = 8000;
const MAX_BUFFER_CHARS = 1_200_000;
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_TERMINALS = 6;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const MIN_COLS = 20, MAX_COLS = 400, MIN_ROWS = 4, MAX_ROWS = 200;

type Listener = (chunk: TerminalChunk) => void;
type PtyModule = typeof import('node-pty');

interface ShellDefinition {
  id: string;
  label: string;
  command: string;
  /** Args for a real interactive PTY. Pipe fallback uses its own arguments. */
  args: string[];
}

interface Session {
  id: string;
  /** Account that created this shell; other accounts get 404 from the API. */
  ownerId: string;
  cwd: string;
  shell: string;
  shellId: string;
  cols: number;
  rows: number;
  /** True when a real pseudoterminal is attached; false = degraded pipe mode. */
  pty: boolean;
  proc: IPty | null;
  child: ChildProcessWithoutNullStreams | null;
  running: boolean;
  buffer: TerminalChunk[];
  bufferChars: number;
  listeners: Set<Listener>;
  createdAt: string;
  lastUsedAt: number;
}

const sessions = new Map<string, Session>();
let sweepTimer: NodeJS.Timeout | null = null;

/** node-pty is CommonJS, so this reaches the very same builtin object it uses. */
const requireCjs = createRequire(import.meta.url);
type ForkFn = (
  modulePath: string,
  args?: readonly string[],
  options?: Record<string, unknown>,
) => ChildProcess;

/**
 * On Windows, node-pty 1.1.0's kill() forks `conpty_console_list_agent` to
 * enumerate processes attached to the console. With ConPTY that helper cannot
 * AttachConsole(), so it crashes and dumps an uncaught-exception stack trace
 * onto the server's stderr on every tab close / restart. Its built-in timeout
 * fallback still kills the shell correctly, so we only make that one short-lived
 * helper silent. The patch wraps a single synchronous kill() call and is
 * restored immediately afterwards; bypassing kill() is NOT an option because
 * it also disposes the ConPTY output worker (otherwise Node keeps live handles).
 */
function killPty(proc: IPty): void {
  if (process.platform !== 'win32') {
    try { proc.kill(); } catch { /* already exited */ }
    return;
  }
  const cp = requireCjs('child_process') as { fork: ForkFn };
  const original = cp.fork;
  cp.fork = ((modulePath: string, args?: readonly string[], options?: Record<string, unknown>) => {
    const child = original.call(cp, modulePath, args, { ...(options ?? {}), silent: true });
    // Drain the pipes: a failed helper must not block or keep the server alive.
    child.stdout?.resume();
    child.stderr?.resume();
    return child;
  }) as ForkFn;
  try { proc.kill(); } catch { /* already exited */ } finally { cp.fork = original; }
}

/**
 * node-pty is a native addon. Loading it lazily means a host without the
 * prebuild (or with an incompatible Node ABI) still gets a usable, if line
 * oriented, terminal instead of the whole server failing to boot.
 */
let ptyModule: PtyModule | null = null;
let ptyLoad: Promise<PtyModule | null> | null = null;
function loadPty(): Promise<PtyModule | null> {
  ptyLoad ??= import('node-pty')
    .then((mod) => { ptyModule = mod as PtyModule; return ptyModule; })
    .catch((err: unknown) => {
      console.warn('[terminal] node-pty unavailable, using piped fallback:', (err as Error).message);
      return null;
    });
  return ptyLoad;
}

/** Synchronous view for restarts, which must not turn async mid-keystroke. */
function cachedPty(): PtyModule | null {
  return ptyModule;
}

/** Advertised in /api/health so a stale/limited server is visible to the UI. */
export async function ptyAvailable(): Promise<boolean> {
  return (await loadPty()) !== null;
}

function clamp(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function shellDefinitions(): ShellDefinition[] {
  if (process.platform === 'win32') {
    return [
      { id: 'powershell', label: 'PowerShell', command: 'powershell.exe', args: ['-NoLogo', '-NoProfile'] },
      { id: 'cmd', label: 'Command Prompt', command: 'cmd.exe', args: [] },
      { id: 'pwsh', label: 'PowerShell 7', command: 'pwsh.exe', args: ['-NoLogo', '-NoProfile'] },
      { id: 'bash', label: 'Git Bash', command: 'bash.exe', args: ['--noprofile', '--norc', '-i'] },
    ];
  }
  return [
    { id: 'bash', label: 'Bash', command: '/bin/bash', args: ['-i'] },
    { id: 'zsh', label: 'Zsh', command: '/bin/zsh', args: ['-i'] },
    { id: 'sh', label: 'sh', command: '/bin/sh', args: [] },
  ];
}

/** Resolve a bare Windows executable against PATH without spawning anything. */
function commandExists(command: string): boolean {
  if (path.isAbsolute(command) || /^[A-Za-z]:[\\/]/.test(command)) return fs.existsSync(command);
  const separator = process.platform === 'win32' ? ';' : ':';
  const extensions = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  for (const dir of (process.env.PATH ?? '').split(separator)) {
    if (!dir) continue;
    for (const ext of extensions) {
      if (fs.existsSync(path.join(dir, `${command}${ext}`))) return true;
    }
  }
  return false;
}

export function terminalShells(): TerminalShellsResponse {
  const definitions = shellDefinitions();
  const shells: TerminalShellInfo[] = definitions.map(def => ({
    id: def.id, label: def.label, command: def.command, available: commandExists(def.command),
  }));
  const usable = shells.find(s => s.available);
  return {
    shells,
    defaultShell: usable?.id ?? definitions[0].id,
    // Avoid a slow async load on every UI open: the cached module is set as
    // soon as the first terminal was created.
    pty: ptyModule !== null,
  };
}

function chooseShell(requested?: string): ShellDefinition {
  const definitions = shellDefinitions();
  const match = requested && definitions.find(def => def.id === requested && commandExists(def.command));
  if (match) return match;
  return definitions.find(def => commandExists(def.command)) ?? definitions[0];
}

/** Arguments for the degraded, pipe-backed shell (no TTY, no interactive apps). */
function pipeShellFor(): { command: string; args: string[] } {
  if (process.platform === 'win32') {
    return { command: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-Command', '-'] };
  }
  return { command: '/bin/bash', args: ['--noprofile', '--norc', '-s'] };
}

function quoteForShell(value: string): string {
  return process.platform === 'win32' ? `'${value.replace(/'/g, "''")}'` : `'${value.replace(/'/g, `'\\''`)}'`;
}

function pushChunk(session: Session, stream: TerminalChunk['stream'], data: string): void {
  if (!data) return;
  const chunk: TerminalChunk = {
    terminalId: session.id, stream, data, at: new Date().toISOString(),
  };
  session.buffer.push(chunk);
  session.bufferChars += data.length;
  while (session.buffer.length > MAX_BUFFER_CHUNKS || session.bufferChars > MAX_BUFFER_CHARS) {
    const dropped = session.buffer.shift();
    if (!dropped) break;
    session.bufferChars -= dropped.data.length;
  }
  for (const listener of session.listeners) {
    try { listener(chunk); } catch { /* a closed SSE stream must not break the shell */ }
  }
}

function killTree(child: ChildProcessWithoutNullStreams | null): void {
  if (!child || child.killed) return;
  if (process.platform === 'win32' && child.pid) {
    // `npm`/`pnpm` spawn grandchildren that survive a plain kill on Windows.
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } catch { /* fall through to kill() */ }
  }
  try { child.kill(); } catch { /* already gone */ }
}

function ptyEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value;
  }
  // Color / full-screen programs must see a real terminal, not `dumb`.
  delete env.NO_COLOR;
  delete env.FORCE_COLOR;
  delete env.PS1;
  Object.assign(env, {
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'CodingAgent',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    PYTHONIOENCODING: 'utf-8',
  });
  return env;
}

function spawnPty(session: Session, pty: PtyModule, def: ShellDefinition): void {
  const proc = pty.spawn(def.command, def.args, {
    name: 'xterm-256color',
    cols: session.cols,
    rows: session.rows,
    cwd: session.cwd,
    env: ptyEnv(),
    useConpty: process.platform === 'win32',
  });
  session.proc = proc;
  session.child = null;
  session.pty = true;
  session.running = true;
  proc.onData((data: string) => pushChunk(session, 'stdout', data));
  proc.onExit(({ exitCode, signal }) => {
    // A restart replaces session.proc first; ignore the old process' exit so
    // it cannot mark the fresh shell as dead.
    if (session.proc !== proc) return;
    session.running = false;
    pushChunk(session, 'system', `\r\n\x1b[2m[process exited: ${signal ?? exitCode}]\x1b[0m\r\n`);
  });
}

/** Last-resort shell for hosts where the native PTY addon cannot load. */
function spawnPipeShell(session: Session): void {
  const shell = pipeShellFor();
  const child = spawn(shell.command, shell.args, {
    cwd: session.cwd,
    env: {
      ...process.env,
      TERM: 'dumb',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      // Keep the shell from printing a prompt we then have to strip.
      PS1: '',
      GIT_PAGER: 'cat',
      PAGER: 'cat',
      PYTHONIOENCODING: 'utf-8',
    },
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  session.child = child;
  session.proc = null;
  session.pty = false;
  session.running = true;

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (data: string) => pushChunk(session, 'stdout', data));
  child.stderr.on('data', (data: string) => pushChunk(session, 'stderr', data));
  child.on('error', (err) => pushChunk(session, 'system', `\n[shell error] ${err.message}\n`));
  child.on('exit', (code, signal) => {
    if (session.child !== child) return;
    pushChunk(session, 'system', `\n[shell exited: ${signal ?? code ?? 'unknown'}]\n`);
    session.child = null;
    session.running = false;
  });

  const init = process.platform === 'win32'
    ? [
      '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
      '$OutputEncoding=[System.Text.Encoding]::UTF8',
      'function prompt { "" }',
      `Set-Location -LiteralPath ${quoteForShell(session.cwd)}`,
    ].join('; ') + '\n'
    : `export PS1=''; export TERM=dumb; cd ${quoteForShell(session.cwd)}\n`;
  try { child.stdin.write(init); } catch { /* shell died immediately */ }
}

function startShell(session: Session, pty: PtyModule | null, def: ShellDefinition): void {
  if (pty) {
    try {
      spawnPty(session, pty, def);
      return;
    } catch (err) {
      console.warn('[terminal] PTY spawn failed, using piped fallback:', (err as Error).message);
    }
  }
  spawnPipeShell(session);
}

function stopShell(session: Session): void {
  if (session.proc) {
    killPty(session.proc);
    session.proc = null;
  }
  killTree(session.child);
  session.child = null;
  session.running = false;
}

function sweep(): void {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastUsedAt > IDLE_TIMEOUT_MS) disposeTerminal(id);
  }
}

function ensureSweeper(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(sweep, 60_000);
  sweepTimer.unref?.();
}

function owned(id: string, ownerId?: string): Session | null {
  const session = sessions.get(id);
  if (!session) return null;
  if (ownerId !== undefined && session.ownerId !== ownerId) return null;
  return session;
}

function toState(session: Session): TerminalState {
  return {
    id: session.id,
    cwd: session.cwd,
    shell: session.shell,
    running: session.running,
    createdAt: session.createdAt,
    pty: session.pty,
    cols: session.cols,
    rows: session.rows,
    shellId: session.shellId,
  };
}

export interface CreateTerminalOptions {
  cols?: number;
  rows?: number;
  shell?: string;
}

export async function createTerminal(
  root: string,
  ownerId: string,
  options: CreateTerminalOptions = {},
): Promise<TerminalState> {
  ensureSweeper();
  const live = [...sessions.values()].filter(s => s.running);
  if (live.length >= MAX_TERMINALS) {
    // Drop the least recently used shell rather than leaking processes.
    live.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    disposeTerminal(live[0].id);
  }

  const cwd = fs.existsSync(root) ? root : process.cwd();
  const def = chooseShell(options.shell);
  const pty = await loadPty();
  const session: Session = {
    id: randomUUID(), ownerId, cwd,
    shell: def.label, shellId: def.id,
    cols: clamp(options.cols, MIN_COLS, MAX_COLS, DEFAULT_COLS),
    rows: clamp(options.rows, MIN_ROWS, MAX_ROWS, DEFAULT_ROWS),
    pty: !!pty, proc: null, child: null, running: false,
    buffer: [], bufferChars: 0, listeners: new Set(),
    createdAt: new Date().toISOString(), lastUsedAt: Date.now(),
  };
  sessions.set(session.id, session);
  startShell(session, pty, def);
  pushChunk(session, 'system',
    `\x1b[2mCodingAgent terminal · ${session.shell} · ${session.pty ? 'PTY' : 'pipe (limited)'} · ${cwd}\x1b[0m\r\n`);
  return toState(session);
}

export function getTerminal(id: string, ownerId?: string): TerminalState | null {
  const session = owned(id, ownerId);
  return session ? toState(session) : null;
}

export function listTerminals(ownerId?: string): TerminalState[] {
  return [...sessions.values()].filter(s => ownerId === undefined || s.ownerId === ownerId).map(toState);
}

export function subscribeTerminal(id: string, listener: Listener, ownerId?: string): (() => void) | null {
  const session = owned(id, ownerId);
  if (!session) return null;
  session.listeners.add(listener);
  session.lastUsedAt = Date.now();
  return () => { session.listeners.delete(listener); };
}

export function terminalBacklog(id: string, ownerId?: string): TerminalChunk[] {
  return [...(owned(id, ownerId)?.buffer ?? [])];
}

/** Resize the PTY so full-screen programs (vim, htop, less) reflow correctly. */
export function resizeTerminal(id: string, cols: number, rows: number, ownerId?: string): boolean {
  const session = owned(id, ownerId);
  if (!session) return false;
  session.cols = clamp(cols, MIN_COLS, MAX_COLS, DEFAULT_COLS);
  session.rows = clamp(rows, MIN_ROWS, MAX_ROWS, DEFAULT_ROWS);
  session.lastUsedAt = Date.now();
  if (session.proc && session.running) {
    try { session.proc.resize(session.cols, session.rows); } catch { /* process just exited */ }
  }
  return true;
}

/**
 * Forward raw keystrokes. In PTY mode the terminal echoes them itself, so no
 * synthetic `input` chunk is added. In pipe mode escape sequences are stripped
 * (a non-TTY shell cannot interpret them) and the line is echoed instead.
 */
export function writeTerminal(id: string, data: string, ownerId?: string): boolean {
  const session = owned(id, ownerId);
  if (!session) return false;
  session.lastUsedAt = Date.now();
  if (!session.running) {
    // Shell died (crash / previous kill): bring it back transparently.
    const def = chooseShell(session.shellId);
    startShell(session, cachedPty(), def);
    pushChunk(session, 'system', '\x1b[2m[shell restarted]\x1b[0m\r\n');
  }
  if (session.proc) {
    try {
      session.proc.write(data);
      return true;
    } catch (err) {
      pushChunk(session, 'system', `\r\n[write failed] ${(err as Error).message}\r\n`);
      return false;
    }
  }
  const payload = data
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/\r/g, '\n');
  if (!payload) return true;
  pushChunk(session, 'input', payload);
  try {
    session.child?.stdin.write(payload.endsWith('\n') ? payload : `${payload}\n`);
    return true;
  } catch (err) {
    pushChunk(session, 'system', `\r\n[write failed] ${(err as Error).message}\r\n`);
    return false;
  }
}

/** Ctrl-C. A PTY delivers it as a real console interrupt; pipes must be killed. */
export function interruptTerminal(id: string, ownerId?: string): boolean {
  const session = owned(id, ownerId);
  if (!session) return false;
  session.lastUsedAt = Date.now();
  if (session.proc && session.running) {
    try { session.proc.write('\x03'); return true; } catch { /* fall through */ }
  }
  stopShell(session);
  startShell(session, cachedPty(), chooseShell(session.shellId));
  pushChunk(session, 'system', '\r\n\x1b[2m^C  (command tree killed, fresh shell started)\x1b[0m\r\n');
  return true;
}

/** Kill the shell and respawn it in the same folder with the same geometry. */
export function restartTerminal(id: string, ownerId?: string): TerminalState | null {
  const session = owned(id, ownerId);
  if (!session) return null;
  session.lastUsedAt = Date.now();
  stopShell(session);
  startShell(session, cachedPty(), chooseShell(session.shellId));
  pushChunk(session, 'system', '\r\n\x1b[2m[shell restarted]\x1b[0m\r\n');
  return toState(session);
}

/** Clear the replay buffer only; the Xterm.js viewport is cleared client-side. */
export function clearTerminalBuffer(id: string, ownerId?: string): boolean {
  const session = owned(id, ownerId);
  if (!session) return false;
  session.buffer = [];
  session.bufferChars = 0;
  session.lastUsedAt = Date.now();
  return true;
}

export function disposeTerminal(id: string, ownerId?: string): boolean {
  const session = owned(id, ownerId);
  if (!session) return false;
  stopShell(session);
  session.listeners.clear();
  sessions.delete(id);
  return true;
}

export function disposeAllTerminals(): void {
  for (const id of [...sessions.keys()]) disposeTerminal(id);
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
}
