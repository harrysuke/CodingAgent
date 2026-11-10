import type { AgentEvent } from '@codingagent/shared';
import type { PermissionRequest } from '@codingagent/shared';

type Listener = (event: AgentEvent) => void;

interface PendingPermission {
  resolve: (status: PermissionRequest['status']) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const listeners = new Map<string, Set<Listener>>();
const pending = new Map<string, PendingPermission>();
/** Replay buffer so a UI that reconnects mid-turn can catch up. */
const recent = new Map<string, AgentEvent[]>();

export function subscribe(sessionId: string, listener: Listener): () => void {
  let set = listeners.get(sessionId);
  if (!set) { set = new Set(); listeners.set(sessionId, set); }
  set.add(listener);
  return () => { set!.delete(listener); if (set!.size === 0) listeners.delete(sessionId); };
}

export function recentEvents(sessionId: string): AgentEvent[] {
  return [...(recent.get(sessionId) ?? [])];
}

export function emit(sessionId: string, event: AgentEvent): void {
  const buffer = recent.get(sessionId) ?? [];
  buffer.push(event);
  if (buffer.length > 500) buffer.shift();
  recent.set(sessionId, buffer);
  for (const listener of listeners.get(sessionId) ?? []) {
    try { listener(event); } catch { /* a disconnected client must not break the loop */ }
  }
}

export function waitForPermission(id: string, timeoutMs = 300_000, signal?: AbortSignal): Promise<PermissionRequest['status']> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Permission request timed out (no response from the UI).'));
    }, timeoutMs);
    timer.unref?.();
    pending.set(id, { resolve, reject, timer });
    signal?.addEventListener('abort', () => {
      const p = pending.get(id);
      if (p) { clearTimeout(p.timer); pending.delete(id); p.reject(new Error('Run aborted')); }
    }, { once: true });
  });
}

export function settlePermission(id: string, status: PermissionRequest['status']): boolean {
  const entry = pending.get(id);
  if (!entry) return false;
  clearTimeout(entry.timer);
  pending.delete(id);
  entry.resolve(status);
  return true;
}

export function clearSession(sessionId: string): void {
  recent.delete(sessionId);
  for (const [id] of pending) {
    // permission ids are random; unresolved ones belonging to this run are
    // aborted by the AbortController instead, so nothing to clean here.
  }
}

export function abortAllPermissions(reason: string): void {
  for (const [id, entry] of pending) {
    clearTimeout(entry.timer);
    pending.delete(id);
    entry.reject(new Error(reason));
  }
}
