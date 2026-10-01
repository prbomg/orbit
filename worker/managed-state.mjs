import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { projectRoot } from './config.mjs';

const path = resolve(projectRoot, '.orbit-runtime', 'project-worker.json');
const safeEvents = new Set(['worker_started', 'waiting', 'session_started', 'session_completed', 'session_failed', 'worker_error', 'project_blocked', 'project_finished', 'stopping', 'worker_stopped', 'task_stopped', 'search_started', 'search_target_clicked']);
const providerCodes = new Set(['credit_balance_exhausted', 'insufficient_quota', 'rate_limit_exceeded', 'slow_down', 'billing_hard_limit_reached', 'organization_spend_limit_exceeded', 'project_spend_limit_exceeded', 'organization_usage_limit_exceeded', 'invalid_api_key', 'model_not_found', 'unsupported_country_region_territory', 'organization_verification_required']);
const captchaCodes = new Set(['missing_api_key', 'widget_not_detected', 'sitekey_missing', 'provider_error', 'timeout', 'image_capture_failed', 'solve_limit', 'captcha_reload_failed']);
const searchCodes = new Set(['search_home_timeout']);

export function managedEventRecord(current, event, details = {}) {
  if (!safeEvents.has(event)) return current;
  const failure = ['session_failed', 'worker_error', 'project_blocked'].includes(event);
  const reset = ['search_started', 'session_started', 'session_completed', 'project_finished'].includes(event);
  const safeCode = /^http_(?:401|403|429)$/.test(details.code) ||
    (details.errorType === 'CaptchaError' && captchaCodes.has(details.code)) ||
    (details.errorType === 'SearchError' && searchCodes.has(details.code));
  return { ...current,
    event: event === 'worker_stopped' && ['project_finished', 'project_blocked'].includes(current.event) ? current.event : event,
    taskId: typeof details.taskId === 'string' ? details.taskId : current.taskId,
    errorType: failure ? String(details.errorType || 'Error').slice(0, 80) : reset ? null : current.errorType,
    errorCode: failure ? safeCode ? details.code : null : reset ? null : current.errorCode,
    providerCode: failure ? providerCodes.has(details.providerCode) ? details.providerCode : null : reset ? null : current.providerCode,
    updatedAt: new Date().toISOString() };
}

export function writeManagedEvent(projectId, runId, event, details = {}) {
  if (!safeEvents.has(event)) return;
  try {
    const current = JSON.parse(readFileSync(path, 'utf8'));
    if (current.projectId !== projectId || current.runId !== runId) return;
    const next = managedEventRecord(current, event, details);
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(next), { mode: 0o600 });
    renameSync(temp, path);
  } catch { /* Logging must never interrupt the browser session. */ }
}
