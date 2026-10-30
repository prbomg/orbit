import { retryAfterMs } from './http-retry.mjs';
import { isIP } from 'node:net';
import proxyNetwork from '../utils/proxyNetwork.js';
import searchTasks from '../utils/searchTask.js';
import { readFile, mkdir } from 'node:fs/promises';
import { liveFiles, appendLiveFile, replaceLiveFile } from './async-live-files.mjs';
import { resolve } from 'node:path';
import { startBrowserStream } from './live-stream.mjs';
import { sameSite } from './navigation-site.mjs';
import liveSocket from '../utils/liveSocket.js';
import { projectRoot } from './config.mjs';

const eventNames = new Set(['visit_page_plan','visit_behavior_changed','visit_obstacle','visit_content_pause','visit_link_selected','action_input_sent','action_result_verified','plan_ready', 'proxy_rotation_started', 'proxy_rotation_wait', 'proxy_rotation_completed', 'session_started', 'session_completed', 'session_failed', 'session_search_missed', 'session_wait', 'action_started', 'action_completed', 'action_skipped', 'action_failed', 'profile_saved', 'search_started', 'search_home_opening', 'search_home_failed', 'search_query_entered', 'search_submit_started', 'search_submit_completed', 'search_page_scanned', 'search_vital_refinement', 'search_target_clicked', 'search_target_not_found', 'target_visit_started', 'target_internal_link', 'target_visit_finished', 'visit_scroll', 'captcha_widget_wait', 'captcha_manual_required', 'captcha_manual_completed', 'captcha_detected', 'captcha_requested', 'captcha_token_received', 'captcha_token_applied', 'captcha_callback_invoked', 'captcha_submitting', 'captcha_submitted', 'captcha_failed', 'captcha_unrecognized']);
eventNames.add('captcha_submission_started');
eventNames.add('search_document_changed');
for (const event of ['search_pre_warmup_started', 'search_pre_warmup_completed', 'search_pre_warmup_skipped']) eventNames.add(event);
for (const event of ['search_home_ready', 'search_pre_input_pause', 'search_input_activated', 'search_input_metrics', 'search_input_focus_restored', 'search_input_repair_started', 'search_submit_blocked', 'search_results_ready']) eventNames.add(event);
for (const event of ['search_popup_detected', 'search_popup_closed', 'search_popup_blocked']) eventNames.add(event);
for (const event of ['search_home_waiting', 'search_home_recovered']) eventNames.add(event);
for (const event of ['search_input_locating', 'search_input_activating', 'search_input_typing', 'search_input_retry', 'search_input_failed', 'search_query_corrected', 'search_query_retry', 'search_pagination_unavailable']) eventNames.add(event);
for (const event of ['search_http_failed', 'search_rate_limit_wait', 'search_rate_limit_rotate', 'search_rate_limit_replace']) eventNames.add(event);
for (const event of ['captcha_page_loaded', 'captcha_page_load_failed', 'captcha_document_verified', 'captcha_document_failed']) eventNames.add(event);
for (const event of ['captcha_service_selected', 'captcha_service_failed', 'captcha_service_switched']) eventNames.add(event);
const safeId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
for (const event of ['captcha_checkbox_clicked', 'captcha_retrying', 'captcha_coordinates_received', 'captcha_coordinate_applied', 'captcha_coordinates_applied', 'captcha_image_ready', 'captcha_image_capture_failed']) eventNames.add(event);
for (const event of ['captcha_checkbox_retrying', 'captcha_checkbox_completed']) eventNames.add(event);
for (const event of ['task_retry_scheduled', 'task_retry_exhausted']) eventNames.add(event);
for (const event of ['target_internal_link_started', 'target_internal_navigation_started', 'target_internal_link_skipped', 'target_internal_link_failed']) eventNames.add(event);
for (const event of ['proxy_configured', 'proxy_ip_check_retry', 'proxy_ip_check_started', 'proxy_ip_check_failed', 'proxy_ip_observed', 'proxy_ip_matches_worker', 'proxy_ip_check_skipped']) eventNames.add(event);
const hostMatches = (host, allowed) => host === allowed || host.endsWith(`.${allowed}`);
for (const event of ['profile_browser_upgraded', 'profile_browser_bound']) eventNames.add(event);

function paths(runId, taskId, executionId = null) {
  if (!safeId(runId) || !safeId(taskId) || (executionId && !safeId(executionId))) return null;
  const directory = resolve(projectRoot, '.orbit-runtime', 'live', runId);
  const key = executionId || taskId;
  return { directory, events: resolve(directory, `${key}.jsonl`), network: resolve(directory, `${key}.network.json`), screenshot: resolve(directory, `${key}.jpg`) };
}

function writeEvent(runId, taskId, event, details = {}, executionId = null) {
  const files = paths(runId, taskId, executionId);
  if (!files) return;
  try {
    const value = { time: new Date().toISOString(), event, ...details };
    void liveFiles.enqueue(files.events, () => appendLiveFile(files.events, `${JSON.stringify(value)}\n`)).catch(() => {});
  } catch { /* Observation must not affect the browser task. */ }
}

export function appendTaskLiveEvent(runId, taskId, event, details = {}) {
  if (!eventNames.has(event)) return;
  const safe = {};
  if (event === 'search_input_typing' && typeof details.query === 'string') safe.query = details.query.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 2000);
  if (event.startsWith('search_pre_warmup_')) {
    if (typeof details.donorDomain === 'string' && /^[a-z0-9.-]{1,253}$/i.test(details.donorDomain)) safe.donorDomain = details.donorDomain;
    if (Number.isSafeInteger(details.scrolls) && details.scrolls >= 0) safe.scrolls = details.scrolls;
  }
  for (const key of ['fromVersion','toVersion']) if (typeof details[key] === 'string' && /^\d{2,3}(\.\d{1,5}){3}$/.test(details[key])) safe[key] = details[key];
  for (const key of ['elapsedMs', 'checksMs', 'intervalCount', 'intervalMedianMs', 'intervalMaxMs', 'focusRecoveryCount']) if (typeof details[key] === 'number' && Number.isFinite(details[key]) && details[key] >= 0) safe[key] = details[key];
  for (const key of ['service', 'previousService', 'failures', 'threshold', 'retryAfterMs', 'status', 'action', 'step', 'total', 'pixels', 'width', 'height', 'durationMs', 'pagesVisited', 'page', 'organicResults', 'linksFollowed', 'characters', 'engine', 'source', 'element', 'sourceType', 'captureState', 'capturedResponses', 'errorType', 'code', 'provider', 'attempt', 'method','result','movedPixels','scrollTarget','inputMethod','gestureMode','reason','pageType','pageNumber','budgetMs','blocksCount','blockKind','words','linkKind','zone','score']) {
    const value = details[key];
    if (typeof value === 'number' && Number.isFinite(value)) safe[key] = value;
    else if (typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value)) safe[key] = value;
  }
  for (const key of ['browserIp', 'workerIp', 'previousIp']) if (typeof details[key] === 'string' && isIP(details[key])) safe[key] = details[key];
  if (typeof details.proxyHost === 'string' && /^[a-zA-Z0-9.:[\]-]{1,253}$/.test(details.proxyHost)) safe.proxyHost = details.proxyHost;
  for (const key of ['proxyId', 'ipComparison', 'routeComparison']) if (typeof details[key] === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(details[key])) safe[key] = details[key];
  if (Number.isSafeInteger(details.proxyPort) && details.proxyPort > 0 && details.proxyPort <= 65535) safe.proxyPort = details.proxyPort;
  writeEvent(runId, taskId, event, safe, details.executionId);
  if (['proxy_configured','proxy_ip_check_started','proxy_ip_observed','proxy_ip_check_failed','proxy_ip_check_skipped'].includes(event)) {
    const files=paths(runId,taskId,details.executionId);if(!files)return;
    void liveFiles.enqueue(files.network, async () => {
      let previous={};try{previous=JSON.parse(await readFile(files.network,'utf8'));}catch{}
      if(['proxy_configured','proxy_ip_check_started'].includes(event))for(const key of ['browserIp','workerIp','previousIp','ipComparison','routeComparison'])delete previous[key];
      const checkStatus=event==='proxy_ip_observed'?'observed':event==='proxy_ip_check_failed'?'failed':event==='proxy_ip_check_skipped'?'disabled':'pending';
      const value=proxyNetwork.networkSnapshot({...previous,...safe,proxyScheme:details.proxyScheme||previous.proxyScheme,executionId:details.executionId||taskId,checkStatus,checkedAt:new Date().toISOString()});
      await replaceLiveFile(files.network,JSON.stringify(value));
    }).catch(() => {});
  }
}

/** Observe only top-level pages, and omit query strings that may carry session tokens. */
export function startLiveView(context, { runId, taskId, executionId = null, targetUrl, allowSearch = false, searchEngine = allowSearch }) {
  const files = paths(runId, taskId, executionId);
  if (!files) return () => {};
  const targetHost = new URL(targetUrl).hostname;
  const allowed = [targetHost, ...searchTasks.searchEngineDomains(searchEngine)];
  const temporarySites = new Map();
  const pages = new Map();
  const displayUrl = value => {
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol) || (!allowed.some(host => hostMatches(url.hostname, host)) && ![...temporarySites.keys()].some(origin => sameSite(value, origin)))) return null;
      return `${url.origin}${url.pathname}`;
    } catch { return null; }
  };
  let currentPage;
  let nextTab = 0;
  const selectedPage=()=>currentPage&&!currentPage.isClosed()&&displayUrl(currentPage.url())?currentPage:[...pages.keys()].reverse().find(page=>!page.isClosed()&&displayUrl(page.url()))||null;
  let stopStream=()=>{}, stopped=false;
  void mkdir(files.directory,{recursive:true,mode:0o700}).then(() => {
    if (stopped) return;
    stopStream=startBrowserStream(context,{
      socketPath:liveSocket.liveSocketPath(resolve(projectRoot,'.orbit-runtime'),runId,executionId || taskId),getPage:selectedPage,
      onFrame:image=>{void liveFiles.enqueue(files.screenshot,()=>replaceLiveFile(files.screenshot,image),{replace:true}).catch(()=>{});}
    });
  }).catch(()=>{});
  const attach = page => {
    if (pages.has(page)) return;
    const tab = ++nextTab;
    let navigationId = 0; const requestIds = new WeakMap();
    const requested = request => {
      try {
        if (request.isNavigationRequest() && request.frame() === page.mainFrame()) requestIds.set(request, ++navigationId);
      } catch { /* Popup request can precede its frame. */ }
    };
    currentPage = page;
    const navigated = frame => {
      if (frame !== page.mainFrame()) return;
      const url = displayUrl(frame.url());
      if (url) { currentPage = page; writeEvent(runId, taskId, 'navigation', { tab, navigationId, url }, executionId); }
    };
    const responded = response => {
      try {
        const request = response.request();
        if (!request.isNavigationRequest() || request.frame() !== page.mainFrame()) return;
        const url = displayUrl(response.url());
        if (!requestIds.has(request)) requestIds.set(request, ++navigationId);
        if (url) writeEvent(runId, taskId, 'navigation_response', { tab, navigationId: requestIds.get(request), url, status: response.status(), retryAfterMs: retryAfterMs(response.headers()['retry-after']) }, executionId);
      } catch { /* Popup frame may not yet be available. */ }
    };
    page.on('request', requested);
    page.on('framenavigated', navigated);
    page.on('response', responded);
    pages.set(page, { requested, navigated, responded });
    const initial = displayUrl(page.url());
    if (initial) writeEvent(runId, taskId, 'navigation', { tab, url: initial }, executionId);
  };
  context.on('page', attach);
  for (const page of context.pages()) attach(page);
  const stop = () => {
    stopped=true; stopStream();
    context.off('page', attach);
    for (const [page, listeners] of pages) { page.off('request', listeners.requested); page.off('framenavigated', listeners.navigated); page.off('response', listeners.responded); }
    // Observational shutdown must not hold session publication indefinitely if
    // the filesystem is unhealthy. Critical profile writes have their own path.
    let timer;
    return Promise.race([liveFiles.flush(files.directory), new Promise(resolve => {
      timer = setTimeout(resolve, 5000); timer.unref();
    })]).finally(() => clearTimeout(timer));
  };
  // Observation only: the caller's existing navigation policy remains authoritative.
  stop.allowTemporarySite = origin => {
    let url;
    try { url = new URL(origin); } catch { return () => {}; }
    if (stopped || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) return () => {};
    const originKey = url.origin;
    temporarySites.set(originKey, (temporarySites.get(originKey) || 0) + 1);
    let released = false;
    return () => {
      if (released) return; released = true;
      const count = temporarySites.get(originKey) || 0;
      if (count > 1) temporarySites.set(originKey, count - 1); else temporarySites.delete(originKey);
    };
  };
  stop.captureFailure = async (page, details = {}) => {
    const documentUrl = page.url(), url = displayUrl(documentUrl);
    if (!url || page.isClosed()) return;
    let screenshotState = 'unavailable';
    const imagePath = files.screenshot.replace(/\.jpg$/, '.failure.jpg');
    try {
      const image = await page.screenshot({ type: 'jpeg', quality: 75, timeout: 2000, animations: 'disabled' });
      if (page.url() !== documentUrl) throw new Error('Document changed while capturing evidence');
      await liveFiles.enqueue(imagePath,()=>replaceLiveFile(imagePath,image)); screenshotState = 'saved';
    } catch { /* A closed or changing page may not permit a final screenshot. */ }
    writeEvent(runId, taskId, 'search_failure_snapshot', { url, stage: /^[a-zA-Z0-9_-]{1,80}$/.test(details.stage) ? details.stage : 'unknown',
      ...(Number.isFinite(details.elapsedMs) ? { elapsedMs: Math.max(0, details.elapsedMs) } : {}),
      status: Number.isInteger(details.status) && details.status >= 100 && details.status <= 599 ? details.status : null, screenshotState }, executionId);
    await liveFiles.flush(files.directory);
  };
  return stop;
}

export function flushLiveView(runId) {
  if (!safeId(runId)) return Promise.resolve();
  return liveFiles.flush(resolve(projectRoot,'.orbit-runtime','live',runId));
}
