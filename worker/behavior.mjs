import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';

export const randomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
export const sleep = (ms, signal) => delay(Math.max(0, ms), undefined, { signal });

export class TaskStoppedError extends Error {
  constructor() { super('Task is no longer active'); this.name = 'TaskStoppedError'; }
}

export function bezierPoint(t, p0, p1, p2, p3) {
  const s = 1 - t;
  return {
    x: s ** 3 * p0.x + 3 * s ** 2 * t * p1.x + 3 * s * t ** 2 * p2.x + t ** 3 * p3.x,
    y: s ** 3 * p0.y + 3 * s ** 2 * t * p1.y + 3 * s * t ** 2 * p2.y + t ** 3 * p3.y,
  };
}

export async function moveAlongBezier(page, from, to, { signal, durationMs = randomInt(500, 1300) } = {}) {
  const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
  const control = () => ({ x: randomInt(0, viewport.width - 1), y: randomInt(0, viewport.height - 1) });
  const p1 = control(); const p2 = control();
  const steps = Math.max(12, Math.min(70, Math.ceil(durationMs / 20)));
  const started = performance.now();
  for (let i = 1; i <= steps; i++) {
    signal?.throwIfAborted();
    const t = i / steps;
    const eased = t * t * (3 - 2 * t);
    const point = bezierPoint(eased, from, p1, p2, to);
    await page.mouse.move(point.x, point.y);
    await sleep(Math.max(0, started + durationMs * t - performance.now()), signal);
  }
  return to;
}
