import { performance } from 'node:perf_hooks';
import { sleep } from './behavior.mjs';
import { inertiaDistance, inertiaProfile } from './touch-trajectory.mjs';

const position = state => state.evaluate(s => s.node === document.scrollingElement ? scrollY : s.node.scrollTop);

/** Finish one release before the next contact; never add to an existing fling. */
export async function finishTouchScroll(state, {
  releasePosition, velocity, maxDistance, signal, check = async () => {}, settleTimeoutMs = 1800,
}) {
  const started = performance.now();
  let previous = releasePosition, stableSince = started, native = false, checkedAt = started;
  // Observe at least 96 ms to include compositor-delayed scroll updates.
  while (performance.now() - started < settleTimeoutMs) {
    signal?.throwIfAborted();
    if (performance.now() - checkedAt >= 100) { await check(); checkedAt = performance.now(); }
    const current = await position(state);
    if (Math.abs(current - previous) > .5) { native = true; stableSince = performance.now(); }
    previous = current;
    if (performance.now() - stableSince >= (native ? 120 : 96)) break;
    await sleep(24, signal);
  }
  signal?.throwIfAborted();
  if (native) return { method: 'native', settled: performance.now() - stableSince >= 120 };
  if (performance.now() - stableSince < 96) return { method: 'none', settled: false };
  // No artificial movement after a blocked/preventDefault drag or in precise mode.
  const eligible = await state.evaluate(s => {
    const first = s.nodes[0], style = getComputedStyle(s.node);
    return s.node.isConnected && !/hidden|clip/.test(style.overflowY) && Math.abs((first.root ? scrollY : first.el.scrollTop) - first.top) > .5;
  });
  const model = inertiaProfile(velocity, { maxDistance });
  if (!eligible || Math.abs(model.distance) < 1) return { method: 'none', settled: true };
  await check();
  const start = performance.now(), origin = previous;
  let applied = 0;
  while (performance.now() - start < model.durationMs) {
    signal?.throwIfAborted();
    await sleep(Math.min(16, Math.max(1, model.durationMs - (performance.now() - start))), signal);
    if (performance.now() - checkedAt >= 100) { await check(); checkedAt = performance.now(); }
    signal?.throwIfAborted();
    const distance = inertiaDistance(model, performance.now() - start);
    const result = await state.evaluate((s, { expected, desired }) => {
      const node = s.node, root = node === document.scrollingElement;
      const before = root ? scrollY : node.scrollTop;
      // Yield if a script, snap animation, or a late native fling takes over.
      if (!node.isConnected || Math.abs(before - expected) > 1.5 || /hidden|clip/.test(getComputedStyle(node).overflowY)) return { stopped: true, interrupted: true, position: before };
      node.scrollTo({ top: desired, behavior: 'instant' });
      const after = root ? scrollY : node.scrollTop;
      return { stopped: Math.abs(after - before) < .5 && Math.abs(desired - before) >= 1, position: after };
    }, { expected: origin + applied, desired: origin + distance });
    applied = result.position - origin;
    if (result.interrupted) return { method: 'exponential', settled: false };
    if (result.stopped) break;
  }
  signal?.throwIfAborted();
  return { method: 'exponential', settled: true };
}
