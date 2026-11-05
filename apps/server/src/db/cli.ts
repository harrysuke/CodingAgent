/** `npm run db:migrate` - applies the additive agent schema to the reused DB. */
import { initDb, closeDb, getDb } from './client';
import { env } from '../env';

initDb();
const db = getDb();
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
console.log(`Migrated ${env.dbPath}`);
console.log(`Tables (${tables.length}): ${tables.map(t => t.name).join(', ')}`);
for (const t of ['models', 'api_keys', 'agent_sessions', 'projects']) {
  const { n } = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number };
  console.log(`  ${t}: ${n} rows`);
}
closeDb();
