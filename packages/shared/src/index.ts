/**
 * Shared contract between the Node agent engine and the Vue/Tauri client.
 * The Platform/Model/ApiKey shapes intentionally mirror the FreeLLMAPI
 * database we inherited, so the 108 seeded models and 16 encrypted provider
 * keys can be consumed without any data conversion.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Providers & models (columns come straight from `models` / `api_keys`)
// ---------------------------------------------------------------------------

export const PLATFORMS = [
  'google', 'groq', 'cerebras', 'sambanova', 'nvidia', 'mistral',
  'openrouter', 'github', 'cohere', 'cloudflare', 'zhipu', 'ollama',
  'kilo', 'pollinations', 'llm7', 'huggingface', 'opencode', 'custom',
] as const;

export type Platform = (typeof PLATFORMS)[number];

export const PlatformSchema = z.enum(PLATFORMS);

export interface ModelInfo {
  id: number;
  platform: Platform;
  modelId: string;
  displayName: string;
  intelligenceRank: number;
  speedRank: number;
  sizeLabel: string;
  contextWindow: number | null;
  enabled: boolean;
  supportsVision: boolean;
  supportsTools: boolean;
  hasKey: boolean;
}

export interface ProviderInfo {
  platform: Platform;
  name: string;
  baseUrl: string;
  keyless: boolean;
  configured: boolean;
  modelCount: number;
}

export interface ApiKeyInfo {
  id: number;
  platform: Platform;
  label: string;
  maskedKey: string;
  status: string;
  enabled: boolean;
  baseUrl: string | null;
  decryptable: boolean;
}

// ---------------------------------------------------------------------------
// Workspace / sessions / messages / parts
// ---------------------------------------------------------------------------

export type AgentMode = 'build' | 'plan' | 'general';
export type PermissionMode = 'ask' | 'allow' | 'deny';
export type SessionStatus = 'idle' | 'running' | 'error';

export interface Project {
  id: string;
  name: string;
  rootPath: string;
  createdAt: string;
  updatedAt: string;
}

export interface Session {
  id: string;
  projectId: string;
  title: string;
  modelPlatform: Platform | null;
  modelId: string | null;
  agent: AgentMode;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
}

export type PartState = 'pending' | 'running' | 'completed' | 'error' | 'denied';
export type PartType = 'text' | 'reasoning' | 'tool' | 'step' | 'error' | 'attachment';

export interface Part {
  id: string;
  messageId: string;
  sessionId: string;
  type: PartType;
  seq: number;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  state?: PartState;
  input?: unknown;
  output?: unknown;
  createdAt: string;
}

export interface Message {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant';
  seq: number;
  createdAt: string;
  parts: Part[];
}

export interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  priority: 'low' | 'medium' | 'high';
}

// ---------------------------------------------------------------------------
// Attachments (explicit context the user pins to a single turn)
// ---------------------------------------------------------------------------

/** What the client asks the server to read: a workspace-relative path or an absolute one. */
export interface AttachmentInput {
  path: string;
  /** Display name override (used for device files read in the browser). */
  name?: string;
  /** True when the file lives outside the workspace root and was picked explicitly. */
  external?: boolean;
  /** Inline content for files the browser could read but cannot expose a real path for. */
  content?: string;
}

/** What the server resolved and actually fed to the model. */
export interface Attachment {
  path: string;
  name: string;
  size: number;
  content: string;
  truncated: boolean;
  external: boolean;
  /** Lower-case extension without the dot, e.g. "ts", or "file". */
  kind: string;
  /** Rough token estimate (chars / 4) so the UI can show prompt cost. */
  tokens: number;
}

export const AttachmentInputSchema = z.object({
  path: z.string().min(1),
  name: z.string().max(260).optional(),
  external: z.boolean().optional(),
  content: z.string().optional(),
});

export const ResolveAttachmentsSchema = z.object({
  paths: z.array(AttachmentInputSchema).min(1).max(24),
  /** Resolve relative paths against this session's workspace root. */
  sessionId: z.string().optional(),
});

export interface ResolveAttachmentsResult {
  attachments: Attachment[];
  errors: Array<{ path: string; error: string }>;
}

// ---------------------------------------------------------------------------
// Workspace (the sandboxed project home the agent is bound to)
// ---------------------------------------------------------------------------

export interface DirEntry {
  name: string;
  path: string;
  isGit: boolean;
  hasChildren: boolean;
}

export interface BrowseResult {
  /** Absolute path currently being browsed. */
  path: string;
  /** Parent directory, or null at a filesystem root. */
  parent: string | null;
  separator: string;
  /** Quick jump targets: drives on Windows, common folders elsewhere. */
  roots: Array<{ name: string; path: string }>;
  entries: DirEntry[];
  error?: string;
}

export interface WorkspaceInfo {
  project: Project;
  root: string;
  exists: boolean;
  isGit: boolean;
  branch: string | null;
  fileCount: number;
  dirCount: number;
  skillCount: number;
  /** Total size of tracked files in bytes (best effort, ignores node_modules). */
  bytes: number;
}

export interface WorkspaceState {
  active: WorkspaceInfo | null;
  recent: WorkspaceInfo[];
  defaultRoot: string;
}

export const OpenWorkspaceSchema = z.object({
  path: z.string().min(1, 'A folder path is required'),
  name: z.string().max(120).optional(),
  /**
   * When present, the folder is bound to this one session only. Omitting it
   * keeps the legacy account-wide "active workspace" behaviour.
   */
  sessionId: z.string().min(1).optional(),
});

// ---------------------------------------------------------------------------
// Agent Skills (installed from the terminal, injected into the system prompt)
// ---------------------------------------------------------------------------

export type SkillScope = 'workspace' | 'user';

export interface SkillInfo {
  /** `<scope>:<slug>` — stable across restarts. */
  id: string;
  slug: string;
  name: string;
  description: string;
  version: string;
  scope: SkillScope;
  enabled: boolean;
  /** Where it came from: "git <url>", "local <path>", "builtin". */
  source: string;
  /** Tools this skill narrows the agent down to (empty = all tools). */
  allowedTools: string[];
  /** Default arguments merged into tool calls, e.g. { bash: { timeoutMs: 300000 } }. */
  toolDefaults: Record<string, Record<string, unknown>>;
  /** Markdown body injected under "Installed Agent Skills". */
  instructions: string;
  path: string;
  installedAt: string | null;
}

export interface SkillsResponse {
  skills: SkillInfo[];
  /** Directories scanned, so the UI can explain where skills come from. */
  directories: Array<{ scope: SkillScope; path: string }>;
}

export const InstallSkillSchema = z.object({
  /** Git URL, github shorthand (`owner/repo`), `builtin:<name>`, or a local path. */
  source: z.string().min(1, 'A git URL or local path is required'),
  /** Install for this workspace (default) or for the current user. */
  scope: z.enum(['workspace', 'user']).optional(),
  /** Overwrite an existing skill with the same slug. */
  force: z.boolean().optional(),
  /** Resolve the workspace root from this session's project. */
  sessionId: z.string().optional(),
});

export const ToggleSkillSchema = z.object({
  enabled: z.boolean(),
  sessionId: z.string().optional(),
});

export interface InstallSkillResult {
  installed: SkillInfo[];
  log: string[];
  skills: SkillInfo[];
}

// ---------------------------------------------------------------------------
// Terminal (persistent shell used to install skills and run commands)
// ---------------------------------------------------------------------------

export type TerminalStream = 'stdout' | 'stderr' | 'system' | 'input';

export interface TerminalChunk {
  terminalId: string;
  stream: TerminalStream;
  data: string;
  at: string;
}

export interface TerminalState {
  id: string;
  cwd: string;
  shell: string;
  running: boolean;
  createdAt: string;
}

export interface PermissionRequest {
  id: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
  status: 'pending' | 'approved' | 'denied' | 'approved_always';
  createdAt: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface AppSettings {
  defaultPlatform: Platform | null;
  defaultModelId: string | null;
  permissionMode: PermissionMode;
  agent: AgentMode;
  maxSteps: number;
  theme: 'light' | 'dark' | 'system';
  systemPromptSuffix: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  defaultPlatform: null,
  defaultModelId: null,
  permissionMode: 'ask',
  agent: 'build',
  maxSteps: 30,
  theme: 'light',
  systemPromptSuffix: '',
};

// ---------------------------------------------------------------------------
// Accounts, login and BYOK
//
// Every provider key belongs to exactly one account. A freshly registered
// account owns zero keys, so it cannot spend anybody else's quota until it
// adds its own key in Settings > Providers & keys.
// ---------------------------------------------------------------------------

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  isAdmin: boolean;
  /** Number of enabled, decryptable keys this account owns. */
  keyCount: number;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface AuthStatus {
  /** False until the first admin account has been created. */
  needsSetup: boolean;
  registrationOpen: boolean;
  /** True when the server still allows non-admin shell access. */
  userShellEnabled: boolean;
  /**
   * The one-time setup secret is still the shipped placeholder. Only surfaced
   * while `needsSetup` is true, so it cannot help an attacker after setup.
   */
  setupTokenIsDefault: boolean;
}

export interface AuthResult {
  token: string;
  expiresAt: number;
  user: AuthUser;
}

export const LoginSchema = z.object({
  email: z.string().email('Enter a valid email address').max(254),
  password: z.string().min(1, 'Password is required').max(200),
});

export const RegisterSchema = z.object({
  email: z.string().email('Enter a valid email address').max(254),
  password: z.string().min(8, 'Use at least 8 characters').max(200),
  name: z.string().trim().max(80).optional(),
  /**
   * Required only for the very first account. Equals AGENT_TOKEN from .env,
   * so a stranger who reaches a fresh server cannot claim the owner's keys.
   */
  setupToken: z.string().max(200).optional(),
});

export const ChangePasswordSchema = z.object({
  current: z.string().min(1).max(200),
  next: z.string().min(8, 'Use at least 8 characters').max(200),
});

// ---------------------------------------------------------------------------
// Request DTOs
// ---------------------------------------------------------------------------

export const CreateSessionSchema = z.object({
  projectId: z.string().optional(),
  /**
   * Folder to claim as this session's own workspace. The server validates it,
   * registers it as a project and binds only the new session to it.
   */
  rootPath: z.string().min(1).optional(),
  title: z.string().max(200).optional(),
  agent: z.enum(['build', 'plan', 'general']).optional(),
});

export const UpdateSessionSchema = z.object({
  title: z.string().max(200).optional(),
  agent: z.enum(['build', 'plan', 'general']).optional(),
  modelPlatform: PlatformSchema.nullable().optional(),
  modelId: z.string().nullable().optional(),
});

export const ChatRequestSchema = z.object({
  /** Empty is allowed when at least one file is attached ("apply this to that"). */
  text: z.string().max(50_000).default(''),
  modelPlatform: PlatformSchema.optional(),
  modelId: z.string().optional(),
  agent: z.enum(['build', 'plan', 'general']).optional(),
  maxSteps: z.number().int().min(1).max(100).optional(),
  /**
   * Files the user pinned to this turn. The server reads them itself (unless
   * inline `content` is supplied for files the browser could read but whose
   * absolute path it cannot know), so the prompt gets exactly what the user
   * attached instead of a whole-workspace scan.
   */
  attachments: z.array(AttachmentInputSchema).max(24).optional(),
}).refine(
  value => value.text.trim().length > 0 || (value.attachments?.length ?? 0) > 0,
  { message: 'Message cannot be empty: write an instruction or attach a file.' },
);

export type ChatRequest = z.infer<typeof ChatRequestSchema>;

export const PermissionResolveSchema = z.object({
  decision: z.enum(['approved', 'denied', 'approved_always']),
});

export const SettingsSchema = z.object({
  defaultPlatform: PlatformSchema.nullable().optional(),
  defaultModelId: z.string().nullable().optional(),
  permissionMode: z.enum(['ask', 'allow', 'deny']).optional(),
  agent: z.enum(['build', 'plan', 'general']).optional(),
  maxSteps: z.number().int().min(1).max(100).optional(),
  theme: z.enum(['light', 'dark', 'system']).optional(),
  systemPromptSuffix: z.string().max(8000).optional(),
});

export const CreateKeySchema = z.object({
  platform: PlatformSchema,
  key: z.string().min(1),
  label: z.string().max(120).optional(),
  baseUrl: z.string().url().optional().or(z.literal('')),
});

export interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size?: number;
  children?: FileNode[];
}

export interface DiffResult {
  path: string;
  before: string;
  after: string;
  patch: string;
}

// ---------------------------------------------------------------------------
// Server-sent events (agent -> UI)
// ---------------------------------------------------------------------------

export type AgentEvent =
  | { type: 'session'; session: Session }
  | { type: 'message'; message: Message }
  | { type: 'part'; part: Part }
  | { type: 'part-delta'; partId: string; field: 'text' | 'reasoning'; delta: string }
  | { type: 'part-state'; partId: string; state: PartState; output?: unknown }
  | { type: 'permission'; permission: PermissionRequest }
  | { type: 'permission-resolved'; permissionId: string; status: PermissionRequest['status'] }
  | { type: 'todos'; todos: TodoItem[] }
  | { type: 'file-changed'; path: string }
  | { type: 'usage'; usage: Usage }
  | { type: 'error'; message: string }
  | { type: 'done'; reason: string; usage?: Usage };

export interface HealthResponse {
  ok: boolean;
  name: string;
  version: string;
  /** Empty for unauthenticated callers so the local path is not disclosed. */
  dbPath: string;
  models: number;
  providersConfigured: number;
  workspaceRoot: string;
  /** Display name of the workspace currently opened as the agent's home. */
  workspaceName?: string;
  projectId?: string;
  /** Whether a logged-in account was attached to this request. */
  authenticated?: boolean;
  requiresAuth?: boolean;
  /**
   * Advertised by builds that bind a project folder to each session. A missing
   * flag means the running server is older than the UI and silently ignores
   * `rootPath` / `sessionId`, so the client must refuse folder changes instead
   * of letting the agent write into whichever folder the account pointer names.
   */
  sessionWorkspaces?: boolean;
}
