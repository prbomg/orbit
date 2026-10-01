/** Keep managed project runs on the project site and the authorised Yandex search pages. */
export function matchesHost(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

export async function restrictOwnedNavigation(context, targetUrl, allowYandex) {
  const targetHost = new URL(targetUrl).hostname;
  const searchHosts = ['ya.ru', 'yandex.ru', 'yandex.com'];
  await context.route('**/*', async route => {
    const request = route.request();
    if (request.isNavigationRequest()) {
      let frame;
      try { frame = request.frame(); } catch { /* Popup request can precede frame creation. */ }
      if (!frame || !frame.parentFrame()) {
        const url = new URL(request.url());
        const owned = matchesHost(url.hostname, targetHost);
        const search = allowYandex && searchHosts.some(host => matchesHost(url.hostname, host));
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (!owned && !search)) {
          await route.abort('blockedbyclient'); return;
        }
      }
    }
    await route.fallback();
  });
}
