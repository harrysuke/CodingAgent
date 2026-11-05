import { execa } from 'execa';
import type { PermissionMode } from '@codingagent/shared';

export interface ShellResult { stdout: string; stderr: string; exitCode: number; durationMs: number; truncated: boolean }

/** Commands that are never allowed, even with permissionMode=allow. */
const HARD_BLOCKLIST = [
  /\brm\s+(-[a-z]*\s+)*(-rf|-fr|--recursive)\s+[\/\\~$]/i,
  /\bformat\s+[a-z]:/i,
  /\b(del|rd)\s+\/[sq]\s+[c-z]:/i,
  /\bshutdown\b|\breboot\b/i,
  /\bcurl\b[^\n]*\|\s*(ba)?sh\b/i,
  /\bchmod\s+-R\s+777\s+\//,
  />\s*\/dev\/sd[a-z]/i,
  /\bmkfs\b/i,
];

const MAX_OUTPUT = 40_000;

export function isHardBlocked(command: string): string | null {
  for (const pattern of HARD_BLOCKLIST) {
    if (pattern.test(command)) return `Blocked destructive command pattern: ${pattern}`;
  }
  return null;
}

export async function runShell(
  root: string,
  command: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ShellResult> {
  const blocked = isHardBlocked(command);
  if (blocked) throw new Error(blocked);
  const started = Date.now();
  const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/bash';
  const shellFlag = process.platform === 'win32' ? '/d /s /c' : '-c';
  try {
    const result = await execa(shell, [...shellFlag.split(' '), command], {
      cwd: root,
      timeout: options.timeoutMs ?? 120_000,
      maxBuffer: 8 * 1024 * 1024,
      reject: false,
      stripFinalNewline: false,
      cancelSignal: options.signal,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', CI: '1' },
    });
    let stdout = result.stdout ?? '';
    let stderr = result.stderr ?? '';
    let truncated = false;
    if (stdout.length > MAX_OUTPUT) { stdout = stdout.slice(-MAX_OUTPUT); truncated = true; }
    if (stderr.length > 8_000) { stderr = stderr.slice(-8_000); truncated = true; }
    return {
      stdout, stderr,
      exitCode: result.exitCode ?? ((result as { killed?: boolean }).killed ? 124 : 1),
      durationMs: Date.now() - started,
      truncated,
    };
  } catch (err) {
    return { stdout: '', stderr: (err as Error).message, exitCode: 1, durationMs: Date.now() - started, truncated: false };
  }
}

export function needsPermission(toolName: string, mode: PermissionMode): boolean {
  if (mode === 'allow') return false;
  if (mode === 'deny') return true;
  return ['bash', 'write', 'edit'].includes(toolName);
}
