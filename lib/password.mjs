import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
const derive = promisify(scrypt);
const options = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) throw new Error('Password must contain 12–256 characters');
  const salt = randomBytes(16).toString('hex');
  const hash = await derive(password, salt, 64, options);
  return `scrypt:${salt}:${hash.toString('hex')}`;
}
export async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || password.length > 256) return false;
  const parts = typeof stored === 'string' ? stored.split(':') : [];
  const valid = parts.length === 3 && parts[0] === 'scrypt' && /^[a-f0-9]{32}$/.test(parts[1]) && /^[a-f0-9]{128}$/.test(parts[2]);
  // Do the same expensive work for unknown accounts and incorrect passwords.
  const actual = await derive(password, valid ? parts[1] : '0'.repeat(32), 64, options);
  const expected = Buffer.from(valid ? parts[2] : '0'.repeat(128), 'hex');
  return timingSafeEqual(actual, expected) && valid;
}
