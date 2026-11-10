/**
 * `npm run db:migrate`
 *
 * Creates the SQLite database and every required table when they are missing,
 * or upgrades an inherited FreeLLMAPI snapshot in place. Safe to re-run: it
 * never drops data.
 */
import { initDb, closeDb, getDb, bootstrapReport } from './client';
import { env } from '../env';

initDb();
const db = getDb();
const report = bootstrapReport();
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];

console.log(`${report?.created ? 'Created' : 'Upgraded'} ${env.dbPath}`);
if (report?.seededModels) console.log(`Seeded ${report.seededModels} default models (catalog was empty).`);
console.log(`Tables (${tables.length}): ${tables.map(t => t.name).join(', ')}`);
for (const t of ['models', 'api_keys', 'agent_users', 'agent_sessions', 'projects']) {
  const { n } = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number };
  console.log(`  ${t}: ${n} rows`);
}
closeDb();
