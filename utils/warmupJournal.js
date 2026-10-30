// Deliberate allowlist: never persist proxy passwords, URLs with tokens, cookies,
// storage values or raw exception messages in a user-visible journal.
const { isIP } = require('node:net');
const runtimeEvents = new Set(['profile_loaded', 'profile_generated', 'proxy_tcp_verified', 'proxy_tcp_waiting', 'motion_emulation_started', 'motion_emulation_unavailable', 'proxy_rotation_started', 'proxy_rotation_completed', 'proxy_rotation_shared', 'proxy_rotation_waiting', 'fingerprint_verified', 'warmup_site_deferred', 'warmup_site_started', 'warmup_site_completed', 'warmup_site_skipped', 'warmup_scroll', 'warmup_session_check', 'warmup_final_fingerprint']);
for (const event of ['profile_browser_upgraded', 'profile_browser_bound']) runtimeEvents.add(event);
for (const event of ['warmup_wait', 'warmup_link_clicked', 'warmup_link_skipped', 'warmup_operation_started', 'warmup_operation_completed', 'warmup_operation_failed', 'warmup_duration', 'warmup_visit_quality', 'warmup_site_partial', 'warmup_run_context', 'warmup_run_finished', 'warmup_storage_check']) runtimeEvents.add(event);
for(const event of ['proxy_ip_check_retry','proxy_ip_check_started','proxy_ip_check_failed','proxy_ip_observed','proxy_ip_matches_worker','proxy_ip_check_skipped'])runtimeEvents.add(event);
function journalEntry(context, event, input = {}) {
  /** @type {Record<string, string | number>} */
  const details = {};
  for (const key of ['fromVersion','toVersion']) if (typeof input[key] === 'string' && /^\d{2,3}(\.\d{1,5}){3}$/.test(input[key])) details[key] = input[key];
  for (const key of ['status', 'step', 'total', 'cookiesCount', 'originsCount', 'localStorageEntriesCount', 'indexedDBRecordsCount', 'durationMs', 'gestures', 'updateHz', 'plannedMs', 'budgetMs', 'navigationId', 'rowsCount', 'writesCount', 'failedWrites', 'queueMs', 'transactionMs', 'maxQueueMs', 'maxTransactionMs', 'confirmedScrollPixels', 'confirmedLinks', 'contentConfirmed', 'preparationMs']) {
    if (Number.isSafeInteger(input[key]) && input[key] >= 0) details[key] = input[key];
  }
  for (const key of ['reason', 'source', 'scenario', 'operation', 'phase', 'result', 'scrollTarget', 'quality', 'release', 'model', 'storageMode', 'preset', 'outcome']) if (typeof input[key] === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(input[key])) details[key] = input[key];
  if (['document', 'navigation', 'unknown'].includes(input.responseScope)) details.responseScope = input.responseScope;
  if (['touch', 'wheel', 'none'].includes(input.inputMethod)) details.inputMethod = input.inputMethod;
  if (Number.isSafeInteger(input.pixels) && Math.abs(input.pixels) <= 5000) details.pixels = input.pixels;
  if (Number.isSafeInteger(input.movedPixels) && Math.abs(input.movedPixels) <= 1_000_000) details.movedPixels = input.movedPixels;
  for (const key of ['domain', 'responseDomain']) if (typeof input[key] === 'string' && /^[a-zA-Z0-9.-]{1,253}$/.test(input[key])) details[key] = input[key];
  for (const key of ['nextStageAt', 'retryAfter']) {
    if (input[key] && Number.isFinite(new Date(input[key]).getTime())) details[key] = new Date(input[key]).toISOString();
  }
  for (const key of ['browserIp','workerIp','previousIp']) if(typeof input[key]==='string'&&isIP(input[key])) details[key]=input[key];
  for (const key of ['ipComparison','routeComparison','code']) if(typeof input[key]==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(input[key]))details[key]=input[key];
  return { profileId: context.profileId, jobId: context.jobId || null, runId: context.runId || null,
    stage: context.stage || null, attempt: context.attempt || null,
    proxyId: context.proxy?.id || null, proxyLabel: context.proxy ? `${context.proxy.host}:${context.proxy.port}` : null,
    event, details, createdAt: new Date() };
}
const claimContext = claim => ({ profileId: claim.job.profileId, jobId: claim.job.id, runId: claim.owner, stage: claim.job.currentStage, attempt: claim.job.attempts, proxy: claim.proxy });
module.exports = { runtimeEvents, journalEntry, claimContext };
