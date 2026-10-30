import { randomUUID } from 'node:crypto';
import store from '../utils/taskLogStore.js';
import { safeLogDetails } from './log-redaction.mjs';
export const TECH_LOG_FORMAT_VERSION = 2;
const MAX_QUEUE_BYTES = 1024 * 1024;
let pending = [], pendingBytes = 0, lost = 0, flushing = null, timer, maintenance, lastWarning = 0;
const scopes = new Set();
function warn(code) {
  if (Date.now() - lastWarning < 30000) return;
  lastWarning = Date.now(); console.error(JSON.stringify({ event: 'technical_log_warning', code }));
}
function bounded(value, depth = 0) {
  if (depth > 5) return '[nested data omitted]';
  if (typeof value === 'string') return value.length > 4000 ? value.slice(0, 4000) + '[truncated]' : value;
  if (Array.isArray(value)) return value.slice(0, 100).map(v => bounded(v, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 80).map(([k,v]) => [k,
    /^(screenshot|image|base64|body|rawHtml)$/i.test(k) ? '[heavy data omitted]' : bounded(v, depth + 1)]));
  return value;
}
function enqueue(record) {
  const bytes = Buffer.byteLength(record.line);
  if (pendingBytes + bytes > MAX_QUEUE_BYTES) { lost++; warn('queue_capacity'); return; }
  pending.push(record); pendingBytes += bytes;
  if (!timer) { timer = setTimeout(() => { timer = null; void flushTechLogs(); }, 1000); timer.unref(); }
}
export async function flushTechLogs() {
  if (flushing) { await flushing; if (pending.length) return flushTechLogs(); return; }
  const batch = pending; pending = []; pendingBytes = 0;
  flushing = (async () => {
    const records = [];
    for (const r of batch) {
      const meta = await r.meta;
      if (lost) { records.push({ meta, time: r.time, event: 'technical_log_gap', line: `[${r.time}] [technical_log_gap] ${JSON.stringify({ droppedEvents: lost, reason: 'bounded_queue' })}\n` }); lost = 0; }
      records.push({ ...r, meta });
    }
    const result = await store.writeBatch(store.rootPath(), records);
    if (result.dropped) warn('storage_budget_reached');
  })().catch(error => { lost += batch.length; warn(error.code || error.message || 'write_failed'); }).finally(() => { flushing = null; });
  await flushing;
}
export async function closeTechLogs() {
  clearTimeout(timer); clearInterval(maintenance); timer = null; maintenance = null;
  for (const scope of scopes) if (!scope.closed) {
    const time = new Date().toISOString();
    enqueue({ meta: scope.meta, time, event: 'log_writer_closed', end: 'interrupted', line: `[${time}] [log_writer_closed]\n` });
  }
  await flushTechLogs(); clearTimeout(timer); timer = null;
}
export async function createTechLogger(taskId, baseLog, meta = {}, resolveExecution = async () => null) {
  if (!store.safeId(taskId)) throw Error('invalid_log_task');
  if (!maintenance) { maintenance = setInterval(() => { void flushTechLogs(); }, 60000); maintenance.unref(); }
  const current = new Map();
  const log = (event, data = {}) => {
    baseLog(event, data); // Live events must never wait for file I/O.
    const time = new Date().toISOString(), executionId = store.safeId(data.executionId) ? data.executionId : null;
    const key = executionId || 'task';
    let scope = current.get(key);
    if (!scope || event === 'execution_allocated') {
      if (scope) {
        if (!scope.closed) enqueue({ meta: scope.meta, time, event: 'previous_log_scope_closed', end: 'interrupted', line: `[${time}] [previous_log_scope_closed]\n` });
        scopes.delete(scope);
      }
      const details = { id: randomUUID(), taskId, executionId, projectId: meta.projectId || null,
        runId: meta.runId || null, startedAt: time, executionStartedAt: null, attempt: null };
      scope = { closed: false, meta: executionId ? Promise.resolve(resolveExecution(executionId)).then(e => ({ ...details,
        executionStartedAt: e?.startedAt ? new Date(e.startedAt).toISOString() : null, attempt: e?.attempts ?? null,
      })).catch(() => details) : Promise.resolve(details) };
      current.set(key, scope); scopes.add(scope);
      // Do not retain completed sessions forever in a long-lived task logger.
      if (current.size > 256) for (const [id, old] of current) if (old.closed) { current.delete(id); scopes.delete(old); if (current.size <= 128) break; }
    }
    let clean;
    try { clean = safeLogDetails(bounded(data)); } catch { clean = { serializationError: true }; }
    let line = `[${time}] [${String(event).slice(0, 100)}] ${JSON.stringify(clean)}\n`;
    if (Buffer.byteLength(line) > 16 * 1024) line = `[${time}] [${String(event).slice(0, 100)}] ${JSON.stringify({ executionId, code: data.code, detailsOmitted: 'record_size_limit' })}\n`;
    const end = event === 'session_completed' ? 'success' : ['session_failed', 'session_search_missed', 'task_no_longer_active', 'task_retry_scheduled', 'task_retry_exhausted', 'search_rate_limit_rotate', 'search_rate_limit_replace'].includes(event) ? 'error' : undefined;
    if (end) scope.closed = true;
    enqueue({ meta: scope.meta, time, event, code: typeof data.code === 'string' ? data.code.slice(0, 120) : undefined, line, end });
  };
  return { log };
}
