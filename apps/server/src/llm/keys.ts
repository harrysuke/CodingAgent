/**
 * AES-256-GCM helper, byte-for-byte compatible with the source FreeLLMAPI
 * project's `server/src/lib/crypto.ts`. The 16 api_keys rows copied into
 * codingagent.db were encrypted with the ENCRYPTION_KEY inherited from that
 * project's .env, so changing or losing that key makes them unreadable.
 */
import crypto from 'node:crypto';
import { env } from '../env';

const ALGORITHM = 'aes-256-gcm';

function key(): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(env.encryptionKey)) {
    throw new Error('Invalid ENCRYPTION_KEY (expected 64 hex chars). Run `npm run setup`.');
  }
  return Buffer.from(env.encryptionKey, 'hex');
}

export function encrypt(text: string): { encrypted: string; iv: string; authTag: string } {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key(), iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return { encrypted, iv: iv.toString('hex'), authTag: cipher.getAuthTag().toString('hex') };
}

export function decrypt(encrypted: string, iv: string, authTag: string): string {
  const decipher = crypto.createDecipheriv(ALGORITHM, key(), Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(authTag, 'hex'));
  let out = decipher.update(encrypted, 'hex', 'utf8');
  out += decipher.final('utf8');
  return out;
}

export function maskKey(value: string): string {
  if (value.length <= 8) return '****' + value.slice(-4);
  return value.slice(0, 4) + '...' + value.slice(-4);
}
