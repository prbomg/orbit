import { sleep, TaskStoppedError } from './behavior.mjs';

export class ProxyRotationError extends Error {
  constructor(code) { super('Proxy rotation failed'); this.name = 'ProxyRotationError'; this.code = code; }
}

export async function rotateProxy({ proxy, config, signal, shouldContinue = async () => true, log = () => {}, fetchImpl = fetch }) {
  if (!proxy.rotationUrl) return;
  const requestSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(config.rotationTimeoutMs)]);
  try {
    const url = new URL(proxy.rotationUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new ProxyRotationError('invalid_url');
    const mobileProxy = ['changeip.mobileproxy.space', 'changeip.mpsapi.com'].includes(url.hostname);
    if (mobileProxy) url.searchParams.set('format', 'json');
    log('proxy_rotation_started', { proxyId: proxy.id });
    const response = await fetchImpl(url, { method: 'GET', signal: requestSignal, redirect: 'error', ...(mobileProxy ? { headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Mobile Safari/537.36', Accept: 'application/json' } } : {}) });
    if (!response.ok) { await response.body?.cancel(); throw new ProxyRotationError(`http_${response.status}`); }
    if (mobileProxy) {
      const reader = response.body.getReader(); const chunks = []; let bytes = 0;
      try {
        while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.length; if (bytes > 64_000) throw new ProxyRotationError('proxy_rotation_invalid_response'); chunks.push(value); }
        let data; try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ProxyRotationError('proxy_rotation_invalid_response'); }
        if (!data || typeof data !== 'object' || typeof data.status !== 'string') throw new ProxyRotationError('proxy_rotation_invalid_response');
        if (data.status.toLowerCase() !== 'ok') throw new ProxyRotationError('proxy_rotation_rejected');
      } finally { await reader.cancel(); }
    } else await response.body?.cancel();
    log('proxy_rotation_wait', { proxyId: proxy.id, durationMs: 15_000 });
    // This wait is always 15 seconds; cancellation and task pauses are checked every second.
    const until = performance.now() + 15_000;
    while (performance.now() < until) {
      signal?.throwIfAborted();
      if (!(await shouldContinue())) throw new TaskStoppedError();
      await sleep(Math.min(1000, Math.max(0, until - performance.now())), signal);
    }
    signal?.throwIfAborted();
    if (!(await shouldContinue())) throw new TaskStoppedError();
    log('proxy_rotation_completed', { proxyId: proxy.id });
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof ProxyRotationError || error instanceof TaskStoppedError) throw error;
    throw new ProxyRotationError(requestSignal.aborted ? 'timeout' : 'network');
  }
}
