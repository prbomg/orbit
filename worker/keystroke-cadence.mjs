import { behaviorRandom } from './behavior-random.mjs';
// Simulated typing cadence, not measurements of a physical keyboard.
// Box–Muller gives a log-normal interval with a 110 ms median and a right tail.
export function sampleKeystrokeDelay(previous, character, random = behaviorRandom) {
  const normal = Math.sqrt(-2 * Math.log(Math.max(Number.EPSILON, random()))) * Math.cos(2 * Math.PI * random());
  const boundary = /\s/u.test(character) || (previous !== undefined && /\s/u.test(previous));
  const multiplier = boundary ? 1.3 + random() * .2 : 1;
  return Math.round(Math.max(45, Math.min(380, 110 * Math.exp(.42 * normal) * multiplier)));
}
