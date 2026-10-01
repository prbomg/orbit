import { sleep, TaskStoppedError } from './behavior.mjs';

export class ProxyRotationError extends Error {
  constructor(code) { super('Proxy rotation failed'); this.name = 'ProxyRotationError'; this.code = code; }
}

export async function rotateProxy({ proxy, config, signal, shouldContinue = async () => true, log = () => {} }) {
  if (!proxy.rotationUrl) return;
  const requestSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(config.rotationTimeoutMs)]);
  try {
    const url = new URL(proxy.rotationUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new ProxyRotationError('invalid_url');
    log('proxy_rotation_started', { proxyId: proxy.id });
    const response = await fetch(url, { method: 'GET', signal: requestSignal, redirect: 'error' });
    await response.body?.cancel();
    if (!response.ok) throw new ProxyRotationError(`http_${response.status}`);
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
