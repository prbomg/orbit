import { sameSite } from './navigation-site.mjs';
import searchTasks from '../utils/searchTask.js';

/** Keep project runs on the project site and the selected search engine's pages. */
export function matchesHost(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

export async function restrictOwnedNavigation(context, targetUrl, searchEngine = false) {
  let temporarySite;
  const targetHost = new URL(targetUrl).hostname;
  const searchHosts = searchTasks.searchEngineDomains(searchEngine);
  await context.route('**/*', async route => {
    const request = route.request();
    if (request.isNavigationRequest()) {
      let frame;
      try { frame = request.frame(); } catch { /* Popup request can precede frame creation. */ }
      if (!frame || !frame.parentFrame()) {
        const url = new URL(request.url());
        const owned = matchesHost(url.hostname, targetHost);
        const search = searchHosts.some(host => matchesHost(url.hostname, host));
        const donor = temporarySite && request.method() === 'GET' && sameSite(url.href, temporarySite);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (!owned && !search && !donor)) {
          await route.abort('blockedbyclient'); return;
        }
      }
    }
    await route.fallback();
  });
  return { allowTemporarySite(origin) {
    temporarySite = origin;
    return () => { temporarySite = undefined; };
  } };
}
