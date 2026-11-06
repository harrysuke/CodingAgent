import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  AgentMode, ApiKeyInfo, AppSettings, Message, ModelInfo, Part, PermissionRequest,
  Platform, Project, Session, TodoItem, Usage,
} from '@codingagent/shared';
import { DEFAULT_SETTINGS, PLATFORMS } from '@codingagent/shared';
import { getDb } from './client';
import { encrypt, decrypt, maskKey } from '../llm/keys';
import { providerCatalog, providerByPlatform } from '../llm/providers';
import { samePath } from '../workspace/paths';

type Row = Record<string, any>;
const now = () => new Date().toISOString();
const safeJson = (s: unknown, fallback: unknown = null) => {
  if (s === null || s === undefined || s === '') return fallback;
  try { return JSON.parse(String(s)); } catch { return fallback; }
};
const bool = (v: unknown) => v === 1 || v === true || v === '1';

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

const mapProject = (r: Row): Project => ({
  id: r.id, name: r.name, rootPath: r.root_path, createdAt: r.created_at, updatedAt: r.updated_at,
});

// Every row that belongs to an account is filtered by user_id. There is no
// "no user" fallback on purpose: a missing userId must never widen a query.
export function listProjects(userId: string): Project[] {
  return (getDb().prepare('SELECT * FROM projects WHERE user_id=? ORDER BY created_at').all(userId) as Row[]).map(mapProject);
}

export function getProject(id: string, userId: string): Project | null {
  const r = getDb().prepare('SELECT * FROM projects WHERE id=? AND user_id=?').get(id, userId) as Row | undefined;
  return r ? mapProject(r) : null;
}

export function createProject(name: string, rootPath: string, userId: string): Project {
  const id = randomUUID();
  getDb().prepare('INSERT INTO projects (id, name, root_path, user_id) VALUES (?,?,?,?)').run(id, name, rootPath, userId);
  return getProject(id, userId)!;
}

export function touchProject(id: string): void {
  getDb().prepare('UPDATE projects SET updated_at=? WHERE id=?').run(now(), id);
}

/** Case-insensitive on Windows/macOS: the same folder can arrive as C:\Foo or c:/foo. */
export function findProjectByPath(rootPath: string, userId: string): Project | null {
  const rows = getDb().prepare('SELECT * FROM projects WHERE user_id=?').all(userId) as Row[];
  return rows.map(mapProject).find(p => samePath(p.rootPath, rootPath)) ?? null;
}

const ACTIVE_PROJECT_KEY = 'agent:active_project';

/** The active workspace pointer is per account, not a single global setting. */
export function getActiveProjectId(userId: string): string | null {
  const row = getDb().prepare('SELECT value FROM agent_user_settings WHERE user_id=? AND key=?')
    .get(userId, ACTIVE_PROJECT_KEY) as Row | undefined;
  return row?.value || null;
}

export function setActiveProjectId(id: string, userId: string): void {
  getDb()
    .prepare('INSERT INTO agent_user_settings (user_id,key,value) VALUES (?,?,?) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value')
    .run(userId, ACTIVE_PROJECT_KEY, id);
}

/** The workspace the agent is currently bound to for this account. */
export function getActiveProject(userId: string): Project | null {
  const id = getActiveProjectId(userId);
  const active = id ? getProject(id, userId) : null;
  if (active) return active;
  return listProjects(userId)[0] ?? null;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

const mapSession = (r: Row): Session => ({
  id: r.id,
  projectId: r.project_id,
  title: r.title,
  modelPlatform: (r.model_platform ?? null) as Platform | null,
  modelId: r.model_id ?? null,
  agent: (r.agent ?? 'build') as AgentMode,
  status: (r.status ?? 'idle') as Session['status'],
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function listSessions(userId: string, projectId?: string): Session[] {
  const db = getDb();
  const rows = projectId
    ? db.prepare('SELECT * FROM agent_sessions WHERE user_id=? AND project_id=? ORDER BY updated_at DESC').all(userId, projectId) as Row[]
    : db.prepare('SELECT * FROM agent_sessions WHERE user_id=? ORDER BY updated_at DESC').all(userId) as Row[];
  return rows.map(mapSession);
}

export function getSession(id: string, userId: string): Session | null {
  const r = getDb().prepare('SELECT * FROM agent_sessions WHERE id=? AND user_id=?').get(id, userId) as Row | undefined;
  return r ? mapSession(r) : null;
}

/** Ownership lookup used by routes keyed by something other than a session id. */
export function sessionOwner(sessionId: string): string | null {
  const r = getDb().prepare('SELECT user_id FROM agent_sessions WHERE id=?').get(sessionId) as Row | undefined;
  return r?.user_id ?? null;
}

export function createSession(
  userId: string,
  input: { projectId?: string; title?: string; agent?: AgentMode } = {},
): Session {
  const db = getDb();
  // New sessions attach to the workspace that is currently open, so opening a
  // folder is what scopes the agent — not an implicit default directory.
  const project = input.projectId ? getProject(input.projectId, userId) : getActiveProject(userId);
  const projectId = project?.id ?? createProject('workspace', '', userId).id;
  const settings = getSettings(userId);
  const id = randomUUID();
  db.prepare(`
    INSERT INTO agent_sessions (id, project_id, title, model_platform, model_id, agent, status, history_json, user_id, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(id, projectId, input.title ?? 'New session', settings.defaultPlatform, settings.defaultModelId,
    input.agent ?? settings.agent, 'idle', '[]', userId, now(), now());
  return getSession(id, userId)!;
}

export function updateSession(
  userId: string,
  id: string,
  patch: Partial<Pick<Session, 'title' | 'agent' | 'modelPlatform' | 'modelId' | 'status'>>,
): Session | null {
  const db = getDb();
  const current = getSession(id, userId);
  if (!current) return null;
  const next = { ...current, ...patch };
  db.prepare(`UPDATE agent_sessions SET title=?, agent=?, model_platform=?, model_id=?, status=?, updated_at=? WHERE id=? AND user_id=?`)
    .run(next.title, next.agent, next.modelPlatform, next.modelId, next.status, now(), id, userId);
  return getSession(id, userId);
}

export function touchSession(id: string, status?: Session['status']): void {
  if (status) getDb().prepare('UPDATE agent_sessions SET updated_at=?, status=? WHERE id=?').run(now(), status, id);
  else getDb().prepare('UPDATE agent_sessions SET updated_at=? WHERE id=?').run(now(), id);
}

export function deleteSession(id: string, userId: string): boolean {
  return getDb().prepare('DELETE FROM agent_sessions WHERE id=? AND user_id=?').run(id, userId).changes > 0;
}

/** Raw ModelMessage[] from the AI SDK, persisted so multi-turn tool calls keep their context. */
export function getHistory(id: string): unknown[] {
  const r = getDb().prepare('SELECT history_json FROM agent_sessions WHERE id=?').get(id) as Row | undefined;
  return (safeJson(r?.history_json, []) as unknown[]) ?? [];
}

export function setHistory(id: string, history: unknown[]): void {
  getDb().prepare('UPDATE agent_sessions SET history_json=?, updated_at=? WHERE id=?')
    .run(JSON.stringify(history), now(), id);
}

// ---------------------------------------------------------------------------
// Messages & parts
// ---------------------------------------------------------------------------

const mapPart = (r: Row): Part => ({
  id: r.id,
  messageId: r.message_id,
  sessionId: r.session_id,
  seq: r.seq,
  type: r.type,
  state: r.state ?? undefined,
  text: r.text ?? '',
  toolCallId: r.tool_call_id ?? undefined,
  toolName: r.tool_name ?? undefined,
  input: safeJson(r.input_json, undefined) ?? undefined,
  output: safeJson(r.output_json, undefined) ?? undefined,
  createdAt: r.created_at,
});

export function getParts(sessionId: string): Part[] {
  return (getDb().prepare('SELECT * FROM agent_parts WHERE session_id=? ORDER BY created_at, seq').all(sessionId) as Row[]).map(mapPart);
}

export function getMessages(sessionId: string): Message[] {
  const db = getDb();
  const messages = db.prepare('SELECT * FROM agent_messages WHERE session_id=? ORDER BY seq').all(sessionId) as Row[];
  const parts = getParts(sessionId);
  return messages.map(r => ({
    id: r.id, sessionId: r.session_id, role: r.role, seq: r.seq, createdAt: r.created_at,
    parts: parts.filter(p => p.messageId === r.id).sort((a, b) => a.seq - b.seq),
  }));
}

export function createMessage(sessionId: string, role: 'user' | 'assistant', parts: Array<Partial<Part>> = []): Message {
  const db = getDb();
  const seqRow = db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS n FROM agent_messages WHERE session_id=?').get(sessionId) as { n: number };
  const id = randomUUID();
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO agent_messages (id, session_id, role, seq, created_at) VALUES (?,?,?,?,?)')
      .run(id, sessionId, role, seqRow.n, now());
    parts.forEach((p, i) => insertPart(db, id, sessionId, i + 1, p));
  });
  tx();
  touchSession(sessionId);
  return getMessages(sessionId).find(m => m.id === id)!;
}

function insertPart(db: Database.Database, messageId: string, sessionId: string, seq: number, p: Partial<Part>): string {
  const id = p.id ?? randomUUID();
  db.prepare(`
    INSERT INTO agent_parts (id, message_id, session_id, seq, type, state, text, tool_call_id, tool_name, input_json, output_json, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(id, messageId, sessionId, seq, p.type ?? 'text', p.state ?? 'completed', p.text ?? '',
    p.toolCallId ?? null, p.toolName ?? null,
    p.input === undefined ? null : JSON.stringify(p.input),
    p.output === undefined ? null : JSON.stringify(p.output), now());
  return id;
}

export function appendPart(messageId: string, sessionId: string, p: Partial<Part>): Part {
  const db = getDb();
  const seqRow = db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS n FROM agent_parts WHERE message_id=?').get(messageId) as { n: number };
  const id = insertPart(db, messageId, sessionId, seqRow.n, p);
  const row = db.prepare('SELECT * FROM agent_parts WHERE id=?').get(id) as Row;
  return mapPart(row);
}

export function appendText(partId: string, delta: string): Part {
  const db = getDb();
  db.prepare("UPDATE agent_parts SET text = text || ? WHERE id=?").run(delta, partId);
  return mapPart(db.prepare('SELECT * FROM agent_parts WHERE id=?').get(partId) as Row);
}

export function updatePart(partId: string, patch: Partial<Pick<Part, 'state' | 'text' | 'input' | 'output' | 'toolName' | 'toolCallId'>>): Part {
  const db = getDb();
  const current = mapPart(db.prepare('SELECT * FROM agent_parts WHERE id=?').get(partId) as Row);
  db.prepare('UPDATE agent_parts SET state=?, text=?, input_json=?, output_json=? WHERE id=?').run(
    patch.state ?? current.state ?? 'pending',
    patch.text ?? current.text ?? '',
    patch.input === undefined ? (current.input === undefined ? null : JSON.stringify(current.input)) : JSON.stringify(patch.input),
    patch.output === undefined ? (current.output === undefined ? null : JSON.stringify(current.output)) : JSON.stringify(patch.output),
    partId,
  );
  return mapPart(db.prepare('SELECT * FROM agent_parts WHERE id=?').get(partId) as Row);
}

export function findPartByToolCall(toolCallId: string): Part | null {
  const r = getDb().prepare('SELECT * FROM agent_parts WHERE tool_call_id=? ORDER BY created_at DESC LIMIT 1').get(toolCallId) as Row | undefined;
  return r ? mapPart(r) : null;
}

// ---------------------------------------------------------------------------
// Settings (per-account key/value table; global `settings` is legacy seed data)
// ---------------------------------------------------------------------------

export function getSettings(userId: string): AppSettings {
  const rows = getDb().prepare("SELECT key, value FROM agent_user_settings WHERE user_id=? AND key LIKE 'agent:%'").all(userId) as Row[];
  const map = new Map(rows.map(r => [r.key, r.value]));
  const str = (k: string, d: string) => map.get(k) ?? d;
  return {
    defaultPlatform: (map.get('agent:default_platform') || null) as Platform | null,
    defaultModelId: map.get('agent:default_model_id') || null,
    permissionMode: str('agent:permission_mode', DEFAULT_SETTINGS.permissionMode) as AppSettings['permissionMode'],
    agent: str('agent:agent', DEFAULT_SETTINGS.agent) as AgentMode,
    maxSteps: Number.parseInt(str('agent:max_steps', String(DEFAULT_SETTINGS.maxSteps)), 10) || DEFAULT_SETTINGS.maxSteps,
    theme: str('agent:theme', DEFAULT_SETTINGS.theme) as AppSettings['theme'],
    systemPromptSuffix: str('agent:system_prompt_suffix', ''),
  };
}

export function setSettings(userId: string, patch: Partial<AppSettings>): AppSettings {
  const db = getDb();
  const entries: Array<[string, string]> = [];
  if (patch.defaultPlatform !== undefined) entries.push(['agent:default_platform', patch.defaultPlatform ?? '']);
  if (patch.defaultModelId !== undefined) entries.push(['agent:default_model_id', patch.defaultModelId ?? '']);
  if (patch.permissionMode !== undefined) entries.push(['agent:permission_mode', patch.permissionMode]);
  if (patch.agent !== undefined) entries.push(['agent:agent', patch.agent]);
  if (patch.maxSteps !== undefined) entries.push(['agent:max_steps', String(patch.maxSteps)]);
  if (patch.theme !== undefined) entries.push(['agent:theme', patch.theme]);
  if (patch.systemPromptSuffix !== undefined) entries.push(['agent:system_prompt_suffix', patch.systemPromptSuffix]);
  const stmt = db.prepare('INSERT INTO agent_user_settings (user_id,key,value) VALUES (?,?,?) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value');
  db.transaction(() => entries.forEach(([k, v]) => stmt.run(userId, k, v)))();
  return getSettings(userId);
}

// ---------------------------------------------------------------------------
// Model catalog & provider keys (reused tables)
// ---------------------------------------------------------------------------

export function getModels(userId: string): ModelInfo[] {
  const rows = getDb().prepare(`
    SELECT m.*,
      EXISTS(SELECT 1 FROM api_keys k WHERE k.platform=m.platform AND k.enabled=1 AND k.user_id=?) AS has_key
    FROM models m ORDER BY m.enabled DESC, m.intelligence_rank ASC, m.display_name ASC
  `).all(userId) as Row[];
  return rows.map(r => ({
    id: r.id,
    platform: r.platform as Platform,
    modelId: r.model_id,
    displayName: r.display_name,
    intelligenceRank: r.intelligence_rank,
    speedRank: r.speed_rank,
    sizeLabel: r.size_label ?? '',
    contextWindow: r.context_window ?? null,
    enabled: bool(r.enabled),
    supportsVision: bool(r.supports_vision),
    supportsTools: bool(r.supports_tools),
    hasKey: bool(r.has_key),
  }));
}

export function getModel(platform: Platform, modelId: string, userId: string): ModelInfo | null {
  return getModels(userId).find(m => m.platform === platform && m.modelId === modelId) ?? null;
}

export function getFallbackChain(userId: string, limit = 5): ModelInfo[] {
  const rows = getDb().prepare(`
    SELECT m.* FROM fallback_config f JOIN models m ON m.id=f.model_db_id
    WHERE f.enabled=1 AND m.enabled=1 AND m.supports_tools=1
      AND EXISTS(SELECT 1 FROM api_keys k WHERE k.platform=m.platform AND k.enabled=1 AND k.user_id=?)
    ORDER BY f.priority ASC LIMIT ?
  `).all(userId, limit) as Row[];
  const all = getModels(userId);
  return rows.map(r => all.find(m => m.id === r.id)!).filter(Boolean);
}

export function getApiKeys(userId: string): ApiKeyInfo[] {
  const rows = getDb().prepare('SELECT * FROM api_keys WHERE user_id=? ORDER BY platform, id').all(userId) as Row[];
  return rows.map(r => {
    let maskedKey = '****';
    let decryptable = false;
    try {
      maskedKey = maskKey(decrypt(r.encrypted_key, r.iv, r.auth_tag));
      decryptable = true;
    } catch { maskedKey = '[decrypt failed - wrong ENCRYPTION_KEY]'; }
    return {
      id: r.id,
      platform: r.platform as Platform,
      label: r.label ?? '',
      maskedKey,
      status: r.status ?? 'unknown',
      enabled: bool(r.enabled),
      baseUrl: r.base_url ?? null,
      decryptable,
    };
  });
}

export function getProviderInfos(userId: string) {
  const models = getModels(userId);
  const keys = getApiKeys(userId);
  return providerCatalog.map(p => ({
    ...p,
    configured: keys.some(k => k.platform === p.platform && k.enabled && k.decryptable) || p.keyless,
    modelCount: models.filter(m => m.platform === p.platform).length,
  }));
}

export function addApiKey(
  userId: string,
  input: { platform: Platform; key: string; label?: string; baseUrl?: string },
): ApiKeyInfo {
  const { encrypted, iv, authTag } = encrypt(input.key);
  const info = getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url, user_id, created_at)
    VALUES (?,?,?,?,?, 'unknown', 1, ?, ?, ?)
  `).run(input.platform, input.label ?? '', encrypted, iv, authTag, input.baseUrl || null, userId, now());

  // BYOK onboarding: pick a tool-capable model from a provider this account
  // can actually pay for. Re-pick when the inherited default belongs to a
  // provider with no key on THIS account (e.g. a fresh desktop install with
  // an empty key ring), otherwise the composer would stay stuck on an unusable
  // model until the user visited Settings manually.
  const settings = getSettings(userId);
  const usable = getModels(userId).filter(m => m.enabled && m.supportsTools && m.hasKey);
  const defaultUsable = usable.some(m =>
    m.platform === settings.defaultPlatform && m.modelId === settings.defaultModelId);
  if ((!settings.defaultPlatform || !settings.defaultModelId || !defaultUsable) && usable.length) {
    const best = usable[0];
    setSettings(userId, { defaultPlatform: best.platform, defaultModelId: best.modelId });
  }
  return getApiKeys(userId).find(k => k.id === Number(info.lastInsertRowid))!;
}

export function setApiKeyEnabled(userId: string, id: number, enabled: boolean): void {
  getDb().prepare('UPDATE api_keys SET enabled=? WHERE id=? AND user_id=?').run(enabled ? 1 : 0, id, userId);
}

export function deleteApiKey(userId: string, id: number): boolean {
  return getDb().prepare('DELETE FROM api_keys WHERE id=? AND user_id=?').run(id, userId).changes > 0;
}

/**
 * Returns the decrypted credential for a platform, looked up ONLY in this
 * account's key ring. This is the boundary that makes BYOK real: there is no
 * code path that falls back to a shared/global key.
 */
export function resolveCredential(
  platform: Platform,
  userId: string,
): { apiKey: string; baseUrl: string; keyless: boolean } | null {
  const provider = providerByPlatform(platform);
  if (!provider) return null;
  const row = getDb().prepare(`
    SELECT * FROM api_keys WHERE platform=? AND enabled=1 AND user_id=? ORDER BY
      CASE status WHEN 'healthy' THEN 0 WHEN 'unknown' THEN 1 ELSE 2 END, id LIMIT 1
  `).get(platform, userId) as Row | undefined;

  if (provider.keyless) {
    return { apiKey: row ? tryDecrypt(row) : 'no-key', baseUrl: provider.baseUrl, keyless: true };
  }
  if (!row) return null;
  const key = tryDecrypt(row);
  if (!key) return null;
  const baseUrl = platform === 'custom' ? (row.base_url || provider.baseUrl) : provider.baseUrl;
  return { apiKey: key, baseUrl, keyless: false };
}

function tryDecrypt(row: Row): string {
  try { return decrypt(row.encrypted_key, row.iv, row.auth_tag); } catch { return ''; }
}

// ---------------------------------------------------------------------------
// Telemetry (reused `requests` table)
// ---------------------------------------------------------------------------

export function logRequest(input: {
  platform: Platform; modelId: string; status: string; sessionId?: string;
  inputTokens?: number; outputTokens?: number; latencyMs?: number; error?: string | null; agent?: AgentMode;
  keyId?: number | null; userId: string;
}): void {
  try {
    getDb().prepare(`
      INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, error, created_at, request_type, session_id, agent, user_id)
      VALUES (?,?,?,?,?,?,?,?,?,'agent',?,?,?)
    `).run(input.platform, input.modelId, input.keyId ?? null, input.status,
      input.inputTokens ?? 0, input.outputTokens ?? 0, input.latencyMs ?? 0, input.error ?? null,
      now(), input.sessionId ?? null, input.agent ?? 'build', input.userId);
  } catch { /* telemetry must never break a chat turn */ }
}

export function getAnalytics(userId: string) {
  const db = getDb();
  const totals = db.prepare(`
    SELECT COUNT(*) AS requests,
           SUM(input_tokens) AS input_tokens,
           SUM(output_tokens) AS output_tokens,
           ROUND(AVG(latency_ms)) AS avg_latency,
           SUM(CASE WHEN status!='success' THEN 1 ELSE 0 END) AS errors
    FROM requests WHERE user_id=?
  `).get(userId) as Row;
  const byPlatform = db.prepare(`
    SELECT platform, COUNT(*) AS requests, SUM(input_tokens+output_tokens) AS tokens
    FROM requests WHERE user_id=? GROUP BY platform ORDER BY requests DESC LIMIT 20
  `).all(userId) as Row[];
  return {
    requests: totals.requests ?? 0,
    inputTokens: totals.input_tokens ?? 0,
    outputTokens: totals.output_tokens ?? 0,
    avgLatencyMs: totals.avg_latency ?? 0,
    errors: totals.errors ?? 0,
    byPlatform: byPlatform.map(r => ({ platform: r.platform, requests: r.requests, tokens: r.tokens ?? 0 })),
  };
}

// ---------------------------------------------------------------------------
// Permissions & grants
// ---------------------------------------------------------------------------

const mapPermission = (r: Row): PermissionRequest => ({
  id: r.id, sessionId: r.session_id, toolCallId: r.tool_call_id, toolName: r.tool_name,
  input: safeJson(r.input_json, {}), status: r.status, createdAt: r.created_at,
});

export function createPermission(
  sessionId: string, toolCallId: string, toolName: string, input: unknown, userId: string,
): PermissionRequest {
  const id = randomUUID();
  getDb().prepare('INSERT INTO agent_permissions (id, session_id, tool_call_id, tool_name, input_json, status, created_at, user_id) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, sessionId, toolCallId, toolName, JSON.stringify(input ?? {}), 'pending', now(), userId);
  return mapPermission(getDb().prepare('SELECT * FROM agent_permissions WHERE id=?').get(id) as Row);
}

export function resolvePermission(
  id: string, status: PermissionRequest['status'], userId?: string,
): PermissionRequest | null {
  const db = getDb();
  const row = userId
    ? db.prepare('SELECT * FROM agent_permissions WHERE id=? AND user_id=?').get(id, userId) as Row | undefined
    : db.prepare('SELECT * FROM agent_permissions WHERE id=?').get(id) as Row | undefined;
  if (!row) return null;
  db.prepare('UPDATE agent_permissions SET status=?, resolved_at=? WHERE id=?').run(status, now(), id);
  if (status === 'approved_always') {
    db.prepare('INSERT OR REPLACE INTO agent_permission_grants (session_id, tool_name, pattern) VALUES (?,?,?)')
      .run(row.session_id, row.tool_name, '*');
  }
  return mapPermission(db.prepare('SELECT * FROM agent_permissions WHERE id=?').get(id) as Row);
}

export function pendingPermissions(sessionId: string): PermissionRequest[] {
  return (getDb().prepare("SELECT * FROM agent_permissions WHERE session_id=? AND status='pending' ORDER BY created_at").all(sessionId) as Row[]).map(mapPermission);
}

export function hasGrant(sessionId: string, toolName: string): boolean {
  return !!getDb().prepare('SELECT 1 FROM agent_permission_grants WHERE session_id=? AND tool_name=?').get(sessionId, toolName);
}

// ---------------------------------------------------------------------------
// Todos & file changes
// ---------------------------------------------------------------------------

export function getTodos(sessionId: string): TodoItem[] {
  return (getDb().prepare('SELECT * FROM agent_todos WHERE session_id=? ORDER BY seq').all(sessionId) as Row[])
    .map(r => ({ id: r.id, content: r.content, status: r.status, priority: r.priority }));
}

export function setTodos(sessionId: string, todos: Array<Omit<TodoItem, 'id'> & { id?: string }>): TodoItem[] {
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM agent_todos WHERE session_id=?').run(sessionId);
    const insert = db.prepare('INSERT INTO agent_todos (id, session_id, seq, content, status, priority) VALUES (?,?,?,?,?,?)');
    todos.forEach((t, i) => insert.run(t.id ?? `${sessionId}-${i}`, sessionId, i, t.content, t.status, t.priority));
  })();
  return getTodos(sessionId);
}

export function recordFileChange(sessionId: string, pathValue: string, before: string | null, after: string, toolName: string): void {
  getDb().prepare('INSERT INTO agent_file_changes (id, session_id, path, before_text, after_text, tool_name, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(randomUUID(), sessionId, pathValue, before, after, toolName, now());
}

export function getFileChanges(sessionId: string) {
  return (getDb().prepare('SELECT * FROM agent_file_changes WHERE session_id=? ORDER BY created_at DESC LIMIT 100').all(sessionId) as Row[])
    .map(r => ({ id: r.id, path: r.path, before: r.before_text, after: r.after_text, toolName: r.tool_name, createdAt: r.created_at }));
}

export function activePlatforms(userId: string): Platform[] {
  const configured = new Set(getApiKeys(userId).filter(k => k.enabled && k.decryptable).map(k => k.platform));
  return PLATFORMS.filter(p => configured.has(p) || providerByPlatform(p)?.keyless);
}

export function summarizeUsage(usage: Usage): Usage { return usage; }
