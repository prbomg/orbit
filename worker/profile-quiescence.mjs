import { getPageSession } from './page-session.mjs';

// Snapshot only after donor documents have stopped writing storage/cookies.
// Keep a blank native window alive so closing the last site does not clear
// session cookies. Offline applies only to the terminal save phase.
export async function quiesceProfilePages(context, { signal } = {}) {
  signal?.throwIfAborted();
  const pages = context.pages();
  const keeper = pages[0] || await context.newPage();
  const targets = pages.length ? pages : [keeper];
  try {
    signal?.throwIfAborted();
    // Stop scheduled donor execution before leaving the document. Lifecycle
    // callbacks may finish synchronously during navigation; offline stays on
    // the original target until browser shutdown, blocking their network IO.
    for (const page of targets) {
      signal?.throwIfAborted();
      await (await getPageSession(page)).send('Emulation.setScriptExecutionDisabled', { value: true });
    }
    await context.setOffline(true);
    for (const page of targets) {
      signal?.throwIfAborted();
      // Keep the original target/session alive: detaching its Network agent
      // removes offline conditions while browser-process keepalive requests may
      // still be pending. A blank document has no live donor JS or workers.
      if (page.url() !== 'about:blank') await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 3000 });
    }
    // Native stop prevents timers in installed workers changing IndexedDB while
    // it is exported. This browser is dedicated to this profile/run.
    const session = await getPageSession(keeper);
    await session.send('ServiceWorker.enable');
    try { await session.send('ServiceWorker.stopAllWorkers'); }
    finally { await session.send('ServiceWorker.disable'); }
    signal?.throwIfAborted();
    return keeper;
  } catch (error) { await keeper.close().catch(() => {}); throw error; }
}
