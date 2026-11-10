import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { env, assertEncryptionKey } from '../env';
import { AGENT_SCHEMA_SQL, AGENT_TABLES, inheritedTableMigrations } from './schema';
import { BASE_SCHEMA_SQL, REQUIRED_INHERITED_TABLES } from './baseSchema';
import { seedModelCatalog } from './seed-models';

let db: Database.Database | null = null;

/** Set by initDb() on the first boot of an empty database; read by the CLI/logs. */
let bootstrap: { created: boolean; seededModels: number; tables: string[] } | null = null;

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

export function bootstrapReport(): { created: boolean; seededModels: number; tables: string[] } | null {
  return bootstrap;
}

function tableNames(instance: Database.Database): string[] {
  return (instance
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string }[]).map(r => r.name);
}

/**
 * Opens the SQLite database and makes sure every table the app needs exists.
 *
 * This runs on every start, and it is the whole first-run story for someone who
 * just cloned the repository:
 *
 *   1. `data/` is created if missing (gitignored, so it never ships).
 *   2. Baseline inherited tables are created (`CREATE TABLE IF NOT EXISTS`).
 *   3. Additive `agent_*` tables are created the same way.
 *   4. Guarded `ALTER TABLE`s upgrade a database inherited from an older
 *      FreeLLMAPI snapshot (`user_id`, `session_id`, `agent`, ...).
 *   5. Seeds: default project, global settings, and - only when the model
 *      catalog is empty - a small default model list.
 *   6. The resulting table set is verified, so a broken file fails loudly here
 *      instead of as a `no such table` 500 on the first request.
 *
 * Everything is idempotent: an existing database is opened untouched, and no
 * user data is ever dropped.
 */
export function initDb(dbPath = env.dbPath): Database.Database {
  if (db) return db;
  assertEncryptionKey();

  const createdFile = !fs.existsSync(dbPath) || fs.statSync(dbPath).size === 0;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  let instance: Database.Database;
  try {
    instance = new Database(dbPath);
  } catch (err) {
    throw new Error(
      `Cannot open the SQLite database at ${dbPath}. It exists but is not a readable SQLite file ` +
      `(a half-copied download or a WAL file without its database?). Move it aside and restart - ` +
      `a fresh database will be created. Original error: ${(err as Error).message}`,
    );
  }

  try {
    instance.pragma('journal_mode = WAL');
    instance.pragma('foreign_keys = ON');
    instance.pragma('busy_timeout = 5000');

    const hadTables = tableNames(instance).length > 0;

    // DDL is idempotent, so a partial run is harmless: the next start picks up
    // where this one stopped. Seeds are wrapped in their own transaction.
    instance.exec(BASE_SCHEMA_SQL);
    instance.exec(AGENT_SCHEMA_SQL);
    inheritedTableMigrations(instance);

    let seededModels = 0;
    instance.transaction(() => {
      seedDefaultProject(instance);
      seedAgentSettings(instance);
      seededModels = seedModelCatalog(instance);
    })();

    assertSchema(instance);

    bootstrap = { created: createdFile || !hadTables, seededModels, tables: tableNames(instance) };
    if (bootstrap.created) {
      console.log(
        `[db] Created ${dbPath} with ${bootstrap.tables.length} tables` +
        (seededModels ? ` and ${seededModels} default models.` : '.'),
      );
    }
  } catch (err) {
    instance.close();
    throw err;
  }

  db = instance;
  return instance;
}

/** Fails fast when the schema is incomplete instead of at query time. */
function assertSchema(instance: Database.Database): void {
  const present = new Set(tableNames(instance));
  const missing = [...REQUIRED_INHERITED_TABLES, ...AGENT_TABLES].filter(t => !present.has(t));
  if (missing.length) {
    throw new Error(
      `Database schema is incomplete - missing table(s): ${missing.join(', ')}. ` +
      `Delete the file and restart to rebuild it, or run \`npm run db:migrate\`.`,
    );
  }
}

function seedDefaultProject(instance: Database.Database): void {
  fs.mkdirSync(env.workspaceRoot, { recursive: true });
  const row = instance.prepare('SELECT id FROM projects ORDER BY created_at LIMIT 1').get() as { id: string } | undefined;
  if (!row) {
    instance.prepare('INSERT INTO projects (id, name, root_path) VALUES (?, ?, ?)').run(
      'default', path.basename(env.workspaceRoot) || 'workspace', env.workspaceRoot,
    );
  }
}

const DEFAULT_SETTING_KEYS: Record<string, string> = {
  'agent:permission_mode': env.permissionMode,
  'agent:agent': 'build',
  'agent:max_steps': String(env.maxSteps),
  'agent:theme': 'light',
  'agent:system_prompt_suffix': '',
};

function seedAgentSettings(instance: Database.Database): void {
  const insert = instance.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  const tx = instance.transaction(() => {
    for (const [key, value] of Object.entries(DEFAULT_SETTING_KEYS)) insert.run(key, value);
    // Pick a sensible default model: tool-capable, enabled, best intelligence rank,
    // and only where a usable provider key exists.
    const existing = instance.prepare("SELECT value FROM settings WHERE key='agent:default_platform'").get();
    if (!existing) {
      const best = instance.prepare(`
        SELECT m.platform, m.model_id FROM models m
        WHERE m.enabled = 1 AND m.supports_tools = 1
          AND EXISTS (SELECT 1 FROM api_keys k WHERE k.platform = m.platform AND k.enabled = 1)
        ORDER BY m.intelligence_rank ASC, m.speed_rank ASC LIMIT 1
      `).get() as { platform: string; model_id: string } | undefined;
      if (best) {
        instance.prepare("INSERT INTO settings (key, value) VALUES ('agent:default_platform', ?)").run(best.platform);
        instance.prepare("INSERT INTO settings (key, value) VALUES ('agent:default_model_id', ?)").run(best.model_id);
      }
    }
  });
  tx();
}

export function closeDb(): void {
  if (db) { db.close(); db = null; }
}
