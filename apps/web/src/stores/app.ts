import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import type {
  AgentEvent, ApiKeyInfo, AppSettings, BrowseResult, FileNode, HealthResponse, InstallSkillResult,
  Message, ModelInfo, Part, PermissionRequest, Project, ProviderInfo, Session, SkillInfo, SkillsResponse,
  TerminalChunk, TerminalShellInfo, TerminalShellsResponse, TerminalState, TodoItem, Usage,
  WorkspaceInfo, WorkspaceState,
} from '@codingagent/shared';
import { DEFAULT_SETTINGS } from '@codingagent/shared';
import {
  apiFetch, auth, checkHealth, clearSessionToken, connection, initConnection, refreshMe,
  restoreSession, setServerUrl, signOut as requestSignOut, streamEvents, streamTerminal,
} from '../api/client';

export interface FileChange {
  id: string; path: string; before: string | null; after: string; toolName: string; createdAt: string;
}

/** A file the user pinned to the next message, before the server reads it. */
export interface AttachmentDraft {
  key: string;
  path: string;
  name: string;
  external: boolean;
  /** Present only for device files the browser read itself. */
  content?: string;
  size?: number;
  kind?: string;
  tokens?: number;
  error?: string;
}

export interface TerminalLine {
  stream: TerminalChunk['stream'];
  data: string;
  at: string;
}

/** Metadata for one Xterm.js tab. The emulator viewport lives in TerminalView. */
export interface TerminalTab {
  id: string;
  title: string;
  cwd: string;
  shell: string;
  shellId: string;
  pty: boolean;
  cols: number;
  rows: number;
  running: boolean;
  createdAt: string;
}

/** A live view registers itself here to receive its PTY's raw output. */
export type TerminalSink = (chunk: TerminalChunk) => void;

/**
 * The folder picker is shared by the sidebar's "New session" button and the
 * composer's folder chip. `new-session` claims the chosen folder for a brand
 * new session; `current-session` rebinds only the session on screen.
 */
export type WorkspacePickerMode = 'new-session' | 'current-session';

export const useAppStore = defineStore('app', () => {
  const sessions = ref<Session[]>([]);
  const projects = ref<Project[]>([]);
  const currentId = ref<string | null>(null);
  const messages = ref<Message[]>([]);
  const models = ref<ModelInfo[]>([]);
  const providers = ref<ProviderInfo[]>([]);
  const keys = ref<ApiKeyInfo[]>([]);
  const settings = ref<AppSettings>({ ...DEFAULT_SETTINGS });
  const permissions = ref<PermissionRequest[]>([]);
  const todos = ref<TodoItem[]>([]);
  const fileChanges = ref<FileChange[]>([]);
  const fileTree = ref<FileNode[]>([]);
  const analytics = ref<{ requests: number; inputTokens: number; outputTokens: number; avgLatencyMs: number; errors: number; byPlatform: { platform: string; requests: number; tokens: number }[] } | null>(null);

  const running = ref(false);
  const usage = ref<Usage | null>(null);
  const error = ref('');
  const ready = ref(false);
  /**
   * True once every account-scoped collection (models, keys, sessions, …) has
   * been fetched. The chat UI must not mount before this, otherwise the model
   * picker renders an empty list on the first frame after signing in.
   */
  const hydrated = ref(false);
  const sidebarOpen = ref(true);
  const rightPanel = ref<'files' | 'changes' | 'todos' | null>('files');

  // --- workspace (sandboxed project home, one per session) ---------------
  const workspace = ref<WorkspaceState | null>(null);
  const workspaceBusy = ref(false);
  /** Set when the server answers 404 for /api/workspace: stale build, needs restart. */
  const workspaceStale = ref(false);
  /** Shared folder picker: both the sidebar and the composer open it. */
  const workspacePicker = ref<{ open: boolean; mode: WorkspacePickerMode }>({
    open: false, mode: 'current-session',
  });

  /**
   * Rebuilding dist/index.js does not update a Node process that is already
   * running. Such a stale server ignores `rootPath` / `sessionId` and answers
   * every workspace call with the account-wide pointer — which is how a new
   * session ended up writing into an older session's folder. Refuse folder
   * changes until the server advertises per-session workspace support.
   */
  const serverOutdated = ref(false);
  watch(
    () => connection.health,
    health => { serverOutdated.value = !!health && health.sessionWorkspaces !== true; },
    { immediate: true },
  );

  /** Xterm.js sends raw keystrokes; an old line-oriented server cannot use them. */
  const terminalOutdated = computed(() =>
    !!connection.health && connection.health.terminalPty !== true);

  const STALE_SERVER_MESSAGE = 'The CodingAgent server is running an older build that cannot bind folders to sessions. '
    + 'Stop it and run `npm start` (or `npm run dev`) again, then reload this page before choosing a folder.';

  function assertSessionWorkspaces(): void {
    if (serverOutdated.value) throw new Error(STALE_SERVER_MESSAGE);
  }

  /** Same folder regardless of drive-letter case, slash direction or trailing separator. */
  function sameFolder(a?: string | null, b?: string | null): boolean {
    const norm = (value?: string | null) =>
      (value ?? '').trim().replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
    const left = norm(a);
    return !!left && left === norm(b);
  }

  /**
   * Post-condition: the folder the server reports for THIS session must be the
   * one it just resolved. Both values come from the server, so no client-side
   * path guessing (`.`, `..`, `~`) can produce a false mismatch.
   */
  async function assertBoundTo(sessionId: string, resolvedRoot: string): Promise<void> {
    const state = await apiFetch<WorkspaceState>(`/api/workspace?sessionId=${encodeURIComponent(sessionId)}`);
    if (!sameFolder(state.active?.root, resolvedRoot)) {
      throw new Error(`This server did not bind the session to ${resolvedRoot}. ${STALE_SERVER_MESSAGE}`);
    }
  }

  // --- attachments pinned to the next message ----------------------------
  const attachments = ref<AttachmentDraft[]>([]);

  // --- skills + terminal -------------------------------------------------
  const skills = ref<SkillInfo[]>([]);
  const skillDirectories = ref<SkillsResponse['directories']>([]);
  const skillsBusy = ref(false);
  const skillsLog = ref<string[]>([]);

  const terminalOpen = ref(false);
  /** All shells stay alive while the dock is hidden, like a desktop IDE. */
  const terminalTabs = ref<TerminalTab[]>([]);
  const activeTerminalId = ref<string | null>(null);
  const terminalShellOptions = ref<TerminalShellInfo[]>([]);
  const terminalDefaultShell = ref('');
  const terminalPtyAvailable = ref(false);
  const terminalError = ref('');
  const terminalBusy = ref(false);
  /** Legacy line log, still used to echo skill-install output into the shell. */
  const terminalLines = ref<TerminalLine[]>([]);

  // Non-reactive plumbing: SSE controllers, viewport subscribers, and a
  // per-tab serial write chain that batches Xterm.js keystrokes into one POST.
  const terminalAborts = new Map<string, AbortController>();
  const terminalSinks = new Map<string, Set<TerminalSink>>();
  /** Mirror of each tab's visible scrollback, so a late-mounting viewport can replay it. */
  const terminalBacklogs = new Map<string, TerminalChunk[]>();
  const terminalChains = new Map<string, Promise<void>>();
  const terminalQueues = new Map<string, { parts: string[]; timer: ReturnType<typeof setTimeout> | null }>();

  const activeTerminal = computed(() => terminalTabs.value.find(t => t.id === activeTerminalId.value) ?? null);
  /** Kept as aliases so existing UI bindings keep working. */
  const terminalId = computed(() => activeTerminalId.value);
  const terminalCwd = computed(() => activeTerminal.value?.cwd ?? '');
  const terminalShell = computed(() => activeTerminal.value?.shell ?? '');
  const terminalPty = computed(() => activeTerminal.value?.pty ?? false);

  const activeWorkspace = computed(() => workspace.value?.active ?? null);

  const currentSession = computed(() => sessions.value.find(s => s.id === currentId.value) ?? null);
  const selectedModel = computed(() => {
    const s = currentSession.value;
    const platform = s?.modelPlatform ?? settings.value.defaultPlatform;
    const id = s?.modelId ?? settings.value.defaultModelId;
    return models.value.find(m => m.platform === platform && m.modelId === id) ?? null;
  });
  const usableModels = computed(() => models.value.filter(m => m.enabled && m.supportsTools && m.hasKey));
  const pendingPermission = computed(() => permissions.value[0] ?? null);

  let eventAbort: AbortController | null = null;
  let eventTask: Promise<void> | null = null;

  // -------------------------------------------------------------------------
  // Bootstrap
  // -------------------------------------------------------------------------
  async function bootstrap(): Promise<void> {
    hydrated.value = false;
    await initConnection();
    ready.value = true;
    // /api/health is public, so the offline screen works before login.
    const health: HealthResponse | null = await checkHealth();
    if (!health) {
      auth.user = null;
      auth.checked = true;
      hydrated.value = true; // signed out: nothing account-scoped to load
      return;
    }
    await restoreSession();
    if (!auth.user) {
      hydrated.value = true; // App.vue renders the sign-in / first-run screen
      return;
    }
    try {
      await bootstrapData();
    } finally {
      hydrated.value = true;
    }
  }

  /**
   * Called right after signIn/signUp. The auth result already gave us a valid
   * session and `auth.user`, so re-running `restoreSession()` here would flip
   * `auth.checked` back to false, unmount and remount the chat UI mid-flight,
   * and leave the model picker rendered against an empty catalogue. Hydrate
   * the account data directly instead.
   */
  async function afterLogin(): Promise<void> {
    hydrated.value = false;
    try {
      await bootstrapData();
    } finally {
      hydrated.value = true;
    }
  }

  /** Wipe every account-scoped collection when switching or signing out. */
  function resetAccountState(): void {
    stopEvents();
    hydrated.value = false;
    sessions.value = [];
    messages.value = [];
    models.value = [];
    providers.value = [];
    keys.value = [];
    permissions.value = [];
    todos.value = [];
    fileChanges.value = [];
    fileTree.value = [];
    analytics.value = null;
    workspace.value = null;
    workspacePicker.value = { open: false, mode: 'current-session' };
    attachments.value = [];
    skills.value = [];
    // Shells are account-scoped: signing out must not leave PTYs running.
    for (const tab of terminalTabs.value) {
      void apiFetch(`/api/terminal/${tab.id}`, { method: 'DELETE' }).catch(() => {});
    }
    disposeTerminalState();
    currentId.value = null;
    error.value = '';
    running.value = false;
  }

  async function refreshUser(): Promise<void> { await refreshMe(); }

  async function signOut(): Promise<void> {
    await requestSignOut();
    resetAccountState();
    clearSessionToken();
  }

  async function loadSessions(): Promise<void> {
    sessions.value = await apiFetch<Session[]>('/api/sessions');
  }
  async function loadModels(): Promise<void> { models.value = await apiFetch<ModelInfo[]>('/api/models'); }
  async function loadProviders(): Promise<void> { providers.value = await apiFetch<ProviderInfo[]>('/api/providers'); }
  async function loadKeys(): Promise<void> { keys.value = await apiFetch<ApiKeyInfo[]>('/api/keys'); }
  async function loadSettings(): Promise<void> { settings.value = await apiFetch<AppSettings>('/api/settings'); }

  async function loadAnalytics(): Promise<void> { analytics.value = await apiFetch<typeof analytics.value>('/api/analytics'); }

  async function loadTree(): Promise<void> {
    // The tree belongs to the open session's folder, so always pass its id.
    // Guard the assignment: an older request must not overwrite a newer
    // session's tree if the user switched sessions mid-flight.
    const sessionId = currentId.value;
    const query = `?depth=3${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ''}`;
    try {
      const result = await apiFetch<{ entries: FileNode[] }>(`/api/files/tree${query}`);
      if (currentId.value === sessionId) fileTree.value = result.entries;
    } catch {
      if (currentId.value === sessionId) fileTree.value = [];
    }
  }

  async function loadChanges(): Promise<void> {
    if (!currentId.value) return;
    try { fileChanges.value = await apiFetch<FileChange[]>(`/api/files/changes?sessionId=${currentId.value}`); }
    catch { fileChanges.value = []; }
  }

  // -------------------------------------------------------------------------
  // Workspace: open a folder as the agent's sandboxed project home
  // -------------------------------------------------------------------------
  async function loadWorkspace(): Promise<void> {
    // /api/workspace?sessionId=… reports the folder bound to this session.
    // Without it the server would answer with the account-wide pointer, which
    // is exactly why every session used to show the same directory.
    const sessionId = currentId.value;
    const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
    try {
      const state = await apiFetch<WorkspaceState>(`/api/workspace${query}`);
      if (currentId.value !== sessionId) return;
      workspace.value = state;
      workspaceStale.value = false;
    } catch (err) {
      if (currentId.value !== sessionId) return;
      workspace.value = null;
      workspaceStale.value = isMissingRoute(err);
    }
  }

  function openWorkspacePicker(mode: WorkspacePickerMode): void {
    workspacePicker.value = { open: true, mode };
  }

  function closeWorkspacePicker(): void {
    workspacePicker.value.open = false;
  }

  /** A 404 here means the server process predates the workspace API. */
  function isMissingRoute(err: unknown): boolean {
    return /not found|\b404\b/i.test((err as Error)?.message ?? String(err));
  }

  function workspaceError(err: unknown): Error {
    if (isMissingRoute(err)) {
      workspaceStale.value = true;
      return new Error(
        'The running agent server has no workspace API — it is an older build. '
        + 'Restart it (npm start, or Ctrl+C then npm run dev) and reload this page.',
      );
    }
    return err instanceof Error ? err : new Error(String(err));
  }

  async function browseWorkspace(target?: string): Promise<BrowseResult> {
    const query = target ? `?path=${encodeURIComponent(target)}` : '';
    try {
      return await apiFetch<BrowseResult>(`/api/workspace/browse${query}`);
    } catch (err) {
      throw workspaceError(err);
    }
  }

  /**
   * Rebind the CURRENT session to a folder. A session owns exactly one
   * workspace, so changing its folder must not spawn an extra session (that
   * was the bug: the new session inherited the account-wide active pointer and
   * every session ended up displaying the same directory).
   */
  async function openWorkspace(target: string): Promise<WorkspaceInfo> {
    assertSessionWorkspaces();
    workspaceBusy.value = true;
    try {
      let info: WorkspaceInfo;
      const sessionId = currentId.value;
      try {
        info = await apiFetch<WorkspaceInfo>('/api/workspace/open', {
          method: 'POST',
          body: JSON.stringify({ path: target, sessionId: sessionId ?? undefined }),
        });
      } catch (err) {
        throw workspaceError(err);
      }
      await Promise.all([loadWorkspace(), loadTree(), loadSkills(), checkHealth(sessionId)]);
      // If the server ignored sessionId, the folder was only set account-wide
      // and a different session's folder is still what the agent will use.
      if (sessionId) await assertBoundTo(sessionId, info.root);
      await resetSessionShell();
      return info;
    } finally {
      workspaceBusy.value = false;
    }
  }

  /** Called by the shared folder picker once a directory has been chosen. */
  async function chooseWorkspaceFolder(target: string, mode: WorkspacePickerMode): Promise<void> {
    workspaceBusy.value = true;
    try {
      if (mode === 'new-session') await newSession(target);
      else await openWorkspace(target);
      closeWorkspacePicker();
    } finally {
      workspaceBusy.value = false;
    }
  }

  /** Shortcut for "another session in the folder I already have open". */
  async function createSessionInCurrentFolder(): Promise<void> {
    workspaceBusy.value = true;
    try {
      // Pass the folder explicitly: a bare newSession() would inherit the
      // account-wide pointer, which may be a different directory entirely.
      await newSession(activeWorkspace.value?.root || undefined);
      closeWorkspacePicker();
    } finally {
      workspaceBusy.value = false;
    }
  }

  // -------------------------------------------------------------------------
  // Attachments: explicit context for a single turn
  // -------------------------------------------------------------------------
  function addAttachment(draft: Omit<AttachmentDraft, 'key'>): void {
    if (attachments.value.length >= 12) {
      error.value = 'You can attach at most 12 files per message.';
      return;
    }
    if (attachments.value.some(a => a.path === draft.path && a.external === draft.external)) return;
    attachments.value.push({ ...draft, key: `${draft.path}:${Math.random().toString(36).slice(2, 8)}` });
  }

  function removeAttachment(key: string): void {
    attachments.value = attachments.value.filter(a => a.key !== key);
  }

  function clearAttachments(): void {
    attachments.value = [];
  }

  const BINARY_EXT = new Set([
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'pdf', 'zip', 'gz', 'tar', '7z', 'rar',
    'exe', 'dll', 'so', 'dylib', 'woff', 'woff2', 'ttf', 'otf', 'mp3', 'mp4', 'mov', 'avi', 'webm',
    'sqlite', 'db', 'class', 'jar', 'wasm', 'psd', 'ai', 'heic',
  ]);

  function kindOfName(name: string): string {
    const ext = name.split('.').pop() ?? '';
    return ext && ext !== name ? ext.toLowerCase() : 'file';
  }

  /**
   * Device files have no absolute path the server could read, so the browser
   * reads them and the text is inlined for this turn only.
   */
  async function attachDeviceFiles(files: File[]): Promise<string | null> {
    let problem: string | null = null;
    for (const file of files) {
      const kind = kindOfName(file.name);
      if (BINARY_EXT.has(kind)) { problem = `${file.name} looks binary and cannot be attached as text.`; continue; }
      if (file.size > 256 * 1024) { problem = `${file.name} is larger than 256 KB and was skipped.`; continue; }
      try {
        const content = await file.text();
        if (content.includes('\u0000')) { problem = `${file.name} looks binary and cannot be attached as text.`; continue; }
        addAttachment({
          path: file.name,
          name: file.name,
          external: true,
          content,
          size: file.size,
          kind,
          tokens: Math.ceil(content.length / 4),
        });
      } catch (err) {
        problem = `Could not read ${file.name}: ${(err as Error).message}`;
      }
    }
    return problem;
  }

  // -------------------------------------------------------------------------
  // Agent Skills
  // -------------------------------------------------------------------------
  async function loadSkills(): Promise<void> {
    try {
      const query = currentId.value ? `?sessionId=${currentId.value}` : '';
      const response = await apiFetch<SkillsResponse>(`/api/skills${query}`);
      skills.value = response.skills;
      skillDirectories.value = response.directories;
    } catch {
      skills.value = [];
    }
  }

  async function installSkill(source: string, scope: 'workspace' | 'user' = 'workspace'): Promise<InstallSkillResult> {
    skillsBusy.value = true;
    try {
      const result = await apiFetch<InstallSkillResult>('/api/skills/install', {
        method: 'POST',
        body: JSON.stringify({ source, scope, sessionId: currentId.value, force: false }),
      });
      skills.value = result.skills;
      skillsLog.value = [...skillsLog.value, ...result.log];
      return result;
    } finally {
      skillsBusy.value = false;
    }
  }

  async function toggleSkill(id: string, enabled: boolean): Promise<void> {
    const response = await apiFetch<SkillsResponse>(`/api/skills/${encodeURIComponent(id)}`, {
      method: 'PATCH', body: JSON.stringify({ enabled, sessionId: currentId.value }),
    });
    skills.value = response.skills;
  }

  async function removeSkill(id: string): Promise<void> {
    const response = await apiFetch<SkillsResponse>(
      `/api/skills/${encodeURIComponent(id)}${currentId.value ? `?sessionId=${currentId.value}` : ''}`,
      { method: 'DELETE' },
    );
    skills.value = response.skills;
  }

  function pushSkillLog(line: string): void {
    skillsLog.value = [...skillsLog.value, line].slice(-200);
  }

  // -------------------------------------------------------------------------
  // Terminal: Xterm.js tabs over real PTY shells in the session's workspace
  // -------------------------------------------------------------------------
  function dispatchTerminalChunk(chunk: TerminalChunk): void {
    // Keep a replay mirror in sync with what a live viewport sees. A `reset`
    // starts a fresh transcript (SSE replay, restart, or clear).
    let backlog = terminalBacklogs.get(chunk.terminalId);
    if (chunk.stream === 'reset') {
      backlog = [];
      terminalBacklogs.set(chunk.terminalId, backlog);
    } else if (backlog) {
      backlog.push(chunk);
      if (backlog.length > 8000) backlog.splice(0, backlog.length - 8000);
    }
    const sinks = terminalSinks.get(chunk.terminalId);
    if (!sinks) return;
    for (const sink of [...sinks]) {
      try { sink(chunk); } catch { /* the view unmounted mid-frame */ }
    }
  }

  function appendTerminalLine(line: TerminalLine): void {
    terminalLines.value.push(line);
    if (terminalLines.value.length > 3000) {
      terminalLines.value.splice(0, terminalLines.value.length - 3000);
    }
  }

  /** Skills install output is echoed into the active shell as dim system text. */
  function pushTerminalLine(line: TerminalLine): void {
    appendTerminalLine(line);
    const id = activeTerminalId.value;
    if (!id) return;
    dispatchTerminalChunk({
      terminalId: id,
      stream: 'system',
      data: `\x1b[2m${line.data.replace(/\r?\n/g, '\r\n')}\x1b[0m`,
      at: line.at,
    });
  }

  /**
   * Register an Xterm.js viewport for one tab. The SSE connection can start
   * before Vue has mounted the viewport, so replay the mirrored scrollback to
   * every late subscriber (preceded by a reset to avoid duplicated output).
   */
  function subscribeTerminalData(id: string, sink: TerminalSink): () => void {
    let set = terminalSinks.get(id);
    if (!set) { set = new Set(); terminalSinks.set(id, set); }
    set.add(sink);
    const backlog = terminalBacklogs.get(id);
    if (backlog?.length) {
      try {
        sink({ terminalId: id, stream: 'reset', data: '', at: new Date().toISOString() });
        for (const chunk of backlog) sink(chunk);
      } catch { /* a half-initialised viewport must not break the store */ }
    }
    return () => {
      set?.delete(sink);
      if (set && !set.size) terminalSinks.delete(id);
    };
  }

  function emitTerminalReset(id: string): void {
    dispatchTerminalChunk({ terminalId: id, stream: 'reset', data: '', at: new Date().toISOString() });
  }

  function markTab(id: string, state: TerminalState): void {
    const tab = terminalTabs.value.find(t => t.id === id);
    if (!tab) return;
    tab.cwd = state.cwd;
    tab.shell = state.shell;
    tab.shellId = state.shellId || tab.shellId;
    tab.pty = !!state.pty;
    tab.cols = state.cols || tab.cols;
    tab.rows = state.rows || tab.rows;
    tab.running = state.running;
  }

  /**
   * SSE streams are long-lived, but a proxy timeout or a server restart can
   * close one. Replay frames (`reset` + scrollback) make a reconnect lossless,
   * so retry with bounded backoff instead of leaving a dead tab on screen.
   */
  function connectTerminal(id: string): void {
    terminalAborts.get(id)?.abort();
    const controller = new AbortController();
    terminalAborts.set(id, controller);
    let attempt = 0;
    void (async () => {
      while (!controller.signal.aborted && terminalTabs.value.some(t => t.id === id)) {
        let received = false;
        const startedAt = Date.now();
        try {
          await streamTerminal(id, chunk => {
            if (chunk.terminalId !== id) return;
            if (!received) {
              received = true;
              terminalError.value = '';
            }
            appendTerminalLine({ stream: chunk.stream, data: chunk.data, at: chunk.at });
            dispatchTerminalChunk(chunk);
          }, controller.signal);
        } catch (err) {
          if (controller.signal.aborted) return;
          const message = (err as Error).message;
          // A disposed terminal or revoked session will never come back.
          if (/\b(401|403|404)\b/.test(message)) {
            terminalError.value = message;
            const tab = terminalTabs.value.find(t => t.id === id);
            if (tab) tab.running = false;
            return;
          }
          terminalError.value = message;
        }
        if (controller.signal.aborted || !terminalTabs.value.some(t => t.id === id)) return;
        // Only a stream that stayed up counts as a healthy connection; otherwise
        // a server that closes every SSE immediately would be hammered at 400ms.
        const healthy = received && Date.now() - startedAt > 10_000;
        attempt = healthy ? 0 : Math.min(attempt + 1, 4);
        await new Promise(resolve => setTimeout(resolve, Math.min(4000, 400 * 2 ** attempt)));
        if (controller.signal.aborted || !terminalTabs.value.some(t => t.id === id)) return;
        try {
          // Resync geometry / running state, and stop if the shell is gone.
          const states = await apiFetch<TerminalState[]>('/api/terminal');
          const state = states.find(s => s.id === id);
          if (!state) return;
          markTab(id, state);
        } catch { /* transient; the next reconnect will try again */ }
      }
    })();
  }

  async function loadTerminalShells(): Promise<void> {
    try {
      const data = await apiFetch<TerminalShellsResponse>('/api/terminal/shells');
      terminalShellOptions.value = data.shells;
      terminalDefaultShell.value = data.defaultShell;
      terminalPtyAvailable.value = data.pty;
    } catch {
      terminalShellOptions.value = [];
      terminalPtyAvailable.value = false;
    }
  }

  function newTabFrom(state: TerminalState): TerminalTab {
    return {
      id: state.id,
      title: `${state.shell} ${terminalTabs.value.length + 1}`,
      cwd: state.cwd,
      shell: state.shell,
      shellId: state.shellId || terminalDefaultShell.value,
      pty: !!state.pty,
      cols: state.cols || 80,
      rows: state.rows || 24,
      running: state.running,
      createdAt: state.createdAt,
    };
  }

  /** Spawn an additional shell. Each tab owns its PTY and its own scrollback. */
  async function createTerminalTab(options: { shell?: string; cols?: number; rows?: number } = {}): Promise<TerminalTab | null> {
    if (terminalOutdated.value) {
      terminalError.value = 'The server is running an older terminal build without PTY support. '
        + 'Restart the CodingAgent server and reload this page to use the new terminal.';
      return null;
    }
    terminalBusy.value = true;
    terminalError.value = '';
    try {
      const state = await apiFetch<TerminalState>('/api/terminal', {
        method: 'POST',
        body: JSON.stringify({
          sessionId: currentId.value ?? undefined,
          shell: options.shell || terminalDefaultShell.value || undefined,
          cols: options.cols || 80,
          rows: options.rows || 24,
        }),
      });
      const tab = newTabFrom(state);
      terminalBacklogs.set(tab.id, []);
      terminalTabs.value.push(tab);
      activeTerminalId.value = tab.id;
      connectTerminal(tab.id);
      return tab;
    } catch (err) {
      terminalError.value = (err as Error).message;
      return null;
    } finally {
      terminalBusy.value = false;
    }
  }

  async function ensureTerminal(): Promise<void> {
    if (terminalTabs.value.length) return;
    if (!terminalShellOptions.value.length) await loadTerminalShells();
    await createTerminalTab();
  }

  /**
   * Xterm.js emits one `onData` event per keystroke. Coalesce a burst into a
   * single POST and keep a per-tab serial chain so ordering is never lost.
   */
  function enqueueTerminalInput(id: string, data: string): void {
    let queue = terminalQueues.get(id);
    if (!queue) { queue = { parts: [], timer: null }; terminalQueues.set(id, queue); }
    queue.parts.push(data);
    if (queue.timer) return;
    queue.timer = setTimeout(() => {
      const entry = terminalQueues.get(id);
      if (!entry) return;
      entry.timer = null;
      const payload = entry.parts.join('');
      entry.parts = [];
      if (payload) void flushTerminalInput(id, payload);
    }, 12);
  }

  function flushTerminalInput(id: string, payload: string): Promise<void> {
    const previous = terminalChains.get(id) ?? Promise.resolve();
    const next = previous.then(async () => {
      try {
        await apiFetch(`/api/terminal/${id}/input`, {
          method: 'POST', body: JSON.stringify({ data: payload }),
        });
      } catch (err) {
        terminalError.value = (err as Error).message;
      }
    });
    terminalChains.set(id, next);
    void next.then(() => { if (terminalChains.get(id) === next) terminalChains.delete(id); });
    return next;
  }

  /** Raw bytes, not a command line. Omit `id` to target the active tab. */
  async function sendTerminal(data: string, id?: string): Promise<void> {
    let target = id ?? activeTerminalId.value;
    if (!target) {
      await ensureTerminal();
      target = activeTerminalId.value;
    }
    if (!target) return;
    enqueueTerminalInput(target, data);
  }

  async function resizeTerminal(id: string, cols: number, rows: number): Promise<void> {
    const tab = terminalTabs.value.find(t => t.id === id);
    if (tab) { tab.cols = cols; tab.rows = rows; }
    await apiFetch(`/api/terminal/${id}/resize`, {
      method: 'POST', body: JSON.stringify({ cols, rows }),
    }).catch(() => { /* a dead shell will report its own error */ });
  }

  async function interruptTerminal(id?: string): Promise<void> {
    const target = id ?? activeTerminalId.value;
    if (!target) return;
    await apiFetch(`/api/terminal/${target}/interrupt`, { method: 'POST' }).catch(() => {});
  }

  async function restartTerminal(id?: string): Promise<void> {
    const target = id ?? activeTerminalId.value;
    if (!target) return;
    emitTerminalReset(target);
    try {
      const state = await apiFetch<TerminalState>(`/api/terminal/${target}/restart`, { method: 'POST' });
      markTab(target, state);
    } catch (err) {
      terminalError.value = (err as Error).message;
    }
  }

  async function clearTerminal(id?: string): Promise<void> {
    const target = id ?? activeTerminalId.value;
    if (!target) return;
    terminalLines.value = [];
    emitTerminalReset(target);
    await apiFetch(`/api/terminal/${target}/clear`, { method: 'POST' }).catch(() => {});
  }

  async function closeTerminalTab(id: string): Promise<void> {
    terminalAborts.get(id)?.abort();
    terminalAborts.delete(id);
    terminalSinks.delete(id);
    terminalBacklogs.delete(id);
    terminalChains.delete(id);
    const queue = terminalQueues.get(id);
    if (queue?.timer) clearTimeout(queue.timer);
    terminalQueues.delete(id);
    const index = terminalTabs.value.findIndex(t => t.id === id);
    terminalTabs.value = terminalTabs.value.filter(t => t.id !== id);
    if (activeTerminalId.value === id) {
      activeTerminalId.value = terminalTabs.value[Math.max(0, index - 1)]?.id
        ?? terminalTabs.value[0]?.id ?? null;
    }
    await apiFetch(`/api/terminal/${id}`, { method: 'DELETE' }).catch(() => {});
  }

  /** Backwards-compatible alias for callers that only know "the" terminal. */
  async function closeTerminal(): Promise<void> {
    const id = activeTerminalId.value;
    if (id) await closeTerminalTab(id);
  }

  function disposeTerminalState(): void {
    for (const controller of terminalAborts.values()) controller.abort();
    terminalAborts.clear();
    terminalSinks.clear();
    terminalBacklogs.clear();
    terminalChains.clear();
    for (const queue of terminalQueues.values()) if (queue.timer) clearTimeout(queue.timer);
    terminalQueues.clear();
    terminalTabs.value = [];
    activeTerminalId.value = null;
    terminalLines.value = [];
    terminalError.value = '';
  }

  /**
   * A shell keeps the cwd it was spawned in. When a session's folder changes
   * (or the user switches sessions) every old shell is stale and must be
   * recreated in the new folder.
   */
  async function resetSessionShell(): Promise<void> {
    const ids = terminalTabs.value.map(t => t.id);
    for (const id of ids) await closeTerminalTab(id);
    disposeTerminalState();
    if (terminalOpen.value) await ensureTerminal();
  }

  async function toggleTerminal(): Promise<void> {
    terminalOpen.value = !terminalOpen.value;
    if (terminalOpen.value) {
      await ensureTerminal();
      void loadSkills();
    }
  }

  function renameTerminalTab(id: string, title: string): void {
    const tab = terminalTabs.value.find(t => t.id === id);
    if (tab) tab.title = title || tab.title;
  }

  async function loadSessionData(id: string): Promise<void> {
    const data = await apiFetch<{ session: Session; messages: Message[]; todos: TodoItem[]; running: boolean }>(`/api/sessions/${id}`);
    messages.value = data.messages;
    todos.value = data.todos;
    running.value = data.running;
    permissions.value = await apiFetch<PermissionRequest[]>(`/api/sessions/${id}/permissions`);
    void loadChanges();
  }

  // -------------------------------------------------------------------------
  // Sessions & streaming
  // -------------------------------------------------------------------------
  async function newSession(rootPath?: string): Promise<void> {
    // rootPath claims that directory for THIS session only. The server does
    // not change the account-wide pointer, so other sessions keep theirs.
    if (rootPath) assertSessionWorkspaces();
    const body = rootPath ? { rootPath } : {};
    const session = await apiFetch<Session & { workspaceRoot?: string }>('/api/sessions', {
      method: 'POST', body: JSON.stringify(body),
    });

    // A stale build answers with a plain Session and binds the new session to
    // the account pointer. Delete that orphan instead of letting the model
    // write into the previous session's directory.
    if (rootPath && !session.workspaceRoot) {
      await apiFetch(`/api/sessions/${session.id}`, { method: 'DELETE' }).catch(() => {});
      throw new Error(STALE_SERVER_MESSAGE);
    }
    if (rootPath && session.workspaceRoot) {
      try {
        await assertBoundTo(session.id, session.workspaceRoot);
      } catch (err) {
        await apiFetch(`/api/sessions/${session.id}`, { method: 'DELETE' }).catch(() => {});
        throw err;
      }
    }

    sessions.value.unshift(session);
    await selectSession(session.id);
  }

  async function selectSession(id: string): Promise<void> {
    if (currentId.value === id && eventTask) return;
    const previousId = currentId.value;
    stopEvents();
    currentId.value = id;
    permissions.value = [];
    usage.value = null;
    error.value = '';
    attachments.value = [];
    fileTree.value = [];
    // Folder, tree, skills, health readout and shell all belong to the session.
    // Refresh them so switching back to a session restores its own workspace.
    void loadWorkspace();
    void loadTree();
    void loadSkills();
    void checkHealth(id);
    if (previousId && previousId !== id) void resetSessionShell();
    await loadSessionData(id);
    connectEvents(id);
    if (window.innerWidth < 900) sidebarOpen.value = false;
  }

  function stopEvents(): void {
    eventAbort?.abort();
    eventAbort = null;
    eventTask = null;
  }

  function connectEvents(id: string): void {
    eventAbort?.abort();
    const controller = new AbortController();
    eventAbort = controller;
    eventTask = (async () => {
      while (!controller.signal.aborted) {
        try {
          await streamEvents(id, event => applyEvent(id, event), controller.signal);
        } catch (err) {
          if (!controller.signal.aborted) connection.error = (err as Error).message;
        }
        if (controller.signal.aborted) break;
        // Re-sync authoritative state after a reconnect, then listen again.
        try { await loadSessionData(id); } catch { /* server may be restarting */ }
        await new Promise(resolve => setTimeout(resolve, 1200));
      }
    })();
  }

  function findPart(id: string): Part | undefined {
    for (const message of messages.value) {
      const part = message.parts.find(p => p.id === id);
      if (part) return part;
    }
    return undefined;
  }

  function applyEvent(sessionId: string, event: AgentEvent): void {
    if (sessionId !== currentId.value && event.type !== 'session') return;
    switch (event.type) {
      case 'session': {
        const index = sessions.value.findIndex(s => s.id === event.session.id);
        if (index === -1) sessions.value.unshift(event.session);
        else sessions.value[index] = event.session;
        break;
      }
      case 'message': {
        if (!messages.value.some(m => m.id === event.message.id)) messages.value.push(event.message);
        break;
      }
      case 'part': {
        const message = messages.value.find(m => m.id === event.part.messageId);
        if (message && !message.parts.some(p => p.id === event.part.id)) message.parts.push(event.part);
        break;
      }
      case 'part-delta': {
        const part = findPart(event.partId);
        if (part) part.text = (part.text ?? '') + event.delta;
        break;
      }
      case 'part-state': {
        const part = findPart(event.partId);
        if (part) {
          part.state = event.state;
          if (event.output !== undefined) part.output = event.output;
        }
        break;
      }
      case 'permission': {
        if (!permissions.value.some(p => p.id === event.permission.id)) permissions.value.push(event.permission);
        break;
      }
      case 'permission-resolved': {
        permissions.value = permissions.value.filter(p => p.id !== event.permissionId);
        break;
      }
      case 'todos': todos.value = event.todos; break;
      case 'file-changed': void loadChanges(); void loadTree(); break;
      case 'usage': usage.value = event.usage; break;
      case 'error': error.value = event.message; running.value = false; break;
      case 'done': {
        running.value = false;
        void loadSessionData(sessionId);
        void loadSessions();
        break;
      }
      default: break;
    }
  }

  async function send(text: string): Promise<void> {
    // A file-only turn is valid: "apply my instruction to this attachment".
    if (!currentId.value || running.value) return;
    if (!text.trim() && !attachments.value.length) return;
    error.value = '';
    usage.value = null;
    running.value = true;
    const pending = [...attachments.value];
    const body: Record<string, unknown> = { text };
    if (pending.length) {
      body.attachments = pending.map(a => ({
        path: a.path,
        name: a.name,
        external: a.external,
        ...(a.content ? { content: a.content } : {}),
      }));
    }
    const model = selectedModel.value;
    if (model) { body.modelPlatform = model.platform; body.modelId = model.modelId; }
    try {
      await apiFetch(`/api/sessions/${currentId.value}/chat`, { method: 'POST', body: JSON.stringify(body) });
      // Only drop the tray once the turn was actually accepted.
      attachments.value = [];
    } catch (err) {
      running.value = false;
      error.value = (err as Error).message;
    }
  }

  async function abort(): Promise<void> {
    if (!currentId.value) return;
    try { await apiFetch(`/api/sessions/${currentId.value}/abort`, { method: 'POST' }); }
    finally { running.value = false; }
  }

  async function resolvePermission(id: string, decision: 'approved' | 'denied' | 'approved_always'): Promise<void> {
    await apiFetch(`/api/permissions/${id}/resolve`, { method: 'POST', body: JSON.stringify({ decision }) });
    permissions.value = permissions.value.filter(p => p.id !== id);
  }

  async function renameSession(id: string, title: string): Promise<void> {
    const updated = await apiFetch<Session>(`/api/sessions/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) });
    const index = sessions.value.findIndex(s => s.id === id);
    if (index !== -1) sessions.value[index] = updated;
  }

  async function deleteSession(id: string): Promise<void> {
    // Keep the deleted session's folder if it was the last one, so the fresh
    // session does not silently jump back to the account-wide default folder.
    const lastWorkspaceRoot = currentId.value === id ? (activeWorkspace.value?.root || undefined) : undefined;
    await apiFetch(`/api/sessions/${id}`, { method: 'DELETE' });
    sessions.value = sessions.value.filter(s => s.id !== id);
    if (currentId.value === id) {
      stopEvents();
      currentId.value = null;
      messages.value = [];
      if (sessions.value.length) await selectSession(sessions.value[0].id);
      else await newSession(lastWorkspaceRoot);
    }
  }

  async function setModel(platform: string, modelId: string): Promise<void> {
    if (!currentId.value) return;
    const updated = await apiFetch<Session>(`/api/sessions/${currentId.value}`, {
      method: 'PATCH', body: JSON.stringify({ modelPlatform: platform, modelId }),
    });
    const index = sessions.value.findIndex(s => s.id === updated.id);
    if (index !== -1) sessions.value[index] = updated;
  }

  async function setAgent(agent: 'build' | 'plan' | 'general'): Promise<void> {
    if (!currentId.value) return;
    const updated = await apiFetch<Session>(`/api/sessions/${currentId.value}`, {
      method: 'PATCH', body: JSON.stringify({ agent }),
    });
    const index = sessions.value.findIndex(s => s.id === updated.id);
    if (index !== -1) sessions.value[index] = updated;
  }

  // -------------------------------------------------------------------------
  // Settings / providers
  // -------------------------------------------------------------------------
  async function saveSettings(patch: Partial<AppSettings>): Promise<void> {
    settings.value = await apiFetch<AppSettings>('/api/settings', { method: 'PATCH', body: JSON.stringify(patch) });
  }

  async function addKey(input: { platform: string; key: string; label?: string; baseUrl?: string }): Promise<void> {
    await apiFetch('/api/keys', { method: 'POST', body: JSON.stringify(input) });
    await Promise.all([loadKeys(), loadProviders(), loadModels()]);
    // The server picks a default model on the account's first key, so refresh
    // settings and keyCount too (the BYOK onboarding banner depends on both).
    await Promise.all([loadSettings(), refreshUser()]);
  }

  async function toggleKey(id: number, enabled: boolean): Promise<void> {
    await apiFetch(`/api/keys/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) });
    await Promise.all([loadKeys(), loadProviders(), loadModels(), refreshUser()]);
  }

  async function removeKey(id: number): Promise<void> {
    await apiFetch(`/api/keys/${id}`, { method: 'DELETE' });
    await Promise.all([loadKeys(), loadProviders(), loadModels(), refreshUser()]);
  }

  /**
   * A session token belongs to one server, so changing the URL always signs
   * out and returns the user to the login screen for that server.
   */
  async function applyConnection(url: string): Promise<boolean> {
    setServerUrl(url);
    clearSessionToken();
    auth.user = null;
    resetAccountState();
    const health = await checkHealth();
    if (!health) return false;
    await restoreSession();
    return true;
  }

  async function bootstrapData(): Promise<void> {
    // One slow/failing endpoint must not abort the whole hydration: in
    // particular a workspace error should never leave the model list empty.
    // Health is refreshed *after* authentication so the sidebar and settings
    // show the full workspace/db info rather than the anonymous sparse payload.
    const labels = ['sessions', 'models', 'providers', 'keys', 'settings', 'workspace', 'health'] as const;
    const results = await Promise.allSettled([
      loadSessions(), loadModels(), loadProviders(), loadKeys(), loadSettings(), loadWorkspace(), checkHealth(),
    ]);
    const failures: string[] = [];
    results.forEach((result, index) => {
      if (result.status !== 'rejected') return;
      const label = labels[index] ?? 'data';
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
      console.warn(`[bootstrap] ${label} load failed:`, result.reason);
      if (label !== 'health') failures.push(`${label}: ${reason}`);
    });
    if (failures.length) {
      // Successful collections are still usable; App.vue shows a retry banner.
      throw new Error(`Could not load some account data (${failures.join('; ')}).`);
    }
    if (sessions.value.length) {
      const id = sessions.value.find(s => s.id === currentId.value)?.id ?? sessions.value[0].id;
      currentId.value = null;
      await selectSession(id);
    } else {
      await newSession();
    }
    void loadTree();
    void loadSkills();
  }

  function clearError(): void { error.value = ''; }

  return {
    sessions, projects, currentId, messages, models, providers, keys, settings,
    permissions, todos, fileChanges, fileTree, analytics,
    running, usage, error, ready, hydrated, sidebarOpen, rightPanel,
    currentSession, selectedModel, usableModels, pendingPermission, connection,
    workspace, workspaceBusy, workspaceStale, activeWorkspace, workspacePicker, serverOutdated,
    attachments,
    skills, skillDirectories, skillsBusy, skillsLog,
    terminalOpen, terminalId, terminalCwd, terminalShell, terminalPty, terminalLines,
    terminalError, terminalBusy, terminalOutdated, terminalTabs, activeTerminalId, activeTerminal,
    terminalShellOptions, terminalDefaultShell, terminalPtyAvailable,
    bootstrap, afterLogin, loadTree, loadChanges, loadAnalytics,
    loadWorkspace, browseWorkspace, openWorkspace,
    openWorkspacePicker, closeWorkspacePicker, chooseWorkspaceFolder, createSessionInCurrentFolder,
    addAttachment, removeAttachment, clearAttachments, attachDeviceFiles, kindOfName,
    loadSkills, installSkill, toggleSkill, removeSkill, pushSkillLog, pushTerminalLine,
    loadTerminalShells, createTerminalTab, closeTerminalTab, subscribeTerminalData,
    renameTerminalTab, resizeTerminal, restartTerminal, resetSessionShell,
    ensureTerminal, sendTerminal, interruptTerminal, clearTerminal, closeTerminal, toggleTerminal,
    newSession, selectSession, send, abort, resolvePermission, renameSession, deleteSession,
    setModel, setAgent, saveSettings, addKey, toggleKey, removeKey,
    applyConnection, clearError, checkHealth, bootstrapData, refreshUser, signOut,
  };
});
