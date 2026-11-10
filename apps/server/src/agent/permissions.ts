import type { AgentMode, PermissionMode, PermissionRequest } from '@codingagent/shared';
import { createPermission, getSettings, hasGrant, resolvePermission } from '../db/repo';
import { isHardBlocked, needsPermission } from '../workspace/shell';
import { emit, settlePermission, waitForPermission } from './bus';

const MUTATING = new Set(['bash', 'write', 'edit']);

export interface PermissionContext {
  sessionId: string;
  userId: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
  signal: AbortSignal;
}

export interface PermissionOutcome {
  allowed: boolean;
  reason?: string;
  permissionId?: string;
}

/**
 * Gate mutating tools behind the UI. Modes:
 *   allow -> never ask (except hard-blocked shell commands)
 *   ask   -> ask once per tool, or auto-allow after "Always allow"
 *   deny  -> never allow write/edit/bash (read-only agent)
 *
 * In `plan` mode every mutating tool is refused by design, like OpenCode's
 * plan agent, regardless of the permission setting.
 */
export async function checkPermission(
  ctx: PermissionContext,
  mode: PermissionMode,
  agent: AgentMode,
): Promise<PermissionOutcome> {
  if (ctx.toolName === 'bash') {
    const command = String((ctx.input as { command?: string })?.command ?? '');
    const blocked = isHardBlocked(command);
    if (blocked) return { allowed: false, reason: blocked };
  }

  if (!MUTATING.has(ctx.toolName)) return { allowed: true };

  if (agent === 'plan') {
    return { allowed: false, reason: 'Plan mode is read-only. Switch the session to Build to apply changes.' };
  }
  if (mode === 'deny') {
    return { allowed: false, reason: `Permission policy denies "${ctx.toolName}". Change it in Settings.` };
  }
  if (mode === 'allow') return { allowed: true };
  if (hasGrant(ctx.sessionId, ctx.toolName)) return { allowed: true };

  const permission = createPermission(ctx.sessionId, ctx.toolCallId, ctx.toolName, ctx.input, ctx.userId);
  emit(ctx.sessionId, { type: 'permission', permission });

  try {
    const status = await waitForPermission(permission.id, 300_000, ctx.signal);
    const allowed = status === 'approved' || status === 'approved_always';
    return { allowed, reason: allowed ? undefined : 'Denied by user.', permissionId: permission.id };
  } catch (err) {
    return { allowed: false, reason: (err as Error).message, permissionId: permission.id };
  }
}

export function settle(id: string, status: PermissionRequest['status'], userId?: string): PermissionRequest | null {
  const updated = resolvePermission(id, status, userId);
  if (updated) {
    settlePermission(id, status);
    emit(updated.sessionId, { type: 'permission-resolved', permissionId: id, status });
  }
  return updated;
}
