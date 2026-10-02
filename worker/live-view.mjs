import { appendFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { projectRoot } from './config.mjs';

const eventNames = new Set(['plan_ready', 'proxy_rotation_started', 'proxy_rotation_wait', 'proxy_rotation_completed', 'session_started', 'session_completed', 'session_failed', 'session_search_missed', 'session_wait', 'action_started', 'action_completed', 'action_skipped', 'action_failed', 'profile_saved', 'search_started', 'search_home_opening', 'search_home_failed', 'search_query_entered', 'search_submit_started', 'search_submit_completed', 'search_page_scanned', 'search_vital_refinement', 'search_target_clicked', 'search_target_not_found', 'target_visit_started', 'target_internal_link', 'target_visit_finished', 'visit_scroll', 'captcha_widget_wait', 'captcha_manual_required', 'captcha_manual_completed', 'captcha_detected', 'captcha_requested', 'captcha_token_received', 'captcha_token_applied', 'captcha_callback_invoked', 'captcha_submitting', 'captcha_submitted', 'captcha_failed', 'captcha_unrecognized']);
const safeId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
for (const event of ['captcha_checkbox_clicked', 'captcha_retrying', 'captcha_coordinates_received', 'captcha_coordinate_applied', 'captcha_coordinates_applied', 'captcha_image_ready', 'captcha_image_capture_failed']) eventNames.add(event);
const hostMatches = (host, allowed) => host === allowed || host.endsWith(`.${allowed}`);

function paths(runId, taskId) {
  if (!safeId(runId) || !safeId(taskId)) return null;
  const directory = resolve(projectRoot, '.orbit-runtime', 'live', runId);
  return { directory, events: resolve(directory, `${taskId}.jsonl`), screenshot: resolve(directory, `${taskId}.jpg`) };
}

function writeEvent(runId, taskId, event, details = {}) {
  const files = paths(runId, taskId);
  if (!files) return;
  try {
    mkdirSync(files.directory, { recursive: true, mode: 0o700 });
    const value = { time: new Date().toISOString(), event, ...details };
    appendFileSync(files.events, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  } catch { /* Observation must not affect the browser task. */ }
}

export function appendTaskLiveEvent(runId, taskId, event, details = {}) {
  if (!eventNames.has(event)) return;
  const safe = {};
  for (const key of ['action', 'step', 'total', 'pixels', 'width', 'height', 'durationMs', 'pagesVisited', 'page', 'organicResults', 'linksFollowed', 'characters', 'engine', 'source', 'element', 'sourceType', 'captureState', 'capturedResponses', 'errorType', 'code', 'provider', 'attempt', 'method']) {
    const value = details[key];
    if (typeof value === 'number' && Number.isFinite(value)) safe[key] = value;
    else if (typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value)) safe[key] = value;
  }
  writeEvent(runId, taskId, event, safe);
}

/** Observe only top-level pages, and omit query strings that may carry session tokens. */
export function startLiveView(context, { runId, taskId, targetUrl, allowSearch = false }) {
  const files = paths(runId, taskId);
  if (!files) return () => {};
  const targetHost = new URL(targetUrl).hostname;
  const allowed = [targetHost, ...(allowSearch ? ['ya.ru', 'yandex.ru', 'yandex.com'] : [])];
  const pages = new Map();
  const displayUrl = value => {
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol) || !allowed.some(host => hostMatches(url.hostname, host))) return null;
      return `${url.origin}${url.pathname}`;
    } catch { return null; }
  };
  let currentPage;
  let capturing = false;
  let stopped = false;
  let nextTab = 0;
  const capture = async () => {
    if (capturing || stopped) return;
    const page = currentPage && !currentPage.isClosed() && displayUrl(currentPage.url()) ? currentPage : [...pages.keys()].reverse().find(item => !item.isClosed() && displayUrl(item.url()));
    if (!page || !displayUrl(page.url())) return;
    capturing = true;
    try {
      const image = await page.screenshot({ type: 'jpeg', quality: 55, animations: 'disabled', timeout: 4000 });
      mkdirSync(files.directory, { recursive: true, mode: 0o700 });
      const temp = `${files.screenshot}.${process.pid}.tmp`;
      writeFileSync(temp, image, { mode: 0o600 });
      renameSync(temp, files.screenshot);
    } catch { /* Navigation and closure can interrupt a frame. */ }
    finally { capturing = false; }
  };
  const attach = page => {
    if (pages.has(page)) return;
    const tab = ++nextTab;
    currentPage = page;
    const navigated = frame => {
      if (frame !== page.mainFrame()) return;
      const url = displayUrl(frame.url());
      if (url) { currentPage = page; writeEvent(runId, taskId, 'navigation', { tab, url }); void capture(); }
    };
    const responded = response => {
      try {
        const request = response.request();
        if (!request.isNavigationRequest() || request.frame() !== page.mainFrame()) return;
        const url = displayUrl(response.url());
        if (url) writeEvent(runId, taskId, 'navigation_response', { tab, url, status: response.status() });
      } catch { /* Popup frame may not yet be available. */ }
    };
    page.on('framenavigated', navigated);
    page.on('response', responded);
    pages.set(page, { navigated, responded });
    const initial = displayUrl(page.url());
    if (initial) writeEvent(runId, taskId, 'navigation', { tab, url: initial });
  };
  context.on('page', attach);
  for (const page of context.pages()) attach(page);
  const timer = setInterval(() => { void capture(); }, 2500);
  void capture();
  return () => {
    stopped = true;
    clearInterval(timer);
    context.off('page', attach);
    for (const [page, listeners] of pages) { page.off('framenavigated', listeners.navigated); page.off('response', listeners.responded); }
  };
}
