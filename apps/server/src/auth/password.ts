/**
 * Password hashing with Node's built-in scrypt — no native module, no new
 * dependency, and a deliberately memory-hard KDF.
 *
 * Format: `scrypt$<salt-hex>$<hash-hex>`. The shape matches the legacy
 * FreeLLMAPI dashboard hashes, but those live in the untouched `users` table
 * and are never accepted as CodingAgent credentials.
 */
import crypto from 'node:crypto';

const N = 16_384;
const R = 8;
const P = 1;
const KEYLEN = 64;
const MAXMEM = 64 * 1024 * 1024;
const SALT_BYTES = 16;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(SALT_BYTES);
  const hash = crypto.scryptSync(password, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = (stored ?? '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  try {
    const salt = Buffer.from(parts[1], 'hex');
    const expected = Buffer.from(parts[2], 'hex');
    if (salt.length !== SALT_BYTES || expected.length !== KEYLEN) return false;
    const actual = crypto.scryptSync(password, salt, expected.length, { N, r: R, p: P, maxmem: MAXMEM });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
