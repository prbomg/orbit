import { getPageSession } from './page-session.mjs';

// Browser-process interception runs before even a popup's first redirect. Page
// sessions attach too late for that response. Scope by native BrowserContext id;
// leave subframes and other contexts alone. Never disable the HTTP cache.
export async function guardNavigationRedirects(context, allowed) {
  if (typeof context.pages !== 'function') return async () => {};
  const browser = context.browser();
  if (!browser?.newBrowserCDPSession) throw Error('navigation_guard_unavailable');
  const root = await browser.newBrowserCDPSession();
  let probe, disposed = false, contextId, cleanup;
  const paused = async event => {
    let permitted = true;
    try {
      const location = event.responseHeaders?.find(header => header.name.toLowerCase() === 'location')?.value;
      if (!disposed && [301,302,303,307,308].includes(event.responseStatusCode) && location) {
        // A subframe without its own target cannot be a top-level navigation.
        const { targetInfo } = await root.send('Target.getTargetInfo', { targetId: event.frameId });
        if (targetInfo.type === 'page' && targetInfo.browserContextId === contextId) {
          const method = event.responseStatusCode === 303 || [301,302].includes(event.responseStatusCode) && event.request.method === 'POST' ? 'GET' : event.request.method;
          try { permitted = allowed(new URL(location, event.request.url).href, { method }); }
          catch { permitted = false; }
        }
      }
    } catch { /* Detached targets/subframes have no owned main-frame redirect. */ }
    await root.send(permitted ? 'Fetch.continueRequest' : 'Fetch.failRequest', {
      requestId: event.requestId, ...(!permitted ? { errorReason: 'BlockedByClient' } : {}),
    }).catch(() => {});
  };
  const dispose = () => cleanup ||= (async () => {
    disposed = true; context.off('close', onClose);
    await root.send('Fetch.disable').catch(() => {});
    root.off('Fetch.requestPaused', paused);
    await root.detach().catch(() => {});
  })();
  const onClose = () => { void dispose(); };
  try {
    let page = context.pages()[0];
    if (!page) page = probe = await context.newPage();
    const session = await getPageSession(page);
    const { targetInfo } = await session.send('Target.getTargetInfo');
    contextId = targetInfo.browserContextId;
    root.on('Fetch.requestPaused', paused);
    context.once('close', onClose);
    await root.send('Fetch.enable', { patterns: [{ resourceType: 'Document', requestStage: 'Response' }] });
    return dispose;
  } catch (error) { await dispose(); throw error; }
  finally { await probe?.close().catch(() => {}); }
}
