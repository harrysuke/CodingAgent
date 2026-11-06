/**
 * Additive schema for the coding agent.
 *
 * Everything here is CREATE TABLE IF NOT EXISTS / guarded ALTER, so it is safe
 * to run against the database inherited from FreeLLMAPI. The original tables
 * (models, api_keys, requests, settings, fallback_config, embedding_models,
 * users, sessions, rate_limit_*) are kept verbatim and actively reused:
 *
 *   models          -> model picker, tool-capability filter, context window
 *   api_keys        -> AES-256-GCM encrypted provider credentials
 *   fallback_config -> ordered automatic fallback chain when a model fails
 *   requests        -> per-turn token/latency telemetry
 *   settings        -> agent preferences (agent:* keys) + encryption_key
 *
 * Note: the inherited `sessions` table is the old dashboard auth session
 * table, so agent conversations live in `agent_sessions` to avoid a clash.
 */
export const AGENT_SCHEMA_SQL = `
-- ---------------------------------------------------------------------------
-- Accounts. Deliberately separate from the inherited FreeLLMAPI users /
-- sessions dashboard tables: those carry old password hashes and session
-- tokens we must never accept as CodingAgent credentials.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

-- Only the SHA-256 hash of the bearer token is stored, so a database dump
-- cannot be replayed as a live session.
CREATE TABLE IF NOT EXISTS agent_user_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES agent_users(id) ON DELETE CASCADE,
  expires_at_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_agent_user_sessions_user ON agent_user_sessions(user_id);

-- Per-account preferences + the active project pointer. Global settings
-- rows are used only as defaults for keys an account has not set itself.
CREATE TABLE IF NOT EXISTS agent_user_settings (
  user_id TEXT NOT NULL REFERENCES agent_users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);

-- ---------------------------------------------------------------------------
-- Projects (workspace roots the agent may operate on)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- Conversations
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'New session',
  model_platform TEXT,
  model_id TEXT,
  agent TEXT NOT NULL DEFAULT 'build',
  status TEXT NOT NULL DEFAULT 'idle',
  history_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_updated ON agent_sessions(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_project ON agent_sessions(project_id);

CREATE TABLE IF NOT EXISTS agent_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  seq INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(session_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_agent_messages_session ON agent_messages(session_id, seq);

CREATE TABLE IF NOT EXISTS agent_parts (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES agent_messages(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  text TEXT NOT NULL DEFAULT '',
  tool_call_id TEXT,
  tool_name TEXT,
  input_json TEXT,
  output_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(message_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_agent_parts_message ON agent_parts(message_id, seq);
CREATE INDEX IF NOT EXISTS idx_agent_parts_tool_call ON agent_parts(tool_call_id);

-- ---------------------------------------------------------------------------
-- Human-in-the-loop permission requests for mutating tools
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_permissions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  input_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_permissions_session ON agent_permissions(session_id, status);

-- Per-session "always allow" grants (tool name, optionally path-scoped).
CREATE TABLE IF NOT EXISTS agent_permission_grants (
  session_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  pattern TEXT NOT NULL DEFAULT '*',
  PRIMARY KEY (session_id, tool_name, pattern)
);

-- ---------------------------------------------------------------------------
-- Todo list maintained by the agent
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_todos (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  priority TEXT NOT NULL DEFAULT 'medium'
);
CREATE INDEX IF NOT EXISTS idx_agent_todos_session ON agent_todos(session_id, seq);

-- ---------------------------------------------------------------------------
-- File changes produced by write/edit, for the review / revert UI
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_file_changes (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  path TEXT NOT NULL,
  before_text TEXT,
  after_text TEXT,
  tool_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_agent_file_changes_session ON agent_file_changes(session_id, created_at);
`;

/** Columns added to the *inherited* tables (SQLite has no ADD COLUMN IF NOT EXISTS). */
export function inheritedTableMigrations(db: import('better-sqlite3').Database): void {
  const cols = (table: string): Set<string> =>
    new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name));

  if (!cols('requests').has('session_id')) {
    db.prepare('ALTER TABLE requests ADD COLUMN session_id TEXT').run();
  }
  if (!cols('requests').has('agent')) {
    db.prepare("ALTER TABLE requests ADD COLUMN agent TEXT NOT NULL DEFAULT 'build'").run();
  }
  db.prepare("CREATE INDEX IF NOT EXISTS idx_requests_session ON requests(session_id)").run();

  if (!cols('api_keys').has('base_url')) {
    db.prepare('ALTER TABLE api_keys ADD COLUMN base_url TEXT').run();
  }
  if (!cols('models').has('supports_tools')) {
    db.prepare('ALTER TABLE models ADD COLUMN supports_tools INTEGER NOT NULL DEFAULT 0').run();
  }

  // --- ownership columns -------------------------------------------------
  // Nullable on purpose: rows created before accounts existed stay invisible
  // until the first admin claims them. Every query filters on user_id, so a
  // NULL row can never be used by a regular account.
  const ownedTables = ['api_keys', 'projects', 'agent_sessions', 'agent_permissions', 'requests'];
  for (const table of ownedTables) {
    if (!cols(table).has('user_id')) {
      db.prepare(`ALTER TABLE ${table} ADD COLUMN user_id TEXT`).run();
    }
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_${table}_user ON ${table}(user_id)`).run();
  }
}
