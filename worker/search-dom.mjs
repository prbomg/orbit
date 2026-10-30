import { selectors } from 'playwright';

// The engine must run in the page's main realm, where the element Map lives.
const ready = selectors.register('orbitSearchRef', () => ({
  query(root, token) {
    const element = window[Symbol.for('__ OrbitSearchRefs')]?.get(token);
    return element?.isConnected && root.contains(element) ? element : null;
  },
  queryAll(root, token) {
    const element = window[Symbol.for('__ OrbitSearchRefs')]?.get(token);
    return element?.isConnected && root.contains(element) ? [element] : [];
  },
}), { contentScript: false });
// Setup errors propagate at use, without an unhandled rejection at import time.
void ready.catch(() => {});

export async function prepareSearchReferences(page, reset = false, pruneNext = true) {
  await ready;
  await page.evaluate(({reset,pruneNext}) => {
    const symbol = Symbol.for('__ OrbitSearchRefs');
    if (!window[symbol]) Object.defineProperty(window, symbol, { value: new Map(), enumerable: false });
    const references = window[symbol];
    if (reset) references.clear();
    else if(pruneNext) for (const token of references.keys()) if (token.startsWith('next:')) references.delete(token);
  }, {reset,pruneNext});
}

export const ensurePageReferences = page => prepareSearchReferences(page, false, false);

export const searchReference = (page, token) => page.locator(`orbitSearchRef=${token}`);

// Only submission needs this override. Main-document forms with a same-tab
// target never receive an attribute write, including a redundant restoration.
export async function withSameTabForm(input, action, timeout) {
  const cleanup = await input.evaluateHandle(element => {
    const form = element.form ?? element.closest('form');
    if (!form) return () => {};
    const target = form.getAttribute('target');
    if (window === window.top && [null, '', '_self', '_top'].includes(target)) return () => {};
    if (target === '_top') return () => {};
    const restore = () => {
      if (target === null) form.removeAttribute('target');
      else form.setAttribute('target', target);
    };
    const onPageHide = () => { restore(); window.removeEventListener('pagehide', onPageHide); };
    window.addEventListener('pagehide', onPageHide, { once: true });
    form.setAttribute('target', '_top');
    return () => { window.removeEventListener('pagehide', onPageHide); restore(); };
  }, undefined, { timeout });
  try { return await action(); }
  finally {
    await cleanup.evaluate(restore => restore()).catch(() => {});
    await cleanup.dispose().catch(() => {});
  }
}

// Keep the existing same-tab Page contract without leaving target changes in
// live/AJAX documents or in a document frozen into the back/forward cache.
export async function withSameTabLink(locator, action, timeout) {
  const cleanup = await locator.evaluateHandle(element => {
    if (element.tagName !== 'A' || element.getAttribute('target') === '_self') return () => {};
    const target = element.getAttribute('target');
    const restore = () => {
      if (element.getAttribute('target') !== '_self') return;
      if (target === null) element.removeAttribute('target');
      else element.setAttribute('target', target);
    };
    const onPageHide = () => { restore(); window.removeEventListener('pagehide', onPageHide); };
    window.addEventListener('pagehide', onPageHide, { once: true });
    element.setAttribute('target', '_self');
    return () => { window.removeEventListener('pagehide', onPageHide); restore(); };
  }, undefined, { timeout });
  try { return await action(); }
  finally {
    // A destroyed realm has already run pagehide; its pinned handle is obsolete.
    await cleanup.evaluate(restore => restore()).catch(() => {});
    await cleanup.dispose().catch(() => {});
  }
}
