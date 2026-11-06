/**
 * Rotate AGENT_TOKEN in .env.
 *
 * AGENT_TOKEN is no longer a shared UI credential: it is the one-time secret
 * used to create the first admin account (the account that claims pre-existing
 * provider keys). The shipped placeholder is public, so on any machine that
 * might be reachable from a LAN it must be replaced before first login.
 *
 * Safe to run repeatedly. Only the AGENT_TOKEN line is rewritten; every other
 * .env setting (especially ENCRYPTION_KEY) is preserved byte-for-byte.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, '.env');

if (!fs.existsSync(envPath)) {
  console.error('[rotate-setup-token] .env not found. Run `npm run setup` first.');
  process.exit(1);
}

const original = fs.readFileSync(envPath, 'utf8');
const token = crypto.randomBytes(24).toString('base64url');
const line = `AGENT_TOKEN=${token}`;
const updated = /^AGENT_TOKEN=.*$/m.test(original)
  ? original.replace(/^AGENT_TOKEN=.*$/m, line)
  : `${original.replace(/\s*$/, '')}\n${line}\n`;

fs.writeFileSync(envPath, updated, 'utf8');
console.log('[rotate-setup-token] AGENT_TOKEN replaced with a fresh random value.');
console.log('[rotate-setup-token] Restart the server, then use that value as the setup token when creating the first account.');
console.log('[rotate-setup-token] Existing logged-in sessions are unaffected.');
