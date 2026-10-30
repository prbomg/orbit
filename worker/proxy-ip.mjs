import { setTimeout as delay } from 'node:timers/promises';
import { isIP } from 'node:net';
import { randomUUID } from 'node:crypto';

export const DEFAULT_PROXY_IP_URL = 'https://api.ipify.org?format=json';
const observations = new Map();
export class ProxyIPCheckError extends Error {
  constructor(reason) { super('Browser IP check failed'); this.name = 'ProxyIPCheckError'; this.code = 'proxy_ip_check_failed'; this.reason = reason; }
}

export function parsePublicIP(body) {
  if (typeof body !== 'string' || body.length > 4096) throw new ProxyIPCheckError('invalid_response');
  let value = body.trim();
  if (value.startsWith('{')) {
    try { value = JSON.parse(value).ip; } catch { throw new ProxyIPCheckError('invalid_response'); }
  }
  if (typeof value !== 'string' || !isIP(value.trim())) throw new ProxyIPCheckError('invalid_response');
  value = value.trim();
  return isIP(value) === 6 ? new URL(`http://[${value}]/`).hostname.slice(1, -1) : value;
}

export function ipCheckURL(value = DEFAULT_PROXY_IP_URL) {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.hash || !(url.protocol === 'https:' || url.protocol === 'http:' && local)) throw new Error('Invalid WORKER_PROXY_IP_CHECK_URL');
  return url;
}

/** Navigate a temporary page in the TASK context, never a separate HTTP client. */
export async function observeBrowserIP(context, { url = DEFAULT_PROXY_IP_URL, timeoutMs = 5000, signal } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new RangeError('Invalid IP check timeout');
  signal?.throwIfAborted();
  const endpoint = ipCheckURL(url);
  endpoint.searchParams.set('orbit_probe', randomUUID());
  let page, timer, aborted, finished = false;
  const operation = (async () => {
    page = await context.newPage();
    if (finished || signal?.aborted) { await page.close().catch(() => {}); signal?.throwIfAborted(); throw new ProxyIPCheckError('timeout'); }
    const response = await page.goto(endpoint.href, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    if (!response?.ok()) throw new ProxyIPCheckError('http_error');
    return parsePublicIP(await response.text());
  })();
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      aborted = () => reject(signal.reason);
      signal?.addEventListener('abort', aborted, { once: true });
      if (signal?.aborted) aborted();
      timer = setTimeout(() => reject(new ProxyIPCheckError('timeout')), timeoutMs);
    })]);
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof ProxyIPCheckError) throw error;
    const failure = new ProxyIPCheckError(error.name === 'TimeoutError' ? 'timeout' : 'network');
    failure.networkCode = error.message?.match(/net::(ERR_[A-Z_]+)/)?.[1];
    throw failure;
  } finally {
    finished = true; clearTimeout(timer); signal?.removeEventListener('abort', aborted);
    // Closing the probe aborts a pending navigation without closing the task page.
    if (page) {
      let closeTimer;
      try { await Promise.race([page.close().catch(() => {}), new Promise(resolve => { closeTimer = setTimeout(resolve, 500); })]); }
      finally { clearTimeout(closeTimer); }
    }
  }
}

/** Direct worker egress is only a comparison point, not proof of proxy bypass. */
export async function observeWorkerIP({ url = DEFAULT_PROXY_IP_URL, timeoutMs = 5000, signal, fetchImpl = fetch } = {}) {
  const requestSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]);
  const response = await fetchImpl(ipCheckURL(url), { signal: requestSignal, redirect: 'error', headers: { 'Cache-Control': 'no-cache' } });
  if (!response.ok) { await response.body?.cancel(); throw new ProxyIPCheckError('http_error'); }
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.length; if (size > 4096) throw new ProxyIPCheckError('invalid_response'); chunks.push(value);
    }
    return parsePublicIP(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); }
}

export async function checkProxyIP(context, { proxy, config = {}, signal, log = () => {}, history = observations, fetchImpl = fetch } = {}) {
  const mode = config.proxyIPCheckMode ?? 'warn';
  if (mode === 'off') { log('proxy_ip_check_skipped', { proxyId: proxy.id, reason: 'disabled' }); return null; }
  const options = { url: config.proxyIPCheckUrl ?? DEFAULT_PROXY_IP_URL, timeoutMs: config.proxyIPCheckTimeoutMs ?? 5000, signal };
  log('proxy_ip_check_started', { proxyId: proxy.id, proxyHost: proxy.host, proxyPort: proxy.port });
  const browserProbe = async () => {
    try { return await observeBrowserIP(context, options); }
    catch (error) {
      signal?.throwIfAborted();
      if (!['network','timeout'].includes(error.reason)) throw error;
      log('proxy_ip_check_retry', { proxyId: proxy.id, attempt: 2, reason: error.networkCode?.toLowerCase() || error.reason });
      await delay(250, undefined, { signal });
      return observeBrowserIP(context, options);
    }
  };
  const [browser, worker] = await Promise.allSettled([browserProbe(), observeWorkerIP({ ...options, url: config.directIPCheckUrl || options.url, fetchImpl })]);
  signal?.throwIfAborted();
  if (browser.status === 'rejected') {
    const error = browser.reason instanceof ProxyIPCheckError ? browser.reason : new ProxyIPCheckError('network');
    log('proxy_ip_check_failed', { proxyId: proxy.id, errorType: error.name, code: error.code, reason: error.networkCode?.toLowerCase() || error.reason });
    if (mode === 'required') throw error;
    return null;
  }
  const previous = history.get(proxy.id);
  const result = {
    proxyId: proxy.id, proxyHost: proxy.host, proxyPort: proxy.port, browserIp: browser.value,
    ...(worker.status === 'fulfilled' ? { workerIp: worker.value } : {}),
    ...(previous ? { previousIp: previous } : {}),
    ipComparison: !previous ? 'first_observation' : previous === browser.value ? 'unchanged' : 'changed',
    routeComparison: worker.status !== 'fulfilled' ? 'worker_unknown' : worker.value === browser.value ? 'matches_worker' : 'differs_from_worker',
  };
  if (!history.has(proxy.id) && history.size >= 512) history.delete(history.keys().next().value);
  history.set(proxy.id, browser.value);
  log('proxy_ip_observed', result);
  if (result.routeComparison === 'matches_worker') log('proxy_ip_matches_worker', result);
  return result;
}
