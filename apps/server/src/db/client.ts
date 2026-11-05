import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { env, assertEncryptionKey } from '../env';
import { AGENT_SCHEMA_SQL, inheritedTableMigrations } from './schema';

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

export function initDb(dbPath = env.dbPath): Database.Database {
  if (db) return db;
  assertEncryptionKey();

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const instance = new Database(dbPath);
  instance.pragma('journal_mode = WAL');
  instance.pragma('foreign_keys = ON');
  instance.pragma('busy_timeout = 5000');

  instance.exec(AGENT_SCHEMA_SQL);
  inheritedTableMigrations(instance);
  seedDefaultProject(instance);
  seedAgentSettings(instance);

  db = instance;
  return instance;
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
