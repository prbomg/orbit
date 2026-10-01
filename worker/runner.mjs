import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { randomInt, sleep, TaskStoppedError } from './behavior.mjs';
import { loadMobileProfile, createMobileContext, createMobilePage, prepareMobilePage, stageMobileProfile, ProfileError } from './profiles.mjs';
import { generateActionPlan, OpenAIPlanError } from './ai-plan.mjs';
import { generateLocalActionPlan } from './local-plan.mjs';
import { executeActionPlan, restrictNavigation } from './action-executor.mjs';
import { rotateProxy, ProxyRotationError } from './proxy-rotation.mjs';
import { createCaptchaHandler } from './captcha-page.mjs';
import { CaptchaError } from './captcha-provider.mjs';
import { performWarmup } from './warmup.mjs';
import { performSearchAndClick, SearchError } from './search.mjs';
import searchTasks from '../utils/searchTask.js';
import taskLifecycle from '../utils/taskLifecycle.js';
import { restrictOwnedNavigation } from './owned-navigation.mjs';
import { startLiveView } from './live-view.mjs';

const stealth = StealthPlugin();
// FingerprintInjector owns these properties; avoid a second writer in stealth.
for (const evasion of ['user-agent-override', 'navigator.hardwareConcurrency', 'navigator.languages',
  'navigator.plugins', 'navigator.vendor', 'navigator.webdriver', 'webgl.vendor', 'media.codecs', 'window.outerdimensions']) {
  stealth.enabledEvasions.delete(evasion);
}
chromium.use(stealth);

export class ProxyCheckError extends Error {
  constructor() { super('Proxy connectivity check failed'); this.name = 'ProxyCheckError'; }
}

export async function runTask({ prisma, task, proxy, config, signal, onBrowser = () => {}, log = () => {}, warmupRunner = performWarmup, searchRunner = performSearchAndClick }) {
  let browser; let stagedProfile; let stopLiveView = () => {};
  try {
    signal?.throwIfAborted();
    if (task.projectId && !task.project) task = { ...task, project: await prisma.project.findUnique({ where: { id: task.projectId } }) };
    if (config.projectId) {
      const ownedHost = new URL(task.project.targetUrl).hostname;
      if (task.projectId !== config.projectId || task.taskType !== 'target' ||
          (task.searchEngine && task.searchEngine !== 'yandex') ||
          (!task.searchEngine && !(new URL(task.url).hostname === ownedHost || new URL(task.url).hostname.endsWith(`.${ownedHost}`)))) {
        throw new TaskStoppedError();
      }
    }
    const shouldContinue = async () => {
      const row = await prisma.task.findUnique({ where: { id: task.id }, select: { status: true, profileId: true, taskType: true, url: true, searchEngine: true, searchQueries: true, vitalPhrases: true, projectId: true, project: { select: { targetUrl: true } }, currentExecutions: true, targetExecutions: true, profile: { select: { status: true, isEnabled: true } } } });
      return row?.status === 'running' && row.profileId === task.profileId && row.taskType === task.taskType && row.profile.isEnabled && row.profile.status !== 'banned' && row.currentExecutions < row.targetExecutions && row.projectId === task.projectId && row.project?.targetUrl === task.project?.targetUrl &&
        ['url', 'searchEngine', 'searchQueries', 'vitalPhrases'].every(field => JSON.stringify(row[field]) === JSON.stringify(task[field]));
    };
    if (!(await shouldContinue())) throw new TaskStoppedError();
    const { profile, reused, storageStatePath } = await loadMobileProfile(config.profilesDirectory, task.profileId, task.id);
    log(reused ? 'profile_loaded' : 'profile_generated', { taskId: task.id, profileId: task.profileId, mobileOS: profile.mobileOS });
    if (!['target', 'warmup'].includes(task.taskType)) throw new Error('Unknown task type');
    let searchConfig;
    if (task.taskType === 'target') {
      try { searchConfig = searchTasks.searchTaskConfig(task); } catch { throw new SearchError('invalid_search_task'); }
    }
    const storedSettings = task.taskType === 'target' && !searchConfig && config.planMode === 'openai'
      ? await prisma.settings.findUnique({ where: { id: 1 }, select: { openaiApiKey: true } }) : null;
    const aiConfig = { ...config, openaiApiKey: storedSettings?.openaiApiKey || config.openaiApiKey };
    const actions = task.taskType === 'target' && !searchConfig
      ? config.planMode === 'openai' ? await generateActionPlan({ url: task.url, config: aiConfig, signal, log, taskId: task.id })
        : generateLocalActionPlan(config.maxDwellMs, log, task.id)
      : null;
    signal?.throwIfAborted();
    if (!(await shouldContinue())) throw new TaskStoppedError();
    await rotateProxy({ proxy, config, signal, shouldContinue, log });
    browser = await chromium.launch({
      headless: config.headless, timeout: config.navigationTimeoutMs,
      args: ['--proxy-bypass-list=<-loopback>'],
      proxy: { server: `${config.proxyScheme}://${proxy.host}:${proxy.port}`, username: proxy.username, password: proxy.password },
    });
    onBrowser(browser);
    signal?.throwIfAborted();
    const context = await createMobileContext(browser, profile, storageStatePath);
    context.setDefaultTimeout(config.navigationTimeoutMs);
    context.setDefaultNavigationTimeout(config.navigationTimeoutMs);
    if (config.projectId) await restrictOwnedNavigation(context, task.project.targetUrl, Boolean(searchConfig));
    if (config.projectId && config.runId) stopLiveView = startLiveView(context, { runId: config.runId, taskId: task.id, targetUrl: task.project.targetUrl, allowSearch: Boolean(searchConfig) });
    const page = await createMobilePage(context, profile);
    if (!(config.projectId && searchConfig)) {
      try {
        const response = await page.goto(config.projectId ? task.project.targetUrl : config.proxyCheckUrl, { waitUntil: 'domcontentloaded' });
        if (!response?.ok()) throw new ProxyCheckError();
      } catch (error) {
        if (signal?.aborted) throw error;
        throw new ProxyCheckError();
      }
    }
    if (!(await shouldContinue())) throw new TaskStoppedError();
    let activePolicy;
    const sessionCaptcha = createCaptchaHandler({ prisma, config, proxy, userAgent: profile.fingerprint.navigator.userAgent, shouldContinue, log, taskId: task.id,
      navigationPolicy: { allowCaptchaPost: url => activePolicy.allowCaptchaPost(url), clearCaptchaPost: () => activePolicy?.clearCaptchaPost() },
    });
    const makeCheckCaptcha = policy => { activePolicy = policy; return sessionCaptcha; };
    if (task.taskType === 'warmup') {
      log('session_started', { taskId: task.id, taskType: task.taskType, profileId: task.profileId, proxyId: proxy.id, mobileOS: profile.mobileOS, reused });
      await warmupRunner(page, { navigationTimeoutMs: config.navigationTimeoutMs, signal, shouldContinue, createCheckCaptcha: makeCheckCaptcha, log, taskId: task.id });
    } else {
      let response;
      if (searchConfig) {
        const result = await searchRunner(page, task, { preparePage: child => prepareMobilePage(child, profile), navigationTimeoutMs: config.navigationTimeoutMs, signal, shouldContinue, createCheckCaptcha: makeCheckCaptcha, log, ownedOnly: Boolean(config.projectId) });
        if (!result.found) {
          log('session_search_missed', { taskId: task.id, pagesVisited: result.pagesVisited });
          return false; // No successful target visit: keep prior storageState/count.
        }
      } else response = await page.goto(task.url, { waitUntil: 'domcontentloaded' });
      if (!searchConfig) {
        // Accept the target site's initial redirects, then constrain planned clicks.
        const origin = new URL(page.url()).origin;
        const navigationPolicy = await restrictNavigation(context, origin);
        const checkCaptcha = makeCheckCaptcha(navigationPolicy);
        const handledCaptcha = await checkCaptcha(page, signal);
        if (!response?.ok() && !handledCaptcha) throw new Error('Target returned a non-success HTTP response');
        const durationMs = randomInt(config.minDwellMs, config.maxDwellMs);
        log('session_started', { taskId: task.id, taskType: task.taskType, profileId: task.profileId, proxyId: proxy.id, profile: 'mobile', mobileOS: profile.mobileOS, reused, durationMs });
        await executeActionPlan(page, actions, {
          durationMs, maxDurationMs: config.maxDwellMs, navigationTimeoutMs: config.navigationTimeoutMs,
          origin, signal, shouldContinue, checkCaptcha, log, taskId: task.id,
        });
      }
    }
    signal?.throwIfAborted();
    if (!(await shouldContinue())) throw new TaskStoppedError();
    stagedProfile = await stageMobileProfile(config.profilesDirectory, profile, context);
    // Flush and close resources before recording a successful visit.
    await context.close();
    await browser.close(); browser = undefined; onBrowser(null);
    signal?.throwIfAborted();
    const result = await prisma.$transaction(async tx => {
      const result = await taskLifecycle.commitTaskExecution(tx, {
        taskId: task.id, profileId: task.profileId,
        where: { taskType: task.taskType, projectId: task.projectId, ...(task.project ? { project: { targetUrl: task.project.targetUrl } } : {}),
          url: task.url, searchEngine: task.searchEngine, searchQueries: { equals: task.searchQueries }, vitalPhrases: { equals: task.vitalPhrases } },
        completeAfterRun: task.taskType === 'warmup' || (Boolean(searchConfig) && !config.projectId),
        publish: async () => { signal?.throwIfAborted(); await stagedProfile.publish(); },
      });
      return result;
    });
    if (result.count) log('profile_saved', { taskId: task.id, profileId: task.profileId, mobileOS: profile.mobileOS, cookiesCount: stagedProfile.cookiesCount });
    log(result.count ? 'session_completed' : 'task_no_longer_active', { taskId: task.id });
    return result.count === 1;
  } finally {
    stopLiveView();
    if (browser) await browser.close().catch(() => {});
    await stagedProfile?.discard().catch(() => {});
    onBrowser(null);
  }
}

export async function pollDatabase({ prisma, config, signal, once = false, onBrowser, log = () => {}, runTaskRunner = runTask }) {
  const taskRetryAfter = new Map(); const proxyRetryAfter = new Map();
  let apiRetryAfter = 0;
  while (!signal.aborted) {
    try {
      const now = Date.now();
      for (const [key, until] of taskRetryAfter) if (until <= now) taskRetryAfter.delete(key);
      for (const [key, until] of proxyRetryAfter) if (until <= now) proxyRetryAfter.delete(key);
      const [tasks, proxies] = await Promise.all([
        prisma.task.findMany({ where: { status: 'running', ...(config.projectId ? { projectId: config.projectId } : {}), profile: { isEnabled: true, status: { not: 'banned' } } }, include: { project: true }, orderBy: [{ currentExecutions: 'asc' }, { createdAt: 'asc' }] }),
        prisma.proxy.findMany({ where: { isActive: true } }),
      ]);
      const task = tasks.find(t => t.currentExecutions < t.targetExecutions && !taskRetryAfter.has(t.id) && (t.taskType === 'warmup' || t.searchEngine || apiRetryAfter <= now));
      const availableProxies = proxies.filter(p => !proxyRetryAfter.has(p.id));
      if (!task || !availableProxies.length) {
        log('waiting', { activeTasks: tasks.length, activeProxies: proxies.length });
        if (config.projectId && !tasks.some(t => t.currentExecutions < t.targetExecutions)) { log('project_finished', { projectId: config.projectId }); return 0; }
        if (once) return 0;
        await sleep(config.pollMs, signal); continue;
      }
      const proxy = availableProxies[randomInt(0, availableProxies.length - 1)];
      try {
        const completed = await runTaskRunner({ prisma, task, proxy, config, signal, onBrowser, log });
        if (!completed) taskRetryAfter.set(task.id, Date.now() + config.cooldownMs);
        if (once) return 0;
      } catch (error) {
        if (signal.aborted) break;
        if (error instanceof TaskStoppedError) {
          log('task_stopped', { taskId: task.id });
        } else {
          if (error instanceof OpenAIPlanError) apiRetryAfter = Date.now() + config.cooldownMs;
          else if (error instanceof ProxyCheckError || error instanceof ProxyRotationError) proxyRetryAfter.set(proxy.id, Date.now() + config.cooldownMs);
          else taskRetryAfter.set(task.id, Date.now() + config.cooldownMs);
          // Avoid raw Playwright exceptions: they can include URLs or credentials.
          log('session_failed', { taskId: task.id, proxyId: proxy.id, errorType: error.name,
            ...(error instanceof OpenAIPlanError || error instanceof CaptchaError || error instanceof ProxyRotationError || error instanceof ProfileError || error instanceof SearchError ? { code: error.code } : {}),
            ...(error instanceof OpenAIPlanError && error.providerCode ? { providerCode: error.providerCode } : {}) });
          if (config.projectId && error instanceof OpenAIPlanError && ['http_401', 'http_403', 'http_429'].includes(error.code)) {
            log('project_blocked', { taskId: task.id, errorType: error.name, code: error.code, ...(error.providerCode ? { providerCode: error.providerCode } : {}) });
            return 1;
          }
          if (config.projectId && error instanceof CaptchaError && ['widget_not_detected', 'sitekey_missing', 'missing_api_key', 'solve_limit', 'captcha_reload_failed', 'image_capture_failed'].includes(error.code)) {
            log('project_blocked', { taskId: task.id, errorType: error.name, code: error.code });
            return 1;
          }
        }
        if (once) return error instanceof TaskStoppedError ? 0 : 1;
      }
      await sleep(config.pollMs, signal);
    } catch (error) {
      if (signal.aborted) break;
      log('worker_error', { errorType: error.name });
      if (once) return 1;
      await sleep(config.pollMs, signal).catch(() => {});
    }
  }
  return 0;
}
