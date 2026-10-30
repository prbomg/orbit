// Only fixed, non-sensitive routes are retained; query, fragment and credentials never are.
export function safeSearchLocation(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return { url: null, pagePath: null };
    const pagePath = /^\/(?:search(?:\/touch)?|showcaptcha|checkcaptcha)?\/?$/i.test(url.pathname) ? url.pathname : '/[redacted]';
    return { url: `${url.origin}${pagePath}`, pagePath };
  } catch { return { url: null, pagePath: null }; }
}

export async function inspectSearchPage(page) {
  const before = page.url();
  const location = safeSearchLocation(before);
  if (page.isClosed()) return { ...location, pageType: 'closed' };
  try {
    const pageType = await page.evaluate(() => {
      const body = document.body?.innerText || '';
      if (document.querySelector('#checkbox-captcha-form, .CheckboxCaptcha, .AdvancedCaptcha, .smart-captcha, form[action*="checkcaptcha"], iframe[src*="captcha"]') ||
          /^\/(?:showcaptcha|checkcaptcha)/i.test(location.pathname) || /Подтвердите,\s*что\s*запросы\s*отправляли\s*вы|Вы\s*не\s*робот\?/i.test(body)) return 'captcha';
      if (document.title.includes('429') || /^Too Many Requests$/i.test(body.trim())) return 'rate_limited';
      if (document.readyState === 'loading' || !document.body) return 'loading';
      if (/^\/search(?:\/|$)/i.test(location.pathname)) return 'serp';
      if (location.pathname === '/' && document.querySelector('input[name="text"], textarea[name="text"], input[name="q"]')) return 'home';
      return 'other';
    });
    return page.url() === before ? { ...location, pageType } : { ...safeSearchLocation(page.url()), pageType: 'changing' };
  } catch { return { ...safeSearchLocation(page.url()), pageType: page.isClosed() ? 'closed' : 'unknown' }; }
}

// One recovery token per search session, shared by the original and refined query.
export function createPaginationRecovery({ active, inspect, document, waitForResults, restore, isCurrentSerp, makeRateLimitError, log }) {
  let used = false;
  return async (error, pageNumber) => {
    await active();
    if (used || pageNumber <= 1 || error.code !== 'search_results_timeout') throw error;
    used = true;
    const before = await inspect();
    log('search_pagination_recovery_started', { page: pageNumber, attempt: 1, pageType: before.pageType });
    await document(); // Existing captcha handling and HTTP policy remain authoritative.
    await active();
    const state = await inspect();
    if (state.pageType === 'serp' && isCurrentSerp()) {
      try {
        await waitForResults();
        log('search_pagination_recovered', { page: pageNumber, method: 'current_page' });
        return { restarted: false };
      } catch (retryError) {
        await active();
        if (retryError.code !== 'search_results_timeout') throw retryError;
      }
    }
    // A plain rate limit or closed page must not trigger another search request.
    if (state.pageType === 'rate_limited') throw makeRateLimitError();
    if (state.pageType === 'closed') throw error;
    await active();
    await restore(); // Caller resubmits the exact query once, with submit's retries disabled.
    await waitForResults();
    log('search_pagination_recovered', { page: 1, method: 'home' });
    return { restarted: true };
  };
}
