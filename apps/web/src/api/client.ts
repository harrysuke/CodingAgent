import { reactive } from 'vue';
import type {
  AgentEvent, AuthResult, AuthStatus, AuthUser, HealthResponse, TerminalChunk,
} from '@codingagent/shared';

const LS_URL = 'codingagent.serverUrl';
/** Per-account session token. NOT the old shared AGENT_TOKEN. */
const LS_TOKEN = 'codingagent.token';
const LEGACY_TOKEN = 'change-me-local-dev-token';

export const connection = reactive({
  /** Empty string = same origin (Vite proxy in dev, Node-served UI on desktop web build). */
  url: localStorage.getItem(LS_URL) ?? '',
  token: localStorage.getItem(LS_TOKEN) ?? '',
  /**
   * Desktop-only hint: the Rust sidecar hands us its AGENT_TOKEN so the
   * first-run setup form can prefill the one-time setup secret. It is never
   * used as a bearer credential.
   */
  setupTokenHint: '',
  mode: 'browser' as 'browser' | 'tauri' | 'mobile',
  connected: false,
  health: null as HealthResponse | null,
  error: '' as string,
});

/** Reactive authentication state, shared by the router guard and the UI. */
export const auth = reactive({
  user: null as AuthUser | null,
  status: null as AuthStatus | null,
  checked: false,
  /**
   * Incremented on every successful sign-in/sign-up. The root layout watches
   * this synchronously to start account hydration before `auth.user` flips and
   * unmounts the login view. An emit() after an awaited signIn() can be lost.
   */
  loginEpoch: 0,
  /** The server has no /api/auth/* routes: it is an older build. */
  staleServer: false,
  error: '',
});

/** Old builds stored the shared secret here; it can never be a session token. */
if (connection.token === LEGACY_TOKEN) {
  connection.token = '';
  localStorage.removeItem(LS_TOKEN);
}

export function setServerUrl(url: string): void {
  connection.url = url.replace(/\/+$/, '');
  localStorage.setItem(LS_URL, connection.url);
}

export function setSessionToken(token: string): void {
  connection.token = token;
  localStorage.setItem(LS_TOKEN, token);
}

export function clearSessionToken(): void {
  connection.token = '';
  localStorage.removeItem(LS_TOKEN);
}

/** Kept for callers that still pass (url, token); the token argument is ignored. */
export function setConnection(url: string, _token = ''): void {
  setServerUrl(url);
}

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * On the Tauri desktop shell the Rust side starts the Node sidecar and hands
 * us its loopback URL + setup token. Mobile has no sidecar, so it keeps
 * whatever LAN/remote server the user configured in Settings > Connection.
 */
export async function initConnection(): Promise<void> {
  connection.mode = isTauri() ? (/Android|iPhone|iPad/i.test(navigator.userAgent) ? 'mobile' : 'tauri') : 'browser';
  if (!isTauri()) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const cfg = await invoke<{ url?: string; token?: string } | null>('get_server_config');
    if (cfg?.url) setServerUrl(String(cfg.url));
    if (cfg?.token) connection.setupTokenHint = String(cfg.token);
  } catch (err) {
    console.warn('[connection] Tauri server config unavailable, using saved settings:', err);
  }
}

function base(): string { return connection.url; }

function handleUnauthorized(path: string): void {
  // A wrong password on /api/auth/login is not an expired session.
  if (path.startsWith('/api/auth/login') || path.startsWith('/api/auth/register')) return;
  clearSessionToken();
  auth.user = null;
  auth.checked = true;
  connection.error = 'Your session has expired. Sign in again.';
}

export async function apiFetch<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (connection.token) headers.set('Authorization', `Bearer ${connection.token}`);
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
    if (res.status === 401) handleUnauthorized(path);
    throw new Error(message);
  }
  connection.connected = true;
  if (connection.error === 'Your session has expired. Sign in again.') connection.error = '';
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

// ---------------------------------------------------------------------------
// Accounts / login / BYOK
// ---------------------------------------------------------------------------

/** Public. A 404 means the running server predates accounts entirely. */
export async function loadAuthStatus(): Promise<AuthStatus | null> {
  try {
    const res = await fetch(`${base()}/api/auth/status`);
    if (res.status === 404) {
      auth.staleServer = true;
      auth.status = null;
      return null;
    }
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    auth.status = await res.json() as AuthStatus;
    auth.staleServer = false;
  } catch {
    auth.status = null;
  }
  return auth.status;
}

/** Restore a saved session on page load, or decide that login is required. */
export async function restoreSession(): Promise<void> {
  auth.checked = false;
  await loadAuthStatus();
  if (auth.staleServer) {
    auth.user = null;
    auth.checked = true;
    return;
  }
  if (!connection.token) {
    auth.user = null;
    auth.checked = true;
    return;
  }
  try {
    auth.user = await apiFetch<AuthUser | null>('/api/auth/me');
    if (!auth.user) clearSessionToken();
  } catch {
    auth.user = null;
    clearSessionToken();
  }
  auth.checked = true;
}

function applyAuthResult(result: AuthResult): void {
  setSessionToken(result.token);
  // Arm the hydration gate BEFORE auth.user becomes non-null. Otherwise Vue
  // unmounts AuthView in the same tick and its post-await emit('authenticated')
  // is never delivered, leaving the chat UI mounted with an empty model list.
  auth.loginEpoch++;
  auth.user = result.user;
  auth.checked = true;
  auth.error = '';
  connection.error = '';
  void loadAuthStatus();
}

export async function signIn(email: string, password: string): Promise<void> {
  applyAuthResult(await apiFetch<AuthResult>('/api/auth/login', {
    method: 'POST', body: JSON.stringify({ email, password }),
  }));
}

export async function signUp(input: {
  email: string; password: string; name?: string; setupToken?: string;
}): Promise<void> {
  applyAuthResult(await apiFetch<AuthResult>('/api/auth/register', {
    method: 'POST', body: JSON.stringify(input),
  }));
}

export async function signOut(): Promise<void> {
  try { await apiFetch('/api/auth/logout', { method: 'POST' }); } catch { /* offline is fine */ }
  clearSessionToken();
  auth.user = null;
  auth.checked = true;
  await loadAuthStatus();
}

/** Refresh keyCount after adding/removing a provider key. */
export async function refreshMe(): Promise<void> {
  if (!connection.token) return;
  try { auth.user = await apiFetch<AuthUser | null>('/api/auth/me'); }
  catch { /* a concurrent expiry is handled by apiFetch */ }
}

/** Changing a password invalidates every session, so the UI must re-login. */
export async function changePasswordRequest(current: string, next: string): Promise<void> {
  await apiFetch('/api/auth/password', {
    method: 'POST', body: JSON.stringify({ current, next }),
  });
  clearSessionToken();
  auth.user = null;
  auth.checked = true;
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
  if (res.status === 401) handleUnauthorized('/api/sse');
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
