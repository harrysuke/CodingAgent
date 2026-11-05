import { reactive } from 'vue';
import type { AgentEvent, HealthResponse, TerminalChunk } from '@codingagent/shared';

const LS_URL = 'codingagent.serverUrl';
const LS_TOKEN = 'codingagent.token';

export const DEFAULT_TOKEN = 'change-me-local-dev-token';

export const connection = reactive({
  /** Empty string = same origin (Vite proxy in dev, Node-served UI on desktop web build). */
  url: localStorage.getItem(LS_URL) ?? '',
  token: localStorage.getItem(LS_TOKEN) ?? DEFAULT_TOKEN,
  mode: 'browser' as 'browser' | 'tauri' | 'mobile',
  connected: false,
  health: null as HealthResponse | null,
  error: '' as string,
});

export function setConnection(url: string, token: string): void {
  connection.url = url.replace(/\/+$/, '');
  connection.token = token;
  localStorage.setItem(LS_URL, connection.url);
  localStorage.setItem(LS_TOKEN, connection.token);
}

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * On the Tauri desktop shell the Rust side starts the Node sidecar and hands
 * us its loopback URL + token. Mobile has no sidecar, so it keeps whatever
 * LAN/remote server the user configured in Settings > Connection.
 */
export async function initConnection(): Promise<void> {
  connection.mode = isTauri() ? (/Android|iPhone|iPad/i.test(navigator.userAgent) ? 'mobile' : 'tauri') : 'browser';
  if (!isTauri()) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const cfg = await invoke<{ url?: string; token?: string } | null>('get_server_config');
    if (cfg?.url) {
      connection.url = String(cfg.url).replace(/\/+$/, '');
      connection.token = cfg.token || connection.token;
      localStorage.setItem(LS_URL, connection.url);
      localStorage.setItem(LS_TOKEN, connection.token);
    }
  } catch (err) {
    console.warn('[connection] Tauri server config unavailable, using saved settings:', err);
  }
}

function base(): string { return connection.url; }

export async function apiFetch<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${connection.token}`);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  let res: Response;
  try {
    res = await fetch(`${base()}${path}`, { ...init, headers });
  } catch (err) {
    connection.connected = false;
    connection.error = `Cannot reach the agent server${base() ? ` at ${base()}` : ''}. Is it running? (${(err as Error).message})`;
    throw new Error(connection.error);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    const message = body.error || `${res.status} ${res.statusText}`;
    if (res.status === 401) connection.error = 'Unauthorized - check the token in Settings > Connection.';
    throw new Error(message);
  }
  connection.connected = true;
  connection.error = '';
  return res.json() as Promise<T>;
}

export async function checkHealth(): Promise<HealthResponse | null> {
  try {
    const health = await apiFetch<HealthResponse>('/api/health');
    connection.health = health;
    connection.connected = true;
    connection.error = '';
    return health;
  } catch (err) {
    connection.connected = false;
    connection.error = (err as Error).message;
    return null;
  }
}

/** fetch-based SSE so we can send the Authorization header (EventSource cannot). */
async function streamFrames(
  url: string,
  onFrame: (eventName: string, data: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${connection.token}`, Accept: 'text/event-stream' },
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`Event stream failed: ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      let eventName = 'message';
      const dataLines: string[] = [];
      for (const line of frame.split(/\r?\n/)) {
        if (line.startsWith('event:')) eventName = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
      }
      if (eventName === 'ping' || eventName === 'ready' || !dataLines.length) continue;
      onFrame(eventName, dataLines.join('\n'));
    }
  }
}

export async function streamEvents(
  sessionId: string,
  onEvent: (event: AgentEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const url = `${base()}/api/sessions/${encodeURIComponent(sessionId)}/events?token=${encodeURIComponent(connection.token)}`;
  await streamFrames(url, (_name, data) => {
    try { onEvent(JSON.parse(data) as AgentEvent); } catch { /* ignore malformed frame */ }
  }, signal);
}

/** Live shell output for the terminal panel. */
export async function streamTerminal(
  terminalId: string,
  onChunk: (chunk: TerminalChunk) => void,
  signal: AbortSignal,
): Promise<void> {
  const url = `${base()}/api/terminal/${encodeURIComponent(terminalId)}/events?token=${encodeURIComponent(connection.token)}`;
  await streamFrames(url, (_name, data) => {
    try { onChunk(JSON.parse(data) as TerminalChunk); } catch { /* ignore malformed frame */ }
  }, signal);
}
