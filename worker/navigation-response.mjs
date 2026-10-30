// Each entry belongs to one main-frame navigation request, never to a URL cache.
export function trackNavigationResponses(context) {
  const states = new WeakMap(), pages = new Map();
  const withoutHash = value => { const url = new URL(value); url.hash = ''; return url.href; };
  const attach = page => {
    if (pages.has(page)) return;
    const navigated = frame => {
      if (frame !== page.mainFrame()) return;
      const state = states.get(page);
      try {
        if (state?.response && withoutHash(state.response.url()) === withoutHash(frame.url())) state.committed = true;
      } catch { /* Detached or non-HTTP documents have no usable response. */ }
    };
    page.on('framenavigated', navigated); pages.set(page, navigated);
  };
  const mainPage = request => {
    try {
      if (!request.isNavigationRequest()) return null;
      const frame = request.frame();
      return frame.parentFrame() ? null : frame.page();
    } catch { return null; }
  };
  const requested = request => {
    const page = mainPage(request);
    if (page) { attach(page); states.set(page, { request, response: null, committed: false, navigationId: (states.get(page)?.navigationId || 0) + 1 }); }
  };
  const responded = response => {
    const request = response.request(), page = mainPage(request);
    if (!page) return;
    const state = states.get(page);
    if (!state || state.request === request) { attach(page); states.set(page, { request, response, committed: false, navigationId: state?.navigationId || 1 }); }
  };
  for (const page of context.pages()) attach(page);
  context.on('page', attach);
  context.on('request', requested); context.on('response', responded);
  return {
    current(page) {
      const state = states.get(page), response = state?.response;
      if (!state?.committed || !response) return null;
      try { return withoutHash(response.url()) === withoutHash(page.url()) ? response : null; }
      catch { return null; }
    },
    navigation(page) { return states.get(page)?.response || null; },
    describe(page) {
      const state = states.get(page), current = this.current(page), response = current || state?.response;
      return { navigationId: state?.navigationId || 0, responseScope: current ? 'document' : response ? 'navigation' : 'unknown',
        ...(response ? { status: response.status(), responseDomain: new URL(response.url()).hostname } : {}) };
    },
    dispose() {
      context.off('page', attach); context.off('request', requested); context.off('response', responded);
      for (const [page, listener] of pages) page.off('framenavigated', listener);
      pages.clear();
    },
  };
}
