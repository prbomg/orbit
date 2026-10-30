import { performance } from 'node:perf_hooks';
import { sleep, TaskStoppedError } from './behavior.mjs';

const sessionHost = host => /^(?:sso|passport)\./i.test(host);

/** Finish a slow first-party session redirect without restarting it or the browser. */
export async function openSearchHome(page, home, {
  allowedHost, timeout, signal, shouldContinue = async () => true, log = () => {},
}) {
  const active = async () => { signal?.throwIfAborted(); if (!await shouldContinue()) throw new TaskStoppedError(); };
  const allowed = value => { try { return allowedHost(new URL(value).hostname); } catch { return false; } };
  const final = value => allowed(value) && !sessionHost(new URL(value).hostname);
  let progress = false, committed = false, response;
  const responded = value => {
    try {
      if (value.request().isNavigationRequest() && value.frame() === page.mainFrame() && allowed(value.url())) {
        progress = true; response = value;
      }
    } catch { /* A response may outlive its frame. */ }
  };
  const navigated = frame => { if (frame === page.mainFrame()) committed = true; };
  page.on('response', responded); page.on('framenavigated', navigated);
  try {
    await active();
    let timedOut;
    try { response = await page.goto(home, { waitUntil: 'load', timeout }); }
    catch (error) {
      await active();
      if (error.name !== 'TimeoutError' || !progress) throw error;
      timedOut = error;
    }
    if (!timedOut && final(page.url())) return response;
    if (!allowed(page.url()) && committed) throw timedOut || new Error('Search session redirected outside the allowed host');
    const budget = Math.min(timeout, 30_000), deadline = performance.now() + budget;
    log('search_home_waiting', { reason: sessionHost(new URL(page.url()).hostname) ? 'session_redirect' : 'document_loading', durationMs: budget });
    while (performance.now() < deadline) {
      await active();
      if (committed && !allowed(page.url())) throw timedOut || new Error('Search session redirected outside the allowed host');
      // A previous loaded search document must never satisfy a new navigation.
      if (committed) {
        try {
          await page.waitForURL(url => final(url.href), { waitUntil: 'load', timeout: Math.max(1, Math.min(500, deadline - performance.now())) });
          await active();
          log('search_home_recovered', { reason: 'navigation_completed' });
          return response?.url() === page.url() ? response : null;
        } catch (error) {
          await active();
          if (error.name !== 'TimeoutError') throw error;
        }
      } else await sleep(Math.min(100, Math.max(1, deadline - performance.now())), signal);
    }
    if (timedOut) throw timedOut;
    const error = new Error('Search session redirect did not finish within the navigation budget');
    error.name = 'TimeoutError'; throw error;
  } finally {
    page.off('response', responded); page.off('framenavigated', navigated);
  }
}
