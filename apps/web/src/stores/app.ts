import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type {
  AgentEvent, ApiKeyInfo, AppSettings, BrowseResult, FileNode, HealthResponse, InstallSkillResult,
  Message, ModelInfo, Part, PermissionRequest, Project, ProviderInfo, Session, SkillInfo, SkillsResponse,
  TerminalChunk, TerminalState, TodoItem, Usage, WorkspaceInfo, WorkspaceState,
} from '@codingagent/shared';
import { DEFAULT_SETTINGS } from '@codingagent/shared';
import {
  apiFetch, checkHealth, connection, initConnection, setConnection, streamEvents, streamTerminal,
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
  const sidebarOpen = ref(true);
  const rightPanel = ref<'files' | 'changes' | 'todos' | null>('files');

  // --- workspace (sandboxed project home) --------------------------------
  const workspace = ref<WorkspaceState | null>(null);
  const workspaceBusy = ref(false);
  /** Set when the server answers 404 for /api/workspace: stale build, needs restart. */
  const workspaceStale = ref(false);

  // --- attachments pinned to the next message ----------------------------
  const attachments = ref<AttachmentDraft[]>([]);

  // --- skills + terminal -------------------------------------------------
  const skills = ref<SkillInfo[]>([]);
  const skillDirectories = ref<SkillsResponse['directories']>([]);
  const skillsBusy = ref(false);
  const skillsLog = ref<string[]>([]);

  const terminalOpen = ref(false);
  const terminalId = ref<string | null>(null);
  const terminalCwd = ref('');
  const terminalShell = ref('');
  const terminalLines = ref<TerminalLine[]>([]);
  const terminalError = ref('');
  const terminalBusy = ref(false);
  let terminalAbort: AbortController | null = null;

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
    await initConnection();
    ready.value = true;
    const health: HealthResponse | null = await checkHealth();
    if (!health) return;
    await Promise.all([
      loadSessions(), loadModels(), loadProviders(), loadKeys(), loadSettings(), loadWorkspace(),
    ]);
    if (sessions.value.length) {
      await selectSession(sessions.value[0].id);
    } else {
      await newSession();
    }
    void loadTree();
    void loadSkills();
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
    try { fileTree.value = (await apiFetch<{ entries: FileNode[] }>('/api/files/tree?depth=3')).entries; }
    catch { fileTree.value = []; }
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
    try {
      workspace.value = await apiFetch<WorkspaceState>('/api/workspace');
      workspaceStale.value = false;
    } catch (err) {
      workspace.value = null;
      workspaceStale.value = isMissingRoute(err);
    }
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
   * Opening a folder rebinds the sandbox root. Sessions are project-scoped, so
   * this also starts a fresh session inside the new workspace.
   */
  async function openWorkspace(target: string): Promise<WorkspaceInfo> {
    workspaceBusy.value = true;
    try {
      let info: WorkspaceInfo;
      try {
        info = await apiFetch<WorkspaceInfo>('/api/workspace/open', {
          method: 'POST', body: JSON.stringify({ path: target }),
        });
      } catch (err) {
        throw workspaceError(err);
      }
      await Promise.all([loadWorkspace(), checkHealth()]);
      await Promise.all([loadTree(), loadSkills()]);
      await newSession();
      // The old shell was rooted in the previous folder; drop it.
      await closeTerminal();
      return info;
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
  // Terminal: persistent shell in the workspace root
  // -------------------------------------------------------------------------
  function pushTerminalLine(line: TerminalLine): void {
    terminalLines.value.push(line);
    if (terminalLines.value.length > 3000) {
      terminalLines.value.splice(0, terminalLines.value.length - 3000);
    }
  }

  function connectTerminal(id: string): void {
    terminalAbort?.abort();
    const controller = new AbortController();
    terminalAbort = controller;
    void (async () => {
      try {
        await streamTerminal(id, chunk => {
          if (chunk.terminalId !== terminalId.value) return;
          pushTerminalLine({ stream: chunk.stream, data: chunk.data, at: chunk.at });
        }, controller.signal);
      } catch (err) {
        if (controller.signal.aborted) return;
        terminalError.value = (err as Error).message;
        // The shell dies with the server; drop the id so the next open respawns.
        terminalId.value = null;
      }
    })();
  }

  async function ensureTerminal(): Promise<void> {
    terminalError.value = '';
    if (terminalId.value) return;
    terminalBusy.value = true;
    try {
      const state = await apiFetch<TerminalState>('/api/terminal', { method: 'POST' });
      terminalId.value = state.id;
      terminalCwd.value = state.cwd;
      terminalShell.value = state.shell;
      terminalLines.value = [];
      connectTerminal(state.id);
    } catch (err) {
      terminalError.value = (err as Error).message;
    } finally {
      terminalBusy.value = false;
    }
  }

  async function sendTerminal(data: string): Promise<void> {
    if (!terminalId.value) await ensureTerminal();
    const id = terminalId.value;
    if (!id) return;
    try {
      await apiFetch(`/api/terminal/${id}/input`, { method: 'POST', body: JSON.stringify({ data }) });
    } catch (err) {
      terminalError.value = (err as Error).message;
    }
  }

  async function interruptTerminal(): Promise<void> {
    if (!terminalId.value) return;
    await apiFetch(`/api/terminal/${terminalId.value}/interrupt`, { method: 'POST' }).catch(() => {});
  }

  async function clearTerminal(): Promise<void> {
    terminalLines.value = [];
    if (!terminalId.value) return;
    await apiFetch(`/api/terminal/${terminalId.value}/clear`, { method: 'POST' }).catch(() => {});
  }

  async function closeTerminal(): Promise<void> {
    terminalAbort?.abort();
    terminalAbort = null;
    const id = terminalId.value;
    terminalId.value = null;
    terminalLines.value = [];
    if (id) await apiFetch(`/api/terminal/${id}`, { method: 'DELETE' }).catch(() => {});
  }

  async function toggleTerminal(): Promise<void> {
    terminalOpen.value = !terminalOpen.value;
    if (terminalOpen.value) {
      await ensureTerminal();
      void loadSkills();
    }
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
  async function newSession(): Promise<void> {
    const session = await apiFetch<Session>('/api/sessions', { method: 'POST', body: JSON.stringify({}) });
    sessions.value.unshift(session);
    await selectSession(session.id);
  }

  async function selectSession(id: string): Promise<void> {
    if (currentId.value === id && eventTask) return;
    stopEvents();
    currentId.value = id;
    permissions.value = [];
    usage.value = null;
    error.value = '';
    attachments.value = [];
    await loadSessionData(id);
    connectEvents(id);
    void loadSkills();
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
    await apiFetch(`/api/sessions/${id}`, { method: 'DELETE' });
    sessions.value = sessions.value.filter(s => s.id !== id);
    if (currentId.value === id) {
      stopEvents();
      currentId.value = null;
      messages.value = [];
      if (sessions.value.length) await selectSession(sessions.value[0].id);
      else await newSession();
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
  }

  async function toggleKey(id: number, enabled: boolean): Promise<void> {
    await apiFetch(`/api/keys/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) });
    await Promise.all([loadKeys(), loadProviders(), loadModels()]);
  }

  async function removeKey(id: number): Promise<void> {
    await apiFetch(`/api/keys/${id}`, { method: 'DELETE' });
    await Promise.all([loadKeys(), loadProviders(), loadModels()]);
  }

  async function applyConnection(url: string, token: string): Promise<boolean> {
    setConnection(url, token);
    const health = await checkHealth();
    if (!health) return false;
    stopEvents();
    await bootstrapData();
    if (currentId.value) connectEvents(currentId.value);
    return true;
  }

  async function bootstrapData(): Promise<void> {
    await Promise.all([loadSessions(), loadModels(), loadProviders(), loadKeys(), loadSettings(), loadWorkspace()]);
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
    running, usage, error, ready, sidebarOpen, rightPanel,
    currentSession, selectedModel, usableModels, pendingPermission, connection,
    workspace, workspaceBusy, workspaceStale, activeWorkspace,
    attachments,
    skills, skillDirectories, skillsBusy, skillsLog,
    terminalOpen, terminalId, terminalCwd, terminalShell, terminalLines, terminalError, terminalBusy,
    bootstrap, loadTree, loadChanges, loadAnalytics,
    loadWorkspace, browseWorkspace, openWorkspace,
    addAttachment, removeAttachment, clearAttachments, attachDeviceFiles, kindOfName,
    loadSkills, installSkill, toggleSkill, removeSkill, pushSkillLog, pushTerminalLine,
    ensureTerminal, sendTerminal, interruptTerminal, clearTerminal, closeTerminal, toggleTerminal,
    newSession, selectSession, send, abort, resolvePermission, renameSession, deleteSession,
    setModel, setAgent, saveSettings, addKey, toggleKey, removeKey,
    applyConnection, clearError, checkHealth,
  };
});
