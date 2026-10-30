export function retryAfterMs(value, now = Date.now()) {
  if (typeof value !== 'string' || !value.trim()) return 0;
  const text = value.trim();
  const delay = /^\d+$/.test(text) ? Number(text) * 1000 : Date.parse(text) - now;
  return Number.isFinite(delay) && delay > 0 && now + delay <= 8.64e15 ? delay : 0;
}
export function rateLimitDelay(count, requested = 0) {
  return Math.max(15 * 60_000 * 2 ** Math.min(4, Math.max(0, count - 1)), Number.isFinite(requested) ? requested : 0);
}
