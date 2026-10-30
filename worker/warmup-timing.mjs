import { performance } from 'node:perf_hooks';

export const warmupLimits = Object.freeze({ operationMs: 60_000, siteMs: 300_000, runMs: 1_200_000, cleanupMs: 5_000 });

// Planned reading time is a target, not a deadline for all network attempts.
// Allow one navigation per required donor and up to three replacement donors.
export function warmupSessionBudget({ sessionMinutes = 0, requiredSites = 3, navigationTimeoutMs = 30_000, timeoutMs } = {}) {
  if (timeoutMs !== undefined) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('invalid_warmup_session_timeout');
    return Math.min(timeoutMs, warmupLimits.runMs);
  }
  if (!(sessionMinutes > 0)) return warmupLimits.runMs;
  return Math.min(warmupLimits.runMs, sessionMinutes * 60_000 + (requiredSites + Math.min(3, requiredSites)) * navigationTimeoutMs);
}

export class WarmupTimeoutError extends Error {
  constructor(code = 'warmup_operation_timeout') { super(code); this.name = 'WarmupTimeoutError'; this.code = code; }
}

/** A deadline also bounds APIs that do not accept AbortSignal. The caller cancels their owner. */
export async function withDeadline(operation, { timeoutMs, signal, code = 'warmup_operation_timeout', onTimeout = () => {} }) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new WarmupTimeoutError(code);
  signal?.throwIfAborted();
  let timer, aborted;
  const end = performance.now() + timeoutMs;
  const expired = () => { const error = new WarmupTimeoutError(code); onTimeout(error); return error; };
  try {
    const result = await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(expired()), timeoutMs);
        aborted = () => reject(signal.reason);
        signal?.addEventListener('abort', aborted, { once: true });
        if (signal?.aborted) aborted();
      }),
    ]);
    signal?.throwIfAborted();
    if (performance.now() >= end) throw expired();
    return result;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', aborted); }
}

/** Coalesce concurrent checks, cache only successful reads, and permit fresh commit checks. */
export function cachedCheck(read, { ttlMs = 1000, now = () => performance.now() } = {}) {
  let pending, value, expires = -Infinity;
  return async (fresh = false) => {
    if (fresh) return read();
    if (now() < expires) return value;
    if (!pending) pending = Promise.resolve().then(read).then(result => {
      value = result; expires = now() + ttlMs; return result;
    }).finally(() => { pending = undefined; });
    return pending;
  };
}
