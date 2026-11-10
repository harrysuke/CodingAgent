/**
 * Baseline (inherited) schema.
 *
 * These tables originally came from FreeLLMAPI and are reused verbatim by the
 * agent: the model catalog, encrypted provider keys, telemetry, the automatic
 * fallback chain, global settings, and the legacy dashboard auth tables.
 *
 * They are declared here so a **fresh clone with no `data/codingagent.db`** can
 * bootstrap itself: `npm run setup` only *copies* a database when a source
 * snapshot happens to exist, so anyone who downloads the repository from GitHub
 * starts with an empty `data/` directory. Without this file the very first
 * `initDb()` would fail with `no such table: requests`, because
 * `inheritedTableMigrations()` (and `seedAgentSettings()`) assume these tables
 * are already there.
 *
 * Rules for editing:
 *  - Every statement must be `CREATE TABLE/INDEX IF NOT EXISTS`, so running it
 *    against a pre-existing FreeLLMAPI database is a no-op.
 *  - Columns that later migrations add (`user_id`, `session_id`, `agent`, ...)
 *    are intentionally NOT declared here; `inheritedTableMigrations()` stays the
 *    single upgrade path for old databases and will add them for fresh ones too.
 */

export const BASE_SCHEMA_SQL = `
-- ---------------------------------------------------------------------------
-- Model catalog (drives the model picker, tool-capability filter, context size)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  model_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  intelligence_rank INTEGER NOT NULL,
  speed_rank INTEGER NOT NULL,
  size_label TEXT NOT NULL DEFAULT '',
  rpm_limit INTEGER,
  rpd_limit INTEGER,
  tpm_limit INTEGER,
  tpd_limit INTEGER,
  monthly_token_budget TEXT NOT NULL DEFAULT '',
  context_window INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  supports_vision INTEGER NOT NULL DEFAULT 0,
  supports_tools INTEGER NOT NULL DEFAULT 0,
  UNIQUE(platform, model_id)
);

-- ---------------------------------------------------------------------------
-- Provider credentials, AES-256-GCM encrypted (see llm/keys.ts)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  encrypted_key TEXT NOT NULL,
  iv TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unknown',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_checked_at TEXT,
  base_url TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_keys_platform ON api_keys(platform);

-- ---------------------------------------------------------------------------
-- Per-turn telemetry
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  model_id TEXT NOT NULL,
  key_id INTEGER,
  status TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  ttfb_ms INTEGER,
  request_type TEXT NOT NULL DEFAULT 'chat'
);
CREATE INDEX IF NOT EXISTS idx_requests_created_at ON requests(created_at);
CREATE INDEX IF NOT EXISTS idx_requests_platform ON requests(platform);
CREATE INDEX IF NOT EXISTS idx_requests_key_id ON requests(key_id);

-- ---------------------------------------------------------------------------
-- Rate-limit bookkeeping (kept for parity with the source schema)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rate_limit_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  model_id TEXT NOT NULL,
  key_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('request', 'tokens')),
  tokens INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_rate_limit_usage_lookup
  ON rate_limit_usage(platform, model_id, key_id, kind, created_at_ms);

CREATE TABLE IF NOT EXISTS rate_limit_cooldowns (
  platform TEXT NOT NULL,
  model_id TEXT NOT NULL,
  key_id INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (platform, model_id, key_id)
);
CREATE INDEX IF NOT EXISTS idx_rate_limit_cooldowns_expires ON rate_limit_cooldowns(expires_at_ms);

-- ---------------------------------------------------------------------------
-- Ordered automatic fallback chain
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fallback_config (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_db_id INTEGER NOT NULL REFERENCES models(id),
  priority INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  UNIQUE(model_db_id)
);

-- ---------------------------------------------------------------------------
-- Global settings (defaults only; per-account values live in agent_user_settings)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Legacy dashboard auth tables. Kept so an inherited database keeps working,
-- and so the schema stays identical for fresh installs. CodingAgent accounts
-- live in agent_users / agent_user_sessions instead - these are never used as
-- credentials.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- ---------------------------------------------------------------------------
-- Embedding model catalog (unused by the agent today, kept for parity)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS embedding_models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  family TEXT NOT NULL,
  platform TEXT NOT NULL,
  model_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  max_input_tokens INTEGER,
  priority INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  quota_label TEXT NOT NULL DEFAULT '',
  UNIQUE(platform, model_id)
);
`;

/**
 * Tables that must exist before the agent can serve a single request. Checked
 * after bootstrap so a partially-created or hand-edited database fails loudly
 * instead of surfacing as a mysterious 500 on the first chat turn.
 */
export const REQUIRED_INHERITED_TABLES = [
  'models',
  'api_keys',
  'requests',
  'rate_limit_usage',
  'rate_limit_cooldowns',
  'fallback_config',
  'settings',
  'users',
  'sessions',
  'embedding_models',
] as const;
