import { createHash, randomBytes } from 'node:crypto';

export const GRAVITY = 9.80665;
const RAD = Math.PI / 180;
const vector = values => ({ x: values[0], y: values[1], z: values[2] });
const conjugate = q => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });
export function multiplyQuaternion(a, b) {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}
export function orientationQuaternion({ alpha, beta, gamma }) {
  const [a, b, g] = [alpha, beta, gamma].map(v => v * RAD / 2);
  // Device Orientation uses intrinsic Z-X'-Y'' rotations, not Z-Y-X.
  return multiplyQuaternion(multiplyQuaternion({ x: 0, y: 0, z: Math.sin(a), w: Math.cos(a) },
    { x: Math.sin(b), y: 0, z: 0, w: Math.cos(b) }), { x: 0, y: Math.sin(g), z: 0, w: Math.cos(g) });
}
function worldToDevice(q, value) {
  const result = multiplyQuaternion(multiplyQuaternion(conjugate(q), { ...value, w: 0 }), q);
  return { x: result.x, y: result.y, z: result.z };
}

function seededRandom(seed) {
  let state = createHash('sha256').update(String(seed)).digest().readUInt32BE();
  return () => {
    state += 0x6D2B79F5;
    let t = Math.imul(state ^ state >>> 15, 1 | state);
    t ^= t + Math.imul(t ^ t >>> 7, 61 | t);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
/** Synthetic QA motion. Bounds are design choices, not measured human traces. */
export function createMotionModel(seed = randomBytes(16).toString('hex')) {
  const random = seededRandom(seed), range = (a, b) => a + (b - a) * random();
  const wave = (amplitude, hz) => ({ amplitude, omega: 2 * Math.PI * hz, phase: range(0, 2 * Math.PI) });
  return {
    version: 2, mode: 'simulated', scenario: 'quiet-held-touch',
    base: { alpha: range(10, 350), beta: range(50, 75), gamma: range(-8, 8) },
    angular: Array.from({ length: 3 }, () => [wave(range(0.04, 0.18), range(0.12, 0.4)), wave(range(0.015, 0.07), range(0.4, 0.55))]),
    // Millimetres of slow world-frame translation; its second derivative is acceleration.
    translation: Array.from({ length: 3 }, () => [wave(range(0.001, 0.004), range(0.35, 0.8))]),
    cadence: { intervalMs: range(50, 54), jitterMs: 2, maximumSensorHz: 20 },
    reaction: { seed: String(seed), tau: range(.09, .16) },
  };
}
export function createMotionCadence(model) {
  const settings = model.cadence || { intervalMs: 52, jitterMs: 4, maximumSensorHz: 20 };
  const random = seededRandom(`cadence:${model.reaction?.seed ?? JSON.stringify(model.base)}`);
  return { ...settings, minMs: settings.intervalMs - settings.jitterMs, maxMs: settings.intervalMs + settings.jitterMs,
    next: () => settings.intervalMs + (random() * 2 - 1) * settings.jitterMs };
}

/** Three cascaded low-pass stages: bounded tilt and continuous position/velocity/acceleration. */
export function createTouchMotionResponse(model) {
  const random = seededRandom(`touch:${model.reaction?.seed ?? JSON.stringify(model.base)}`);
  const range = (a, b) => a + (b - a) * random(), tau = model.reaction?.tau ?? .12;
  const keys = ['beta', 'gamma', 'x', 'y', 'z'], zero = () => Object.fromEntries(keys.map(key => [key, 0]));
  let target = zero(), settled = zero(), events = [], gesture = null, lastMove = -Infinity, changes = 0, gestures = 0;
  const setTarget = (next, at) => {
    const expired = events.filter(event => at - event.at > 8);
    for (const event of expired) for (const key of keys) settled[key] += event.delta[key];
    events = events.filter(event => at - event.at <= 8);
    events.push({ at, delta: Object.fromEntries(keys.map(key => [key, next[key] - target[key]])) });
    target = next; changes++;
  };
  const touch = (type, point, seconds) => {
    if (!Number.isFinite(seconds)) throw new RangeError('Invalid touch motion time');
    if (type === 'touchStart') {
      if (!point || ![point.x, point.y].every(Number.isFinite)) return;
      const sign = () => random() < .5 ? -1 : 1;
      // The unit step's second derivative peaks at ~0.2306/tau².
      // Choose a bounded simulated acceleration, then derive displacement;
      // don't inject an unrelated acceleration on top of an angular signal.
      const scale = tau * tau / .2306;
      const displacement = worldToDevice(conjugate(orientationQuaternion(model.base)), { x: range(-.02, .02) * scale, y: range(.14, .26) * scale * sign(), z: range(.14, .26) * scale * sign() });
      gesture = { beta: range(.8, 2.2) * sign(), gamma: range(.8, 2.2) * sign(), ...displacement, point };
      lastMove = seconds; gestures++;
      setTarget(Object.fromEntries(keys.map(key => [key, gesture[key]])), seconds);
    } else if (type === 'touchMove' && gesture && point && [point.x, point.y].every(Number.isFinite) && seconds - lastMove >= .09) {
      const speed = Math.min(1, Math.hypot(point.x - gesture.point.x, point.y - gesture.point.y) / Math.max(1, (seconds - lastMove) * 1000));
      const strength = .65 + speed * .35;
      setTarget(Object.fromEntries(keys.map(key => [key, gesture[key] * strength])), seconds);
      gesture.point = point; lastMove = seconds;
    } else if (['touchEnd', 'touchCancel'].includes(type) && gesture) {
      setTarget(zero(), seconds); gesture = null;
    }
  };
  const sampleAt = seconds => {
    const offset = { ...settled }, worldAcceleration = { x: 0, y: 0, z: 0 };
    for (const event of events) {
      const u = (seconds - event.at) / tau;
      if (u <= 0) continue;
      const decay = Math.exp(-u), response = 1 - (1 + u + u * u / 2) * decay;
      const acceleration = (u - u * u / 2) * decay / (tau * tau);
      for (const key of keys) offset[key] += event.delta[key] * response;
      for (const key of ['x', 'y', 'z']) worldAcceleration[key] += event.delta[key] * acceleration;
    }
    return { beta: offset.beta, gamma: offset.gamma, displacement: { x: offset.x, y: offset.y, z: offset.z }, worldAcceleration };
  };
  return { touch, sampleAt, diagnostics: () => ({ active: Boolean(gesture), changes, gestures, retainedEvents: events.length }),
    clear: () => { target = zero(); settled = zero(); events = []; gesture = null; } };
}

export function motionAtTime(model, seconds, reaction) {
  if (!Number.isFinite(seconds)) throw new RangeError('Invalid motion time');
  const anglesAt = t => Object.fromEntries(['alpha', 'beta', 'gamma'].map((name, i) => [name,
    model.base[name] + model.angular[i].reduce((sum, w) => sum + w.amplitude * Math.sin(w.omega * t + w.phase), 0) + (name === 'alpha' ? 0 : reaction?.sampleAt(t)[name] || 0)]));
  const angles = anglesAt(seconds), quaternion = orientationQuaternion(angles);
  const delta = 0.0005;
  const before = orientationQuaternion(anglesAt(seconds - delta)), after = orientationQuaternion(anglesAt(seconds + delta));
  const derivative = Object.fromEntries(['x', 'y', 'z', 'w'].map(key => [key, (after[key] - before[key]) / (2 * delta)]));
  const velocity = multiplyQuaternion(conjugate(quaternion), derivative);
  const gyroscope = { x: velocity.x * 2, y: velocity.y * 2, z: velocity.z * 2 }; // rad/s
  const gravity = worldToDevice(quaternion, { x: 0, y: 0, z: GRAVITY });
  const translation = vector(model.translation.map(waves =>
    waves.reduce((sum, w) => sum - w.amplitude * w.omega ** 2 * Math.sin(w.omega * seconds + w.phase), 0)));
  const responseAcceleration = reaction?.sampleAt(seconds).worldAcceleration;
  if (responseAcceleration) for (const key of ['x', 'y', 'z']) translation[key] += responseAcceleration[key];
  const linearAcceleration = worldToDevice(quaternion, translation);
  const accelerometer = Object.fromEntries(['x', 'y', 'z'].map(key => [key, gravity[key] + linearAcceleration[key]])); // m/s²
  return { angles, quaternion, gyroscope, gravity, linearAcceleration, accelerometer };
}
