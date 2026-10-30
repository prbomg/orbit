import donors from '../utils/donorSites.js';
import { availableDonors } from './donor-health.mjs';
import { quiesceProfilePages } from './profile-quiescence.mjs';
import { safeLogDetails } from './log-redaction.mjs';
import { createBehaviorRandom, withBehaviorRandom } from './behavior-random.mjs';
import {checkProxyIP} from './proxy-ip.mjs';
import { synchronizeBrowserRuntime } from './browser-upgrade.mjs';
import snapshots from '../utils/profileSnapshots.js';
import { reserveProjectLocation } from './project-geolocation.mjs';
import {verifySessionAfterRestart} from './session-restart-check.mjs';
import publication from '../utils/profilePublication.js';
import { recoverProfileSaves } from './profile-publication.mjs';
import {passportValidation} from './passport-validation.mjs';
import schedule from '../utils/projectSchedule.js';
import visitPolicy from '../utils/visitSettings.js';
import projectVisits from '../utils/projectVisits.js';
import { reserveSearchQuery } from './search-query-balance.mjs';
import tcp from '../utils/proxyTcp.js';
import { prepareConfiguredProxy } from './proxy-tcp.mjs';
import { preparePersistentProfile } from './persistent-profile.mjs';
import { persistentLaunchOptions, closePersistentStartupPages } from './persistent-cache.mjs';
import readiness from '../utils/profileReadiness.js';
import fp from '../utils/fingerprint.js';
import { ensurePassport } from './fingerprint-service.mjs';
import { qualifyBrowser } from './browser-qualification.mjs';
import { verifyFingerprint } from './fingerprint-check.mjs';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { randomInt, sleep, TaskStoppedError } from './behavior.mjs';
import { loadMobileProfile, createMobileContext, mobileContextOptions, createMobilePage, prepareMobilePage, stageMobileProfile, verifyRestoredSession, ProfileError } from './profiles.mjs';
import { generateActionPlan, OpenAIPlanError } from './ai-plan.mjs';
import { generateLocalActionPlan } from './local-plan.mjs';
import { executeActionPlan, restrictNavigation } from './action-executor.mjs';
import { rotateProxy, ProxyRotationError } from './proxy-rotation.mjs';
import { createCaptchaHandler } from './captcha-page.mjs';
import daily from '../utils/taskDailySchedule.js';
import { CaptchaError } from './captcha-provider.mjs';
import { performWarmup } from './warmup.mjs';
import { performSearchAndClick, interactWithTargetSite, SearchError, isMetricsRequest, injectMetricsStub } from './search.mjs';
import searchTasks from '../utils/searchTask.js';
import taskLifecycle from '../utils/taskLifecycle.js';
import { restrictOwnedNavigation } from './owned-navigation.mjs';
import { startLiveView } from './live-view.mjs';
import { startMotionEmulation } from './motion-emulation.mjs';
import { startCaptchaImageCapture } from './captcha-image.mjs';
import { claimTarget, markTargetUsed, leaseActive, renewLease, finishClaim, recoverAbandoned, prepareTargetProxy } from './pool-scheduler.mjs';
import { randomUUID } from 'node:crypto';
import { sqliteWrite, isDatabaseUnavailable } from './sqlite-write.mjs';

const stealth = StealthPlugin();
// Exclude desktop evasions and properties already managed by FingerprintInjector.
for (const evasion of [
  'chrome.app', 'chrome.csi', 'chrome.loadTimes', 'chrome.runtime', 'iframe.contentWindow',
  'user-agent-override', 'navigator.hardwareConcurrency', 'navigator.languages',
  'navigator.plugins', 'navigator.vendor', 'navigator.webdriver', 'webgl.vendor',
  'media.codecs', 'window.outerdimensions',
]) {
  stealth.enabledEvasions.delete(evasion);
}
chromium.use(stealth);

export class ProxyCheckError extends Error {
  constructor() { super('Proxy connectivity check failed'); this.name = 'ProxyCheckError'; this.code = 'proxy_check_failed'; }
}

export async function runTask(options) {
  return withBehaviorRandom(options.random || createBehaviorRandom(options.behaviorSeed), () => runTaskSession(options));
}

async function runTaskSession({ prisma, task, proxy, config, signal, profileLeaseOwner, onBrowser = () => {}, log = () => {}, warmupRunner = performWarmup, searchRunner = performSearchAndClick, checkActive, commitRun, beforeTargetVisit = async () => {}, requireSavedProfile = false, prepareProxy = prepareConfiguredProxy, beforeCommit = async () => {} }) {
  let browserStage = null; const writeLog = log;
  log = (event, details = {}) => {
    if (/^(search_|captcha_)/.test(event) && !/_(failed|blocked|failure_location)$/.test(event)) browserStage = { stage: event, at: Date.now() };
    writeLog(event, safeLogDetails(details));
  };
  let browser; let stagedProfile; let persistent; let persistentContext; let motion; let stopLiveView = () => {}; let stopImageCapture = () => {};
  try {
    signal?.throwIfAborted();
    task = { ...task, searchDepth: task.searchDepth ?? searchTasks.DEFAULT_SEARCH_DEPTH };
    if (task.projectId && !task.project) task = { ...task, project: await prisma.project.findUnique({ where: { id: task.projectId } }) };
    if (config.projectId) {
      const ownedHost = new URL(task.project.targetUrl).hostname;
      if (task.projectId !== config.projectId || task.taskType !== 'target' ||
          (task.searchEngine && !searchTasks.SEARCH_ENGINE_NAMES.includes(task.searchEngine)) ||
          (!task.searchEngine && !(new URL(task.url).hostname === ownedHost || new URL(task.url).hostname.endsWith(`.${ownedHost}`)))) {
        throw new TaskStoppedError();
      }
    }
    const shouldContinue = async () => {
      if (checkActive) return checkActive({ fresh: false });
      const row = await prisma.task.findUnique({ where: { id: task.id }, select: { status: true, profileId: true, taskType: true, url: true, searchEngine: true, searchDepth: true, searchQueries: true, vitalPhrases: true, visitSettings:true, projectId: true, project: { select: { targetUrl: true } }, currentExecutions: true, targetExecutions: true, profile: { select: { status: true, isEnabled: true, deletedAt: true } } } });
      return row?.status === 'running' && row.profileId === task.profileId && row.taskType === task.taskType && row.profile?.isEnabled && !row.profile?.deletedAt && row.profile?.status !== 'banned' && row.currentExecutions < row.targetExecutions && row.projectId === task.projectId && row.project?.targetUrl === task.project?.targetUrl &&
        ['url', 'searchEngine', 'searchDepth', 'searchQueries', 'vitalPhrases','visitSettings'].every(field => JSON.stringify(row[field]) === JSON.stringify(task[field]));
    };
    if (!(await shouldContinue())) throw new TaskStoppedError();
    await recoverProfileSaves(prisma, config.profilesDirectory, { profileId: task.profileId, owner: profileLeaseOwner, maxProfileBytes: config.maxProfileBytes, log });
    let { profile, savedSnapshot, reused, storageStatePath } = await loadMobileProfile(config.profilesDirectory, task.profileId, task.id, undefined, { maxProfileBytes: config.maxProfileBytes });
    if (requireSavedProfile && (!reused || !profile.savedAt)) throw new ProfileError('profile_not_warmed');
    let passport = await ensurePassport({ prisma, profileId: task.profileId, proxy, existing: reused ? profile : null, signal });
    const projectLocation = task.taskType === 'target' && task.project
      ? await sqliteWrite(prisma, tx => reserveProjectLocation(tx, task.project, task.profileId)) : null;
    if (projectLocation) passport = { ...passport, projectLocations: { ...passport.projectLocations, [task.projectId]: projectLocation } };
    if (!reused) profile = fp.profileFromPassport(task.profileId, passport);
    if (snapshots.passportHash(profile) !== fp.identityHash(task.profileId, passport)) throw new ProfileError('profile_snapshot_mismatch');
    log(reused ? 'profile_loaded' : 'profile_generated', { taskId: task.id, profileId: task.profileId, mobileOS: profile.mobileOS });
    if (!['target', 'warmup'].includes(task.taskType)) throw new Error('Unknown task type');
    let searchConfig;
    if (task.taskType === 'target') {
      try { searchConfig = searchTasks.searchTaskConfig(task); } catch { throw new SearchError('invalid_search_task'); }
    }
    const visitSettings=task.taskType==='target'?visitPolicy.visitSettings(task.visitSettings||{}):null;
    const storedSettings = task.taskType === 'target' && !searchConfig && !visitSettings && config.planMode === 'openai'
      ? await prisma.settings.findUnique({ where: { id: 1 }, select: { openaiApiKey: true } }) : null;
    const aiConfig = { ...config, openaiApiKey: storedSettings?.openaiApiKey || config.openaiApiKey };
    const actions = task.taskType === 'target' && !searchConfig && !visitSettings
      ? config.planMode === 'openai' ? await generateActionPlan({ url: task.url, config: aiConfig, signal, log, taskId: task.id })
        : generateLocalActionPlan(config.maxDwellMs, log, task.id)
      : null;
    signal?.throwIfAborted();
    if (!(await shouldContinue())) throw new TaskStoppedError();
    if (!tcp.compatible(proxy, profile)) throw new ProxyRotationError('tcp_os_mismatch');
    await prepareProxy({ prisma, proxy, config, signal, shouldContinue, log });
    const storedProfile = await prisma.profile.findUnique({ where: { id: task.profileId }, select: { storageMode: true, storageResetRequested: true, snapshotId: true } });
    const launchOptions = {
      executablePath: config.chromiumExecutablePath, headless: config.headless, timeout: config.navigationTimeoutMs,
      args: ['--proxy-bypass-list=<-loopback>'],
      proxy: { server: `${config.proxyScheme}://${proxy.host}:${proxy.port}`, username: proxy.username, password: proxy.password },
    };
    if (storedProfile?.storageMode === 'persistent') {
      const seedProfile = reused && profile.snapshot?.storageMode === 'snapshot' ? savedSnapshot : undefined;
      persistent = await preparePersistentProfile(config.profilesDirectory, task.profileId, { seedProfile,
        ...(seedProfile && storedProfile.snapshotId ? { expectedSnapshotId: storedProfile.snapshotId } : {}) });
      persistentContext = await chromium.launchPersistentContext(persistent.path, { ...persistentLaunchOptions(launchOptions, profile), ...mobileContextOptions(profile, projectLocation) });
      browser = persistentContext.browser();
      await closePersistentStartupPages(persistentContext);
    } else browser = await chromium.launch(launchOptions);
    await onBrowser(browser);
    log('proxy_configured', { taskId: task.id, executionId: task.executionId, proxyId: proxy.id, proxyHost: proxy.host, proxyPort: proxy.port, proxyScheme: config.proxyScheme });
    let qualification;
    if (persistentContext) {
      const controlBrowser = await chromium.launch(launchOptions);
      try { qualification = await qualifyBrowser({ prisma, browser: controlBrowser, signal }); }
      finally { await controlBrowser.close(); }
      if (browser.version() !== qualification.runtimeVersion) throw new ProfileError('browser_runtime_changed');
    } else qualification = await qualifyBrowser({ prisma, browser, signal });
    signal?.throwIfAborted();
    const upgrade = synchronizeBrowserRuntime(task.profileId, passport, { runtimeVersion: browser.version(),
      nativeBrands: qualification.report.nativeBrands, nativeFullVersionList: qualification.report.nativeFullVersionList });
    passport = upgrade.passport;
    profile = { ...profile, fingerprint: passport.fingerprint, headers: passport.headers };
    if (upgrade.changed) {
      await sqliteWrite(prisma, tx => tx.profile.update({ where: { id: task.profileId }, data: { fingerprint: passport, fingerprintHash: fp.identityHash(task.profileId, passport) } }));
      log(reused ? 'profile_browser_upgraded' : 'profile_browser_bound', { profileId: task.profileId, fromVersion: upgrade.fromVersion, toVersion: upgrade.toVersion });
      if (persistentContext) {
        await persistentContext.close();
        persistentContext = await chromium.launchPersistentContext(persistent.path, { ...persistentLaunchOptions(launchOptions, profile), ...mobileContextOptions(profile, projectLocation) });
        browser = persistentContext.browser();
        await onBrowser(browser);
        await closePersistentStartupPages(persistentContext);
        if (browser.version() !== qualification.runtimeVersion) throw new ProfileError('browser_runtime_changed');
      }
    }
    const checkingSession = requireSavedProfile || (task.taskType === 'warmup' && (task.warmupStage || 1) > 1);
    if (checkingSession && storedProfile.snapshotId && storedProfile.snapshotId !== profile.snapshot?.id) throw new ProfileError('profile_snapshot_mismatch');
    if (snapshots.passportHash(profile) !== fp.identityHash(task.profileId, passport)) throw new ProfileError('profile_snapshot_mismatch');
    if (persistent?.snapshotId && persistent.snapshotId !== profile.snapshot?.id) throw new ProfileError('profile_storage_version_mismatch');
    if (persistent?.initialized && persistent.savedAt !== profile.savedAt) throw new ProfileError('profile_storage_version_mismatch');
    passport = { ...passport, validation: passportValidation(passport, browser.version()) };
    if (passport.validation.status !== 'passed') throw new ProfileError('passport_invalid');
    await sqliteWrite(prisma, tx => tx.profile.update({ where: { id: task.profileId }, data: { fingerprint: passport } }));
    let context;
    try {
      if (persistent?.seedSnapshotId) {
        const report = await persistent.seed(persistentContext);
        log('profile_storage_seeded', { profileId: task.profileId, sourceSnapshotId: persistent.seedSnapshotId, cookiesCount: report.activeCookiesCount, originsCount: report.originsCount });
      }
      if (passport.projectLocations) profile.passport = { timezone: passport.timezone ?? null, seed: passport.seed, ...profile.passport, projectLocations: passport.projectLocations };
      context = await createMobileContext(browser, profile, storageStatePath, persistentContext, !persistent?.initialized && !persistent?.seedSnapshotId, projectLocation, task.project);
    }
    catch (error) {
      if (!checkingSession) throw error;
      const failure = new ProfileError('profile_session_verification_failed');
      const report = { version: 1, status: 'failed', checkedAt: new Date().toISOString(), sourceSavedAt: profile.savedAt, errorCode: failure.code };
      if (await shouldContinue()) await sqliteWrite(prisma, tx => tx.profile.update({ where: { id: task.profileId }, data: { sessionCheck: report } }));
      throw failure;
    }
    if (checkingSession) {
      let report;
      try { report = { ...await verifyRestoredSession(context, profile, { discoverOrigins: Boolean(persistentContext) }), processRestartVerified: true, verificationVersion: readiness.VERIFICATION_VERSION, runtimeVersion: browser.version(), storageMode: storedProfile.storageMode }; }
      catch (error) {
        if (error.diagnostics && await shouldContinue()) await sqliteWrite(prisma, tx => tx.profile.update({ where: { id: task.profileId }, data: { sessionCheck: error.diagnostics } }));
        throw error;
      }
      if (!(await shouldContinue())) throw new TaskStoppedError();
      await sqliteWrite(prisma, tx => tx.profile.update({ where: { id: task.profileId }, data: { sessionCheck: report } }));
      log('warmup_session_check', { taskId: task.id, cookiesCount: report.activeCookiesCount, originsCount: report.originsCount, indexedDBRecordsCount: report.indexedDBRecordsCount });
    }
    stopImageCapture = startCaptchaImageCapture(context);
    context.setDefaultTimeout(config.navigationTimeoutMs);
    context.setDefaultNavigationTimeout(config.navigationTimeoutMs);
    motion = startMotionEmulation(context, { mode: config.motionMode ?? 'quiet-held', signal, log, taskId: task.id });
    const page = await createMobilePage(context, profile);
    await motion.prepare(page);
    const channel = proxy.tcpChannelId ? await prisma.proxyTcpChannel.findUnique({ where: { id: proxy.tcpChannelId } }) : null;
    const network = channel ? { status: channel.status === 'applied' ? 'passed' : 'pending', checkedAt: channel.checkedAt?.toISOString() || null, generation: channel.generation } : { status: 'pending' };
    await verifyFingerprint({ prisma, page, profile, runtimeVersion: browser.version(), network,
      transportOptions:{endpoint:config.networkProbeUrl,http3Endpoint:config.networkHttp3Url,referenceFile:config.networkReferenceFile,timeoutMs:config.networkProbeTimeoutMs??12000,proxyScheme:config.proxyScheme,signal} });
    log('fingerprint_verified', { taskId: task.id, profileId: task.profileId, source: passport.source });
    const proxyObservation = await checkProxyIP(context, { proxy, config, signal, log: (event, details) => log(event, { taskId: task.id, executionId: task.executionId, ...details }) });
    const ownedNavigation = config.projectId ? await restrictOwnedNavigation(context, task.project.targetUrl, searchConfig?.searchEngine || false) : null;
    if (config.projectId && config.runId) stopLiveView = startLiveView(context, { runId: config.runId, taskId: task.id, executionId: task.executionId, targetUrl: task.project.targetUrl, searchEngine: searchConfig?.searchEngine || false });
    if (!config.projectId && !(task.taskType === 'warmup' && proxyObservation)) {
      try {
        if (task.taskType === 'target' && config.projectId) await beforeTargetVisit();
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
      log('warmup_run_context', { model: passport.deviceTemplate?.id || passport.fingerprint?.navigator?.userAgentData?.model || 'unknown', storageMode: storedProfile.storageMode });
      log('session_started', { taskId: task.id, taskType: task.taskType, profileId: task.profileId, proxyId: proxy.id, mobileOS: profile.mobileOS, reused });
      const warmupStage = task.warmupStage || 1;
      if (!task.verificationOnly) {
        await warmupRunner(page, { ...config.warmupDonorPolicy, intent: config.warmupIntent || '', sites: config.warmupSites, requiredSites: config.warmupRequiredSites, requirements: config.warmupRequirements, siteHistory: config.warmupSiteHistory, preferredDomains: config.warmupReturnDomains, sessionMinutes: config.warmupSessionMinutes || 0, navigationTimeoutMs: config.navigationTimeoutMs, operationTimeoutMs: config.warmupOperationTimeoutMs, siteTimeoutMs: config.warmupSiteTimeoutMs, cleanupTimeoutMs: config.warmupCleanupTimeoutMs, signal, shouldContinue, createCheckCaptcha: makeCheckCaptcha, log, taskId: task.id });
      } else if (warmupStage === 3) {
        // Restoration was checked before the proxy-check page was opened.
      } else {
        log('warmup_final_fingerprint', { taskId: task.id, source: passport.source });
      }
    } else {
      const onTargetVisit = async ({query=null,actualQuery=null,visitedAt=new Date()}={}) => {
        await sqliteWrite(prisma, tx => projectVisits.recordProjectVisit(tx,{projectId:task.projectId,taskId:task.id,executionId:task.executionId,query,actualQuery,engine:task.searchEngine,visitedAt}));
      };
      let response;
      if (searchConfig) {
        const result = await searchRunner(page, task, {
          preSearchWarmup: config.preSearchWarmup ?? true,
          preSearchTimeoutMs: config.preSearchTimeoutMs,
          allowPreSearchSite: origin => {
            const revokeNavigation = ownedNavigation?.allowTemporarySite(origin);
            const revokeObservation = stopLiveView.allowTemporarySite?.(origin);
            return () => { try { revokeObservation?.(); } finally { revokeNavigation?.(); } };
          },
          resolvePreSearchSites: async () => {
            const sites = config.preSearchSites ?? config.warmupSites ?? donors.resolveDonorSites(await prisma.settings.findUnique({ where: { id: 1 }, select: { warmupSites: true } }));
            return availableDonors(prisma, proxy, sites);
          },
          captureFailure: (failedPage, details) => stopLiveView.captureFailure?.(failedPage, { ...details, ...(browserStage ? { stage: browserStage.stage, elapsedMs: Math.max(0, Date.now() - browserStage.at) } : {}) }), selectQuery: queries => reserveSearchQuery(prisma, task, queries), preparePage: async child => { await prepareMobilePage(child, profile); await motion.prepare(child); }, navigationTimeoutMs: config.navigationTimeoutMs, signal, shouldContinue, createCheckCaptcha: makeCheckCaptcha, log, beforeTargetVisit, onTargetVisit, ownedOnly: Boolean(config.projectId) });
        if (!result.found) {
          log('session_search_missed', { taskId: task.id, pagesVisited: result.pagesVisited });
          return false; // No successful target visit: keep prior storageState/count.
        }
      } else {
        await beforeTargetVisit();
        const disableMetrics = Boolean(visitSettings?.disableMetrics || visitSettings?.trackMetrics === false);
        if (disableMetrics) {
          await injectMetricsStub(page);
          await context.route('**/*', async route => {
            if (isMetricsRequest(route.request().url())) await route.abort('blockedbyclient');
            else await route.fallback();
          });
          log('target_metrics_disabled', { taskId: task.id });
        }
        response = await page.goto(task.url, { waitUntil: 'domcontentloaded' });
      }
      if (!searchConfig) {
        const origin = new URL(page.url()).origin;
        const navigationPolicy = await restrictNavigation(context, origin);
        const checkCaptcha = makeCheckCaptcha(navigationPolicy);
        const handledCaptcha = await checkCaptcha(page, signal);
        if (!response?.ok() && !handledCaptcha) throw new Error('Target returned a non-success HTTP response');
        await onTargetVisit();
        const durationMs = visitSettings?randomInt(visitSettings.minSeconds*1000,visitSettings.maxSeconds*1000):randomInt(config.minDwellMs, config.maxDwellMs);
        log('session_started', { taskId: task.id, taskType: task.taskType, profileId: task.profileId, proxyId: proxy.id, profile: 'mobile', mobileOS: profile.mobileOS, reused, durationMs });
        if(visitSettings){
          let currentResponse=handledCaptcha?null:response;
          const listener=value=>{try{if(value.request().isNavigationRequest()&&value.frame()===page.mainFrame())currentResponse=value;}catch{}};
          page.on('response',listener);
          const check=async()=>{signal?.throwIfAborted();if(!(await shouldContinue()))throw new TaskStoppedError();return checkCaptcha(page,signal);};
          const session={timeout:config.navigationTimeoutMs,signal,now:()=>Date.now(),log:(event,details={})=>log(event,{taskId:task.id,...details}),check,
            document:async()=>{const handled=await check();if(currentResponse&&!currentResponse.ok()&&!handled)throw new SearchError('target_http_error');},
            pause:async ms=>{const end=Date.now()+ms;while(Date.now()<end){await check();await sleep(Math.min(500,Math.max(0,end-Date.now())),signal);}}
          };
          try{await interactWithTargetSite(page,{targetDomain:new URL(task.project?.targetUrl||page.url()).hostname,visitSettings,intent:Array.isArray(task.targetKeywords)?task.targetKeywords.join(" "):""},session,{durationMs});}finally{page.off('response',listener);}
        }else await executeActionPlan(page, actions, {
          durationMs, maxDurationMs: config.maxDwellMs, navigationTimeoutMs: config.navigationTimeoutMs,
          origin, signal, shouldContinue, checkCaptcha, log, taskId: task.id,
        });
      }
    }
    signal?.throwIfAborted();
    if (!(await shouldContinue())) throw new TaskStoppedError();
    await stopLiveView(); stopLiveView = () => {};
    await motion.stop();
    await quiesceProfilePages(context, { signal });
    stagedProfile = await stageMobileProfile(config.profilesDirectory, profile, context, { maxProfileBytes: config.maxProfileBytes, storageMode: storedProfile.storageMode, warmupStage: task.taskType === 'warmup' && !task.verificationOnly ? task.warmupStage || 1 : profile.snapshot?.warmupStage });
    if (checkingSession && !stagedProfile.summary.hasData) {
      const error = new ProfileError('profile_session_empty');
      await sqliteWrite(prisma, tx => tx.profile.update({ where: { id: task.profileId }, data: { sessionCheck: { version: 1, status: 'failed', checkedAt: new Date().toISOString(), sourceSavedAt: profile.savedAt, errorCode: error.code, ...stagedProfile.summary } } }));
      throw error;
    }
    await context.close();
    await browser.close(); browser = undefined; onBrowser(null);
    try {
      stagedProfile.summary.sessionCheck = await verifySessionAfterRestart(stagedProfile, { launchOptions, persistentPath: persistent?.path, signal, onBrowser });
      if (task.taskType === 'warmup') log('warmup_storage_check', { result: 'passed', source: 'process_restart' });
    } catch (error) {
      if (task.taskType === 'warmup') log('warmup_storage_check', { result: 'failed', source: 'process_restart', reason: error.code });
      if (error.diagnostics && await shouldContinue()) await sqliteWrite(prisma, tx => tx.profile.update({ where: { id: task.profileId }, data: { sessionCheck: error.diagnostics } }));
      throw error;
    }
    signal?.throwIfAborted();
    await beforeCommit();
    await persistent?.seal(stagedProfile.snapshot.savedAt, stagedProfile.snapshot.snapshot.id);
    const result = await sqliteWrite(prisma, async tx => {
      await tx.$executeRaw`UPDATE "Settings" SET "id"="id" WHERE "id"=1`;
      const publish = async () => {
        signal?.throwIfAborted();
        await publication.publishProfileFiles({ directory: config.profilesDirectory, profileId: task.profileId,
          maxProfileBytes: config.maxProfileBytes, stagedPath: stagedProfile.temporary, persistentPath: persistent?.path,
          previousSnapshotId: storedProfile.snapshotId, nextSnapshotId: stagedProfile.snapshot.snapshot.id });
        await tx.profile.update({ where: { id: task.profileId }, data: { snapshotId: stagedProfile.snapshot.snapshot.id, storageResetRequested: false } });
      };
      if (commitRun) return commitRun(tx, publish, stagedProfile.summary);
      if (stagedProfile.summary.sessionCheck) await tx.profile.update({ where: { id: task.profileId }, data: { sessionCheck: stagedProfile.summary.sessionCheck } });
      const result = await taskLifecycle.commitTaskExecution(tx, {
        taskId: task.id, profileId: task.profileId,
        where: { taskType: task.taskType, projectId: task.projectId, ...(task.project ? { project: { targetUrl: task.project.targetUrl } } : {}),
          url: task.url, visitSettings:{equals:task.visitSettings||{}}, searchEngine: task.searchEngine, searchDepth: task.searchDepth ?? searchTasks.DEFAULT_SEARCH_DEPTH, searchQueries: { equals: task.searchQueries }, vitalPhrases: { equals: task.vitalPhrases } },
        completeAfterRun: task.taskType === 'warmup' || (Boolean(searchConfig) && !config.projectId),
        publish,
      });
      return result;
    });
    if (result.count) log('profile_saved', { taskId: task.id, profileId: task.profileId, mobileOS: profile.mobileOS, cookiesCount: stagedProfile.cookiesCount });
    log(result.count ? 'session_completed' : 'task_no_longer_active', { taskId: task.id });
    return result.count === 1;
  } finally {
    await stopLiveView();
    stopImageCapture();
    if (browser) await browser.close().catch(() => {});
    await motion?.stop().catch(() => {});
    await recoverProfileSaves(prisma, config.profilesDirectory, { profileId: task.profileId, owner: profileLeaseOwner, maxProfileBytes: config.maxProfileBytes, log }).catch(() => {});
    await persistent?.discard().catch(() => {});
    await stagedProfile?.discard().catch(() => {});
    onBrowser(null);
  }
}

/** Local poll gate; the persistent Retry-After deadline remains uncapped in finishClaim. */
export function rateLimitCooldownMs(config, retryDelayMs) {
  const maximum = config.maxRateLimitCooldownMs ?? 180_000;
  const minimum = Math.min(maximum, config.rateLimitCooldownMs ?? 30_000);
  const requested = Number.isFinite(retryDelayMs) ? retryDelayMs : minimum;
  return Math.max(minimum, Math.min(requested, maximum));
}

async function executeClaim({ prisma, claim, config, signal, onBrowser, log, runTaskRunner, cooldown }) {
      const sessionLog = (event, details = {}) => log(event, { ...details, taskId: claim.task.id, profileId: claim.task.profileId, executionId: claim.task.executionId });
      const controller = new AbortController(); let activeBrowser;
      const abort = () => { controller.abort(); void activeBrowser?.close().catch(() => {}); };
      signal.addEventListener('abort', abort, { once: true });
      let renewing = false;
      const heartbeat = setInterval(() => {
        if (renewing) return;
        renewing = true;
        void renewLease(prisma, claim).then(ok => { if (!ok) abort(); }).catch(error => {
          sessionLog('worker_error', { errorType: error.name, code: isDatabaseUnavailable(error) ? 'database_busy' : 'lease_renewal_failed' });
          if (!isDatabaseUnavailable(error)) abort();
        }).finally(() => { renewing = false; });
      }, 15_000);
      let success = false; let errorCode = null; let stopped = false; let proxyFailed = false;
      let errorType = 'Error', providerCode, retryDelayMs = config.cooldownMs ?? 60_000;
      try {
        const checkActive = async () => {
          if (!await leaseActive(prisma, claim)) return false;
          const row = await prisma.task.findUnique({ where: { id: claim.task.id }, include: { project: true } });
          const execution = await prisma.taskExecution.findUnique({ where: { id: claim.task.executionId }, include: { profile: true } });
          return row?.status === 'running' && row.currentExecutions < row.targetExecutions && execution?.status === 'running' && execution.profileId === claim.task.profileId && readiness.confirmed(execution.profile) && row.project?.targetUrl === claim.task.project.targetUrl &&
            ['url','searchEngine','searchDepth','searchQueries','vitalPhrases','visitSettings'].every(k => JSON.stringify(row[k]) === JSON.stringify(claim.task[k]));
        };
        sessionLog('execution_allocated');
        success = await runTaskRunner({ prisma, task: claim.task, proxy: claim.proxy, config, signal: controller.signal,
          checkActive, profileLeaseOwner: claim.owner, requireSavedProfile: true, beforeTargetVisit: () => markTargetUsed(prisma, claim),
          prepareProxy: options => prepareTargetProxy(prisma, claim, options),
          commitRun: async (tx, publish, summary = {}) => {
            if (!await leaseActive(tx, claim)) return { count: 0 };
            const used = await tx.projectProfileUse.findUnique({ where: { projectId_profileId: { projectId: claim.task.projectId, profileId: claim.task.profileId } } });
            if (!used?.usedAt) return { count: 0 };
            const current = await tx.task.findUnique({ where: { id: claim.task.id }, include: { project: true } });
            const execution = await tx.taskExecution.findUnique({ where: { id: claim.task.executionId }, include: { profile: true } });
            if (execution?.status !== 'running' || execution.profileId !== claim.task.profileId || !readiness.confirmed(execution.profile) || current?.project?.targetUrl !== claim.task.project.targetUrl || ['projectId','url','searchEngine','searchDepth','searchQueries','vitalPhrases','visitSettings'].some(k => JSON.stringify(current[k]) !== JSON.stringify(claim.task[k]))) return { count: 0 };
            if (!readiness.attestable({ ...execution.profile, sessionCheck: summary.sessionCheck }, { state: 'saved', ...summary }, null)) return { count: 0 };
            const settings = await tx.settings.findUnique({ where: { id: 1 }, select: { readinessFreshnessHours: true } });
            const verifiedAt = new Date();
            await tx.profile.update({ where: { id: claim.task.profileId }, data: { sessionCheck: summary.sessionCheck, readinessVersion: readiness.VERIFICATION_VERSION, readinessVerifiedAt: verifiedAt, readinessValidUntil: new Date(verifiedAt.getTime() + (settings?.readinessFreshnessHours ?? 72) * 3600000) } });
            return taskLifecycle.commitTaskExecution(tx, { taskId: claim.task.id, profileId: claim.task.profileId, publish, executionId: claim.task.executionId });
          },
          onBrowser: browser => { const previous = activeBrowser; activeBrowser = browser; onBrowser(browser, previous); }, log: sessionLog });
        if (!success) { errorCode = 'target_not_found'; cooldown.set(claim.task.id, Date.now() + config.cooldownMs); }
      } catch (error) {
        stopped = controller.signal.aborted || error instanceof TaskStoppedError;
        proxyFailed = error instanceof ProxyCheckError || error instanceof ProxyRotationError;
        errorCode = stopped ? 'stopped' : isDatabaseUnavailable(error) ? 'database_busy' : typeof error.code === 'string' ? error.code : 'execution_failed';
        errorType = error.name; providerCode = error.providerCode;
        if (error.code === 'search_rate_limited') retryDelayMs = Math.max(retryDelayMs, error.retryDelayMs || 0);
        if (errorCode === 'search_rate_limited') {
          const durationMs = rateLimitCooldownMs(config, retryDelayMs);
          cooldown.set(claim.task.id, Math.max(cooldown.get(claim.task.id) || 0, Date.now() + durationMs));
          sessionLog('search_rate_limit_cooldown', { durationMs });
        }
        else cooldown.set(claim.task.id, Date.now() + config.cooldownMs);
        sessionLog('session_failed', { errorType: error.name, code: errorCode, ...(error.providerCode ? { providerCode: error.providerCode } : {}) });
        if (error instanceof ProfileError) {
          await sqliteWrite(prisma, async tx => {
            if (!await leaseActive(tx, claim)) return;
            await tx.profile.update({ where: { id: claim.task.profileId }, data: { status: 'failed', warmedAt: null } });
            await tx.warmupJob.upsert({ where: { profileId: claim.task.profileId }, create: { profileId: claim.task.profileId, status: 'failed', errorCode }, update: { status: 'failed', errorCode } });
          });
        }
      } finally {
        clearInterval(heartbeat); signal.removeEventListener('abort', abort);
        const result = await finishClaim(prisma, claim, { success, errorCode, errorType, providerCode, retryDelayMs, stopped, proxyFailed });
        if (!success && !stopped && result) sessionLog(result.taskStopped ? 'task_retry_exhausted' : result.retryState.recovery === 'rotate_proxy' ? 'search_rate_limit_rotate' : result.retryState.recovery === 'replace_proxy' ? 'search_rate_limit_replace' : 'task_retry_scheduled', {
          errorType, code: result.retryState.code, attempt: result.retryState.count, total: 5,
          ...(result.retryState.retryAfter ? { durationMs: Math.max(0, Date.parse(result.retryState.retryAfter) - Date.now()) } : {}),
        });
      }
      return { blocked: false, exitCode: success || stopped ? 0 : 1 };
}

export async function pollDatabase({ prisma, config, signal, once = false, onBrowser = () => {}, log = () => {}, runTaskRunner = runTask }) {
  const demandOwner = randomUUID(), cooldown = new Map(), active = new Set();
  const blocked = new AbortController();
  const combined = AbortSignal.any([signal, blocked.signal]);
  let blockedResult = 0, lastRecovery = 0;
  try {
    while (!combined.aborted) {
      try {
        if (Date.now() - lastRecovery > 60_000) { await recoverAbandoned(prisma); lastRecovery = Date.now(); }
        const tasks = await prisma.task.findMany({ where: { taskType: 'target', status: 'running', ...(config.projectId ? { projectId: config.projectId } : {}) }, include: { project: true }, orderBy: [{ currentExecutions: 'asc' }, { createdAt: 'asc' }] });
        const pending = tasks.filter(task => task.currentExecutions < task.targetExecutions);
        if (config.projectId && !pending.length) {
          if (active.size) { await Promise.race(active); continue; }
          const failures = await prisma.task.findMany({ where: { projectId: config.projectId, status: 'failed' }, select: { retryState: true } });
          log(failures.some(task => task.retryState?.count >= 5) ? 'project_tasks_stopped' : 'project_finished', { projectId: config.projectId }); return 0;
        }
        let claim = null; const unavailable = [];
        for (const task of pending) {
          if ((cooldown.get(task.id) || 0) > Date.now()) { unavailable.push({ reason: 'retry_pause', nextAt: new Date(cooldown.get(task.id)).toISOString() }); continue; }
          claim = await claimTarget(prisma, task.id, demandOwner, undefined, detail => unavailable.push(detail));
          if (claim) break;
        }
        if (claim && combined.aborted) { await finishClaim(prisma, claim, { stopped: true, errorCode: 'stopped' }); break; }
        if (claim) {
          const work = executeClaim({ prisma, claim, config, signal: combined, onBrowser, log, runTaskRunner, cooldown })
            .catch(error => { log('worker_error', { errorType: error.name, code: isDatabaseUnavailable(error) ? 'database_busy' : 'execution_failed', taskId: claim.task.id });cooldown.set(claim.task.id, Date.now() + (config.cooldownMs ?? 60_000));return { exitCode: 1 }; });
          active.add(work); void work.finally(() => active.delete(work));
          if (once) { const result = await work; return result?.exitCode ?? blockedResult; }
          continue;
        }
        if (!active.size) {
          const open = pending.filter(task => schedule.isAllowed(task.project));
          const states = await Promise.all(open.map(task => daily.dailyState(prisma, task)));
          const reason = !pending.length ? 'no_tasks' : !open.length ? 'schedule'
            : states.every(state => !state.allowed) ? states.every(state => state.reason === 'daily_limit') ? 'daily_limit' : 'daily_schedule'
            : unavailable.length && unavailable.every(item => item.reason === unavailable[0].reason) ? unavailable[0].reason : 'profiles_or_proxies';
          const nextAt = unavailable.map(item => item.nextAt).filter(Boolean).sort()[0] || null;
          log('waiting', { reason, activeTasks: pending.length, nextAt, nextCheckAt: new Date(Date.now() + config.pollMs).toISOString() });
        }
        if (once) return 0;
        await Promise.race([sleep(config.pollMs, combined).catch(() => {}), ...active]);
      } catch (error) {
        if (combined.aborted) break;
        log('worker_error', { errorType: error.name, code: isDatabaseUnavailable(error) ? 'database_busy' : 'execution_failed' });
        if (once) return 1;
        await sleep(config.pollMs, combined).catch(() => {});
      }
    }
    return blockedResult;
  } finally {
    await Promise.allSettled(active);
    await prisma.workflowLease.deleteMany({ where: { key: { in: [`target-demand:${demandOwner}`, 'target-demand'] }, owner: demandOwner } });
  }
}