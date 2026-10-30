// Keep structured event names/counters; discard credentials and URL payloads.
// This runs before both user-supplied log callbacks and console serialization.
export function safeLogDetails(value, depth = 0) {
  if (depth > 8) return '[redacted]';
  if (typeof value === 'string') return value.replace(/https?:\/\/[^\s<>"']+/gi, raw => {
    try { const url = new URL(raw); return `${url.origin}/[redacted]`; }
    catch { return '[redacted-url]'; }
  });
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(item => safeLogDetails(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    /token|secret|password|authorization|api.?key|rotation.?url|^proxy$|proxy(?:url|params|parameters|credentials|password|username|login|address|host|port|scheme|type)/i.test(key) ? '[redacted]' : safeLogDetails(item, depth + 1)]));
  return value;
}
