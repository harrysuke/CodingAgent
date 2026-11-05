import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import type { TerminalChunk, TerminalState } from '@codingagent/shared';

const MAX_BUFFER_CHUNKS = 4000;
const MAX_BUFFER_CHARS = 600_000;
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_TERMINALS = 4;

type Listener = (chunk: TerminalChunk) => void;

interface Session {
  id: string;
  cwd: string;
  shell: string;
  child: ChildProcessWithoutNullStreams | null;
  buffer: TerminalChunk[];
  bufferChars: number;
  listeners: Set<Listener>;
  createdAt: string;
  lastUsedAt: number;
}

const sessions = new Map<string, Session>();
let sweepTimer: NodeJS.Timeout | null = null;

function shellFor(): { command: string; args: string[]; label: string } {
  if (process.platform === 'win32') {
    return { command: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-Command', '-'], label: 'powershell' };
  }
  return { command: '/bin/bash', args: ['--noprofile', '--norc', '-s'], label: 'bash' };
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

function spawnShell(session: Session): void {
  const shell = shellFor();
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

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (data: string) => pushChunk(session, 'stdout', data));
  child.stderr.on('data', (data: string) => pushChunk(session, 'stderr', data));
  child.on('error', (err) => pushChunk(session, 'system', `\n[shell error] ${err.message}\n`));
  child.on('exit', (code, signal) => {
    // A restart replaces session.child first; ignore the old child's exit so it
    // cannot null out the freshly spawned shell.
    if (session.child !== child) return;
    pushChunk(session, 'system', `\n[shell exited: ${signal ?? code ?? 'unknown'}]\n`);
    session.child = null;
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

export function createTerminal(root: string): TerminalState {
  ensureSweeper();
  const live = [...sessions.values()].filter(s => s.child);
  if (live.length >= MAX_TERMINALS) {
    // Drop the least recently used shell rather than leaking processes.
    live.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    disposeTerminal(live[0].id);
  }

  const cwd = fs.existsSync(root) ? root : process.cwd();
  const id = randomUUID();
  const session: Session = {
    id, cwd, shell: shellFor().label, child: null, buffer: [], bufferChars: 0,
    listeners: new Set(), createdAt: new Date().toISOString(), lastUsedAt: Date.now(),
  };
  sessions.set(id, session);
  spawnShell(session);
  pushChunk(session, 'system', `CodingAgent terminal · ${session.shell} · ${cwd}\n`);
  return toState(session);
}

function toState(session: Session): TerminalState {
  return {
    id: session.id,
    cwd: session.cwd,
    shell: session.shell,
    running: !!session.child,
    createdAt: session.createdAt,
  };
}

export function getTerminal(id: string): TerminalState | null {
  const session = sessions.get(id);
  return session ? toState(session) : null;
}

export function listTerminals(): TerminalState[] {
  return [...sessions.values()].map(toState);
}

export function subscribeTerminal(id: string, listener: Listener): (() => void) | null {
  const session = sessions.get(id);
  if (!session) return null;
  session.listeners.add(listener);
  session.lastUsedAt = Date.now();
  return () => { session.listeners.delete(listener); };
}

export function terminalBacklog(id: string): TerminalChunk[] {
  return [...(sessions.get(id)?.buffer ?? [])];
}

/**
 * Send a line of input to the shell. The command is echoed back as an `input`
 * chunk so the UI shows exactly what ran even though the shell is prompt-less.
 */
export function writeTerminal(id: string, data: string): boolean {
  const session = sessions.get(id);
  if (!session) return false;
  session.lastUsedAt = Date.now();
  const payload = data.endsWith('\n') ? data : `${data}\n`;
  pushChunk(session, 'input', payload);

  if (!session.child) {
    // Shell died (crash / previous kill): bring it back transparently.
    spawnShell(session);
    pushChunk(session, 'system', '[shell restarted]\n');
  }
  try {
    session.child?.stdin.write(payload);
    return true;
  } catch (err) {
    pushChunk(session, 'system', `[write failed] ${(err as Error).message}\n`);
    return false;
  }
}

/** Ctrl-C: kill the whole process tree, then start a fresh shell in the same cwd. */
export function interruptTerminal(id: string): boolean {
  const session = sessions.get(id);
  if (!session) return false;
  session.lastUsedAt = Date.now();
  killTree(session.child);
  session.child = null;
  spawnShell(session);
  pushChunk(session, 'system', '\n^C  (command tree killed, fresh shell started)\n');
  return true;
}

export function clearTerminalBuffer(id: string): boolean {
  const session = sessions.get(id);
  if (!session) return false;
  session.buffer = [];
  session.bufferChars = 0;
  pushChunk(session, 'system', '\n[cleared]\n');
  return true;
}

export function disposeTerminal(id: string): boolean {
  const session = sessions.get(id);
  if (!session) return false;
  killTree(session.child);
  session.child = null;
  session.listeners.clear();
  sessions.delete(id);
  return true;
}

export function disposeAllTerminals(): void {
  for (const id of [...sessions.keys()]) disposeTerminal(id);
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
}
