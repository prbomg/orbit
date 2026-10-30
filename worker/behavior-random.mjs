import { randomBytes, createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

const sessions = new AsyncLocalStorage();
// Behavior only, never credentials or identity material. Every production task
// receives fresh entropy; explicit seeds allow reproducible fixtures.
export function createBehaviorRandom(seed = randomBytes(32)) {
  if (!(typeof seed === 'string' || Buffer.isBuffer(seed)) || !seed.length) throw new TypeError('invalid_behavior_seed');
  const hash = createHash('sha256').update(seed).digest();
  let state = hash.readUInt32LE(0);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ state >>> 15, state | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}
const fallback = createBehaviorRandom();
export const behaviorRandom = () => (sessions.getStore() || fallback)();
export function withBehaviorRandom(random, action) {
  // The dispatcher is not a generator: storing it would recursively call itself.
  return sessions.run((random === behaviorRandom ? undefined : random) || sessions.getStore() || createBehaviorRandom(), action);
}
