import {retryAfterMs} from './http-retry.mjs';
import fp from '../utils/fingerprint.js';
const ENDPOINT = 'https://mpsapi.com/api.html';
const cachedProxies = new Map();
const pendingProxies = new Map();
async function waitForProxyList(pending, signal) {
  if (!signal) return pending;
  signal.throwIfAborted();
  let abort;
  const stopped = new Promise((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([pending, stopped]); }
  finally { signal.removeEventListener('abort', abort); }
}
export class FingerprintProviderError extends Error { constructor(code) { super('Fingerprint provider unavailable'); this.name = 'FingerprintProviderError'; this.code = code; } }
export async function mobileProxyFingerprint({ passport, proxy, token, signal, fetchImpl = fetch }) {
  signal?.throwIfAborted();
  if (!token) throw new FingerprintProviderError('mobileproxy_key_missing');
  const request = async (params, requestSignal = signal) => {
    const url = new URL(ENDPOINT); for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    try {
      const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.any([AbortSignal.timeout(20000), ...(requestSignal ? [requestSignal] : [])]), redirect: 'error' });
      if (!response.ok) { const error = new FingerprintProviderError(`mobileproxy_http_${response.status}`); error.retryDelayMs = retryAfterMs(response.headers.get('retry-after')); await response.body?.cancel(); throw error; }
      const reader = response.body.getReader(); let bytes = 0; const chunks = [];
      try { while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.length; if (bytes > 1_000_000) throw new FingerprintProviderError('mobileproxy_response_too_large'); chunks.push(value); } }
      finally { await reader.cancel(); }
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!Array.isArray(data) && data.status !== 'ok') throw new FingerprintProviderError('mobileproxy_rejected');
      return data;
    } catch (error) { if (requestSignal?.aborted) throw requestSignal.reason; if (error instanceof FingerprintProviderError) throw error; throw new FingerprintProviderError('mobileproxy_unavailable'); }
  };
  const cacheKey = fp.digest(token); let rows = cachedProxies.get(cacheKey);
  if (!rows || rows.expires < Date.now()) {
    let pending = pendingProxies.get(cacheKey);
    if (!pending) {
      pending = (async () => {
    // Shared account metadata outlives an individual cancelled warmup. Its own
    // network timeout remains bounded; each caller can stop waiting separately.
    const data = await request({ command: 'get_my_proxy' }, null);
    const list = Array.isArray(data) ? data : data.list;
    if (!Array.isArray(list)) throw new FingerprintProviderError('mobileproxy_invalid_response');
    // Cache only matching metadata; never retain provider passwords in this cache.
    const fetched = { expires: Date.now() + 300000, items: list.map(p => ({ id: p.proxy_id, hosts: [p.proxy_host_ip, p.proxy_hostname, p.proxy_independent_http_host_ip, p.proxy_independent_http_hostname], ports: [p.proxy_http_port, p.proxy_independent_port], username: p.proxy_login })) };
    if (cachedProxies.size > 5) cachedProxies.clear(); cachedProxies.set(cacheKey, fetched);
    return fetched;
      })().finally(() => pendingProxies.delete(cacheKey));
      pendingProxies.set(cacheKey, pending);
    }
    rows = await waitForProxyList(pending, signal);
  }
  const match = rows.items.find(p => p.hosts.includes(proxy.host) && p.ports.some(port => Number(port) === proxy.port) && p.username === proxy.username);
  if (!match || !/^\d+$/.test(String(match.id))) throw new FingerprintProviderError('mobileproxy_proxy_not_found');
  const data = await request({ command: 'fingerprint_generate', proxy_id: match.id, os: 'android', seed: passport.seed });
  try { return { ...fp.mobileProxyPassport(passport, data), providerProxyId: String(match.id) }; } catch { throw new FingerprintProviderError('mobileproxy_invalid_profile'); }
}
