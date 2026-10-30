import { behaviorRandom } from './behavior-random.mjs';
import { sleep } from './behavior.mjs';
import { sampleTapDuration, dispatchTouchEvent, createTouchContact } from './touch-trajectory.mjs';
import { getPageSession } from './page-session.mjs';

/** A cancellable native tap, shared by locator and coordinate based input. */
export async function touchTap(page, x, y, { signal, random = behaviorRandom, durationMs = sampleTapDuration(random) } = {}) {
  if (![x, y, durationMs].every(Number.isFinite) || durationMs < 50 || durationMs > 350) throw new RangeError('Invalid touch tap');
  signal?.throwIfAborted();
  const cdp = await getPageSession(page);
  const contact = createTouchContact(random);
  let touching = false;
  try {
    signal?.throwIfAborted();
    touching = true;
    await dispatchTouchEvent(page, cdp, 'touchStart', [contact(x, y)]);
    await sleep(durationMs, signal);
    signal?.throwIfAborted();
    await dispatchTouchEvent(page, cdp, 'touchEnd', []);
    touching = false;
  } finally {
    if (touching) await dispatchTouchEvent(page, cdp, 'touchCancel', []).catch(() => {});
  }
}
