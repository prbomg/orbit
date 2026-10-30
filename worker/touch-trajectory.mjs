import { behaviorRandom } from './behavior-random.mjs';
import { performance } from 'node:perf_hooks';
import { bezierPoint, sleep } from './behavior.mjs';

export const MAX_LATERAL_WOBBLE = 10;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const touchObservers = new WeakMap();
export function observeTouchActivity(page, listener) {
  let listeners = touchObservers.get(page);
  if (!listeners) touchObservers.set(page, listeners = new Set());
  listeners.add(listener);
  let removed = false;
  return () => { if (removed) return; removed = true; listeners.delete(listener); if (!listeners.size && touchObservers.get(page) === listeners) touchObservers.delete(page); };
}
/** Publish only successfully dispatched input; optional observers never delay a gesture. */
export async function dispatchTouchEvent(page, cdp, type, touchPoints) {
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
  const activity = { type, point: touchPoints[0], at: performance.now() };
  for (const listener of touchObservers.get(page) || []) {
    try { listener(activity); } catch { /* Optional sensor simulation must not break input. */ }
  }
}

// Gesture-level simulation settings, not measurements of a physical device.
// Keep one contact/id throughout a swipe; smooth bounded variation avoids
// independently resampling its shape and pressure on every move.
export function createTouchContact(random = behaviorRandom) {
  const radiusX = 11 + random() * 4.5;
  const minimumY = Math.max(12, radiusX + .7);
  const radiusY = minimumY + random() * (17 - minimumY);
  const force = .42 + random() * .36;
  let started = false, dx = 0, dy = 0, df = 0;
  return (x, y) => {
    if (started) {
      dx += ((random() * .6 - .3) - dx) * .35;
      dy += ((random() * .6 - .3) - dy) * .35;
      df += ((random() * .04 - .02) - df) * .35;
    }
    started = true;
    return { x, y, id: 0, radiusX: radiusX + dx, radiusY: radiusY + dy, force: clamp(force + df, 0, 1) };
  };
}

// Box–Muller gives a log-normal hold with a 90 ms median and a small >200 ms tail.
// The upper bound avoids accidentally turning an ordinary tap into a long press.
export function sampleTapDuration(random = behaviorRandom) {
  const normal = Math.sqrt(-2 * Math.log(Math.max(Number.EPSILON, random()))) * Math.cos(2 * Math.PI * random());
  return Math.round(clamp(90 * Math.exp(.48 * normal), 50, 350));
}

export function gestureProfile(pixels, { mode = 'auto', height = 740, durationMs, random = behaviorRandom } = {}) {
  const distance = Math.abs(pixels);
  if (!Number.isFinite(distance) || !Number.isFinite(height) || height <= 0) throw new RangeError('Invalid gesture dimensions');
  if (!['auto', 'precise', 'reading', 'flick'].includes(mode)) throw new RangeError('Unknown gesture mode');
  if (durationMs !== undefined && (!Number.isFinite(durationMs) || durationMs <= 0)) throw new RangeError('Invalid gesture duration');
  if (mode === 'auto') mode = distance <= 100 ? 'precise' : distance > height * .8 ? 'flick' : 'reading';
  return {
    mode,
    durationMs: durationMs === undefined
      ? (mode === 'precise'
          ? clamp(150 + distance * .8, 150, 320)
          : mode === 'flick'
            ? Math.round(95 + random() * 95)     // 95–190 мс для хлесткого свайпа
            : Math.round(180 + random() * 240))  // 180–420 мс для чтения
      : Math.max(80, durationMs),
    maxDistance: Math.max(1, Math.min(height * (mode === 'precise' ? .3 : .45), 420)),
  };
}

export function touchCurve({ fromX, fromY, toX, toY, lateralWobble = MAX_LATERAL_WOBBLE, random = behaviorRandom }) {
  const dx = toX - fromX, dy = toY - fromY, length = Math.hypot(dx, dy);
  const wobble = Math.min(MAX_LATERAL_WOBBLE, Math.max(0, lateralWobble), length * .04);
  const side = random() < .5 ? -1 : 1;
  const nx = length ? -dy / length : 0, ny = length ? dx / length : 0;
  const control = (t, sign) => {
    const offset = sign * wobble * (.5 + random() * .5);
    return { x: fromX + dx * t + nx * offset, y: fromY + dy * t + ny * offset };
  };
  return [{ x: fromX, y: fromY }, control(1 / 3, side), control(2 / 3, -side), { x: toX, y: toY }];
}

// Accelerate from rest, then decelerate to a small release velocity. A precise
// correction stops fully; reading/flick gestures retain energy for inertia.
export function swipeProgress(t, mode = 'reading') {
  const release = mode === 'precise' ? 0 : mode === 'flick' ? .8 : .55;
  return (release - 2) * t ** 3 + (3 - release) * t ** 2;
}

/** Advance by actual elapsed time, dropping obsolete samples after a delayed send. */
export async function dispatchTouchPath(send, {
  fromX, fromY, toX, toY, durationMs, mode = 'reading', lateralWobble, random,
  signal, now = () => performance.now(), wait = ms => sleep(ms, signal),
}) {
  if (!Number.isFinite(durationMs) || durationMs <= 0 || ![fromX, fromY, toX, toY].every(Number.isFinite)) throw new RangeError('Invalid touch path');
  const curve = touchCurve({ fromX, fromY, toX, toY, lateralWobble, random });
  const start = now(), samples = [{ time: start, y: fromY }];
  let moves = 0, t = 0;
  do {
    signal?.throwIfAborted();
    await wait(Math.max(1, Math.min(24, durationMs - (now() - start))));
    signal?.throwIfAborted();
    t = Math.min(1, Math.max(t, (now() - start) / durationMs));
    const point = t === 1 ? curve[3] : bezierPoint(swipeProgress(t, mode), ...curve);
    await send(point);
    samples.push({ time: now(), y: point.y });
    while (samples.length > 2 && samples[1].time < now() - 80) samples.shift();
    moves++;
  } while (t < 1);
  const first = samples[0], last = samples.at(-1);
  return { moves, elapsedMs: now() - start, mode, releaseVelocityY: mode === 'precise' ? 0 : (last.y - first.y) / Math.max(1, last.time - first.time) * 1000 };
}

/** px/s, seconds, pixels: D = K*v0² and tau = D/|v0| keep both laws consistent. */
export function inertiaProfile(velocity, { coefficient = .0008, maxDistance = 420 } = {}) {
  if (![velocity, coefficient, maxDistance].every(Number.isFinite) || coefficient <= 0 || maxDistance < 0) throw new RangeError('Invalid inertia parameters');
  const speed = Math.abs(velocity), distance = Math.min(maxDistance, coefficient * speed ** 2);
  const tauMs = speed ? distance / speed * 1000 : 0;
  return { distance: Math.sign(velocity) * distance, tauMs, durationMs: tauMs * 5 };
}

export function inertiaDistance(profile, elapsedMs) {
  return profile.tauMs ? profile.distance * (1 - Math.exp(-Math.max(0, elapsedMs) / profile.tauMs)) : 0;
}
