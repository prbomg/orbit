import { safeLogDetails } from './log-redaction.mjs';
import cookieAge from '../utils/cookieAge.js';
import { basename } from 'node:path';
import { realpathSync } from 'node:fs';
import {availableDonors,reserveDonor,finishDonor,releaseDonor} from './donor-health.mjs';
import schedule from '../utils/projectSchedule.js';
import { chromium } from 'playwright-extra';
import { qualifyBrowser } from './browser-qualification.mjs';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { loadConfig } from './config.mjs';
import { acquireLock } from './lock.mjs';
import { sleep, TaskStoppedError } from './behavior.mjs';
import { ProxyRotationError } from './proxy-rotation.mjs';
import { runTask, ProxyCheckError } from './runner.mjs';
import { claimWarmup, leaseActive, renewLease, finishClaim, recoverAbandoned, prepareWarmupProxy } from './pool-scheduler.mjs';
import journal from '../utils/warmupJournal.js';
import { sqliteWrite, serializeSqlite, isDatabaseUnavailable, measureSqliteWrites, sqliteTelemetryBuffer } from './sqlite-write.mjs';
import { performance } from 'node:perf_hooks';
import { withDeadline, warmupLimits, WarmupTimeoutError, cachedCheck } from './warmup-timing.mjs';
import { browserCleanup } from './browser-cleanup.mjs';
import pool from '../utils/profilePool.js';
import plans from '../utils/warmupPlan.js';
import readiness from '../utils/profileReadiness.js';
import { maintainReadiness } from './readiness-service.mjs';
import { recoverProfileSaves } from './profile-publication.mjs';
import donors from '../utils/donorSites.js';
import { pathToFileURL } from 'node:url';

const settingsReaders = new WeakMap();
function readWarmupSettings(prisma) {
  if (!settingsReaders.has(prisma)) settingsReaders.set(prisma, cachedCheck(() => prisma.settings.findUnique({ where: { id: 1 }, select: { warmupEnabled: true } })));
  return settingsReaders.get(prisma)();
}
export function executeWarmup(options) {
  const metrics = { writesCount: 0, failedWrites: 0, queueMs: 0, transactionMs: 0, maxQueueMs: 0, maxTransactionMs: 0 };
  return measureSqliteWrites(() => executeMeasuredWarmup({ ...options, metrics }), sample => {
    metrics.writesCount++; if (sample.failed) metrics.failedWrites++;
    metrics.queueMs += sample.queueMs; metrics.transactionMs += sample.transactionMs;
    metrics.maxQueueMs = Math.max(metrics.maxQueueMs, sample.queueMs);
    metrics.maxTransactionMs = Math.max(metrics.maxTransactionMs, sample.transactionMs);
  });
}
async function executeMeasuredWarmup({ prisma, claim, config, signal, metrics, runner = runTask, log = () => {} }) {
  const runStarted = performance.now();
  const controller = new AbortController(); let browser;
  const cleanupMs = config.warmupCleanupTimeoutMs ?? warmupLimits.cleanupMs;
  const cleanup = browserCleanup({ cleanupMs, log: event => log(event, { jobId: claim.job.id }) });
  const abort = () => { controller.abort(); void browser?.close().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const heartbeat = setInterval(() => { void renewLease(prisma, claim).then(ok => { if (!ok) abort(); }).catch(abort); }, 15_000);
  let timedOut = false;
  const runMs = config.warmupRunTimeoutMs ?? warmupLimits.runMs;
  let errorCode = null, stopped = false, proxyFailed = false, lastOperation = 'prepare';
  const job = claim.job;
  const plan = plans.planFor(job);
  const execution = plans.executionOptions(plan, job.currentStage);
  const journalContext = journal.claimContext(claim);
  const readActive = async (fresh = false) => {
    if (controller.signal.aborted) return false;
    const current = await prisma.warmupJob.findUnique({ where: { id: job.id }, select: { status: true, owner: true, profile: { select: { isEnabled: true, deletedAt: true, status: true } } } });
    const settings = fresh ? await prisma.settings.findUnique({ where: { id: 1 }, select: { warmupEnabled: true } }) : await readWarmupSettings(prisma);
    return (!settings || settings.warmupEnabled) && current?.status === 'running' && current.owner === claim.owner && current.profile.isEnabled && !current.profile.deletedAt && current.profile.status !== 'banned' && await leaseActive(prisma, claim);
  };
  const cachedActive = cachedCheck(readActive, { ttlMs: 500 });
  const checkActive = ({ fresh = true } = {}) => fresh ? readActive(true) : cachedActive();
  const metadata = { release: basename(realpathSync(new URL('..', import.meta.url))), model: job.profile?.fingerprint?.deviceTemplate?.id || 'unknown', storageMode: job.profile?.storageMode || 'unknown', preset: plan.preset || (plan.mode === 'verification' ? 'verification' : 'legacy') };
  const buffered = sqliteTelemetryBuffer(prisma, async (tx, entries, data) => {
    if (entries.length) await tx.profileWarmupEvent.createMany({ data: entries });
    if (Object.keys(data).length) await tx.warmupJob.updateMany({ where: { id: job.id, status: 'running', owner: claim.owner }, data });
  });
  buffered.push(journal.journalEntry(journalContext, 'warmup_run_context', metadata));
  let flushTimer;
  const flushEvents = () => {
    clearTimeout(flushTimer); flushTimer = undefined;
    return buffered.flush();
  };
  try {
    const settings = await prisma.settings.findUnique({ where: { id: 1 }, select: { warmupSites: true, warmupSitePauses: true } });
    const pauses = Array.isArray(settings?.warmupSitePauses) ? settings.warmupSitePauses : [];
    const configuredSites = donors.resolveDonorSites(settings).filter(url => !pauses.some(p => p.domain === new URL(url).hostname && new Date(p.until).getTime() > Date.now()));
    const warmupSites = await availableDonors(prisma, claim.proxy, configuredSites);
    if (new Set(warmupSites.map(url => new URL(url).hostname)).size < execution.requiredSites && plan.mode !== 'verification') { const error = new Error('Not enough active sites'); error.code = 'warmup_sites_unavailable'; throw error; }
    const historyStarted = performance.now();
    const warmupSiteHistory = await prisma.profileWarmupEvent.findMany({
      where: { proxyLabel: `${claim.proxy.host}:${claim.proxy.port}`, event: { in: ['warmup_site_completed', 'warmup_site_skipped'] }, createdAt: { gte: new Date(Date.now() - 24 * 60 * 60_000) } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 2000, select: { event: true, details: true, createdAt: true },
    });
    const previousVisits = await prisma.profileWarmupEvent.findMany({ where: { profileId: job.profileId, event: 'warmup_site_completed' }, orderBy: { id: 'desc' }, take: 30, select: { details: true } });
    buffered.push(journal.journalEntry(journalContext, 'warmup_history_read', { durationMs: Math.round(performance.now() - historyStarted), rowsCount: warmupSiteHistory.length + previousVisits.length }));
    await withDeadline(() => runner({ prisma, task: { id: job.id, profileId: job.profileId, taskType: 'warmup', warmupStage: job.currentStage, verificationOnly: plan.mode === 'verification', projectId: null, project: null, searchEngine: '', searchQueries: [], vitalPhrases: [], url: '', targetExecutions: 1, currentExecutions: 0 }, proxy: claim.proxy,
      config: { ...config, projectId: null, warmupSites, warmupSiteHistory, warmupReturnDomains: previousVisits.map(e => e.details.domain).filter(Boolean), warmupSessionMinutes: plan.sessionMinutes, warmupRequiredSites: execution.requiredSites, warmupRequirements: execution.requirements, warmupDonorPolicy: { reserveSite: url => reserveDonor(prisma, claim.proxy, url), finishSite: (reservation, result) => finishDonor(prisma, reservation, result), releaseSite: reservation => releaseDonor(prisma, reservation) } }, signal: controller.signal, checkActive: options => controller.signal.aborted ? Promise.resolve(false) : checkActive(options), onBrowser: async value => { browser = value; await cleanup.track(value); if (controller.signal.aborted && value) { await cleanup.close(); controller.signal.throwIfAborted(); } },
      requireSavedProfile: job.currentStage > 1 || plan.mode === 'verification',
      profileLeaseOwner: claim.owner,
      prepareProxy: options => prepareWarmupProxy(prisma, claim, options),
      beforeCommit: async () => { controller.signal.throwIfAborted(); await flushEvents(); controller.signal.throwIfAborted(); },
      log: (event, detail) => {
        if (controller.signal.aborted) return;
        if (event === 'warmup_run_context') {
          for (const key of ['model','storageMode']) if (typeof detail[key] === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(detail[key])) metadata[key] = detail[key];
        }
        if (event === 'warmup_operation_started') lastOperation = detail.operation;
        log(event, { jobId: job.id, profileId: job.profileId, ...Object.fromEntries(['service', 'previousService', 'failures', 'threshold', 'code'].filter(key => typeof detail?.[key] === 'number' && Number.isFinite(detail[key]) || typeof detail?.[key] === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(detail[key])).map(key => [key, detail[key]])), ...(Number.isInteger(detail?.step) ? { step: detail.step, total: detail.total } : {}), ...(typeof detail?.domain === 'string' ? { domain: detail.domain } : {}), ...(typeof detail?.reason === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(detail.reason) ? { reason: detail.reason } : {}) });
        const entry = journal.runtimeEvents.has(event) ? journal.journalEntry(journalContext, event, detail) : null;
        const progressEvent = ['warmup_site_started', 'warmup_site_completed', 'profile_saved', 'warmup_started', 'warmup_session_check', 'warmup_final_fingerprint'].includes(event);
        if (entry || progressEvent) {
          const base = (job.currentStage - 1) / job.totalStages * 100;
          const withinStage = event === 'warmup_site_completed' ? detail.step / detail.total * (100 / job.totalStages) * 0.9 : 0;
          if (entry) buffered.push(entry);
          if (progressEvent) buffered.update({ stage: `stage_${job.currentStage}_${event}`, ...(event === 'warmup_site_completed' ? { progress: Math.round(base + withinStage) } : {}) });
          if (buffered.size >= 25) void flushEvents().catch(() => {});
          else if (!flushTimer) flushTimer = setTimeout(() => void flushEvents().catch(() => {}), 250);
        }
      },
      commitRun: async (tx, publish, summary = {}) => {
        controller.signal.throwIfAborted();
        if (!await leaseActive(tx, claim)) return { count: 0 };
        const current = await tx.warmupJob.findUnique({ where: { id: job.id }, include: { profile: true } });
        const settings = await tx.settings.findUnique({ where: { id: 1 } });
        if ((settings && !settings.warmupEnabled) || current.status !== 'running' || current.owner !== claim.owner || !current.profile.isEnabled || current.profile.deletedAt || current.profile.status === 'banned') return { count: 0 };
        const firstSessionAt = current.firstSessionAt || new Date();
        const minReadyAt = current.minReadyAt || new Date(firstSessionAt.getTime() + plan.minAgeHours * plans.HOUR);
        const finalStage = current.currentStage >= current.totalStages;
        const cookieGate=cookieAge.assessCookieAge(summary.sessionCheck?.cookieObservations);
        if(finalStage && !['passed','disabled'].includes(cookieGate.status)) {
          controller.signal.throwIfAborted();
          await publish();
          controller.signal.throwIfAborted();
          await tx.profile.update({where:{id:job.profileId},data:{sessionCheck:summary.sessionCheck,status:'needs_check',readinessVersion:0,readinessVerifiedAt:null,readinessValidUntil:null}});
          const nextStageAt=cookieGate.readyAt?new Date(Math.max(Date.parse(cookieGate.readyAt),minReadyAt.getTime())):new Date(Date.now()+24*plans.HOUR);
          await tx.warmupJob.update({where:{id:job.id},data:{status:'waiting_stage',stage:'cookie_age_wait',owner:null,attempts:0,nextStageAt,retryAfter:null,errorCode:null,firstSessionAt,minReadyAt}});
          await tx.profileWarmupEvent.create({data:journal.journalEntry(journalContext,'cookie_age_wait',{reason:cookieGate.status,budgetMs:cookieGate.minimumHours*plans.HOUR,nextStageAt})});
          return {count:1};
        }
        if (finalStage && minReadyAt > new Date()) {
          const error = new Error('Preparation time has not elapsed'); error.code = 'profile_minimum_age'; throw error;
        }
        if (finalStage && !readiness.attestable({ ...current.profile, sessionCheck: summary.sessionCheck }, { state: 'saved', ...summary }, { ...current, minReadyAt })) {
          const error = new Error('Readiness checks incomplete'); error.code = 'profile_readiness_incomplete'; throw error;
        }
        controller.signal.throwIfAborted();
        await publish();
        controller.signal.throwIfAborted();
        if (summary.sessionCheck) await tx.profile.update({ where: { id: job.profileId }, data: { sessionCheck: summary.sessionCheck } });

        await tx.profileWarmupEvent.create({ data: journal.journalEntry(journalContext, 'session_saved', { ...summary, ...(finalStage && plan.mode !== 'verification' ? { preparationMs: Math.max(0, Date.now() - current.profile.createdAt.getTime()) } : {}), durationMs: Date.now() - (current.startedAt?.getTime() || Date.now()) }) });
        const completedAt = new Date();
        if (finalStage) {
          await tx.warmupJob.update({ where: { id: job.id }, data: { status: 'completed', stage: 'completed', progress: 100, completedAt, owner: null, retryAfter: null, nextStageAt: null, errorCode: null, firstSessionAt, minReadyAt, dependencySince: null, dependencyRetries: 0 } });
          await tx.profile.update({ where: { id: job.profileId }, data: { status: 'ready', readinessVersion: readiness.VERIFICATION_VERSION, warmupScore: { increment: plan.mode === 'verification' ? 0 : 1 }, warmedAt: current.profile.warmedAt || completedAt, readinessVerifiedAt: completedAt, readinessValidUntil: new Date(completedAt.getTime() + (settings?.readinessFreshnessHours ?? 72) * plans.HOUR) } });
          await tx.profileWarmupEvent.create({ data: journal.journalEntry(journalContext, 'warmup_completed') });
        } else {
          const nextStage = current.currentStage + 1;
          const nextStageAt = plans.nextRunAt(plan, nextStage, firstSessionAt, completedAt);
          await tx.warmupJob.update({ where: { id: job.id }, data: { status: 'waiting_stage', currentStage: nextStage, stage: `stage_${nextStage}_waiting`, progress: Math.round(current.currentStage / current.totalStages * 100), attempts: 0, startedAt: null, completedAt: null, owner: null, retryAfter: null, nextStageAt, firstSessionAt, minReadyAt, dependencySince: null, dependencyRetries: 0, errorCode: null } });
          await tx.profile.update({ where: { id: job.profileId }, data: { status: 'queued', warmedAt: null } });
          await tx.profileWarmupEvent.createMany({ data: [journal.journalEntry(journalContext, 'stage_completed'), journal.journalEntry({ ...journalContext, stage: nextStage, attempt: null }, 'next_stage_scheduled', { nextStageAt: nextStageAt })] });
        }
        return { count: 1 };
      },
    }), { timeoutMs: runMs, signal: controller.signal, code: 'warmup_run_timeout', onTimeout: error => { timedOut = true; controller.abort(error); void browser?.close().catch(() => {}); } });
  } catch (error) {
    stopped = !timedOut && !(error instanceof WarmupTimeoutError) && (controller.signal.aborted || error instanceof TaskStoppedError);
    proxyFailed = error instanceof ProxyCheckError || error instanceof ProxyRotationError || error.code === 'proxy_check_failed';
    errorCode = stopped ? null : timedOut ? 'warmup_run_timeout' : ['ENOSPC','EDQUOT','SQLITE_FULL','profile_disk_full'].includes(error.code) ? 'profile_disk_full' : isDatabaseUnavailable(error) ? 'database_busy' : typeof error.code === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(error.code) ? error.code : error.name === 'TimeoutError' ? 'navigation_timeout' : 'warmup_failed';
    if (timedOut) buffered.push(journal.journalEntry(journalContext, 'warmup_operation_failed', { operation: lastOperation, reason: errorCode, budgetMs: runMs }));
    log(stopped ? 'warmup_stopped' : 'warmup_failed', { jobId: job.id, errorType: error.name, code: errorCode });
  } finally {
    controller.abort(); clearInterval(heartbeat); signal.removeEventListener('abort', abort);
    await cleanup.close();
    const measured = Object.fromEntries(Object.entries(metrics).map(([key, value]) => [key, Math.round(value)]));
    buffered.push(journal.journalEntry(journalContext, 'warmup_database_metrics', measured));
    buffered.push(journal.journalEntry(journalContext, 'warmup_run_finished', { ...metadata, outcome: stopped ? 'stopped' : errorCode ? 'failed' : 'passed', ...(errorCode ? { reason: errorCode } : {}), durationMs: Math.round(performance.now() - runStarted) }));
    log('warmup_database_metrics', { jobId: job.id, ...measured });
    await withDeadline(flushEvents, { timeoutMs: 30_000, code: 'warmup_cleanup_timeout' }).catch(error => log('warmup_journal_error', { jobId: job.id, errorType: error.name }));
    await finishClaim(prisma, claim, { errorCode, stopped, proxyFailed });
  }
}
async function main() {
  const config = loadConfig();
  const release = await acquireLock(`${config.databasePath}.warmup`);
  const prisma = new PrismaClient({ datasources: { db: { url: config.databaseUrl } } });
  const controller = new AbortController(), active = new Set(), owner = randomUUID();
  let lastReadinessMaintenance = 0, browserApproved = false;
  const stop = () => controller.abort();
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  const log = (event, data = {}) => console.log(JSON.stringify({ time: new Date().toISOString(), event, ...safeLogDetails(data) }));
  try {
    await recoverProfileSaves(prisma, config.profilesDirectory, { log });
    log('warmup_service_started');
    while (!controller.signal.aborted) {
      try {
        await sqliteWrite(prisma, tx => tx.workflowLease.upsert({ where: { key: 'warmup-service' }, create: { key: 'warmup-service', owner, expiresAt: new Date(Date.now() + 60_000) }, update: { owner, expiresAt: new Date(Date.now() + 60_000) } }));
        if (!browserApproved) {
          const controlBrowser = await chromium.launch({ executablePath: config.chromiumExecutablePath, headless: config.headless, timeout: config.navigationTimeoutMs });
          try { await qualifyBrowser({ prisma, browser: controlBrowser, signal: controller.signal }); browserApproved = true; }
          finally { await controlBrowser.close(); }
        }
        await recoverAbandoned(prisma);
        if (Date.now() - lastReadinessMaintenance > 60_000) { await recoverProfileSaves(prisma, config.profilesDirectory, { log }); await maintainReadiness(prisma, config); lastReadinessMaintenance = Date.now(); }
        const settings = await prisma.settings.findUnique({ where: { id: 1 } });
        if (schedule.isWarmupAllowed(settings)) {
          const result = await serializeSqlite(prisma, () => pool.replenishPool(prisma));
          if (result.created) log('profiles_created', { count: result.created });
          for (let slot = active.size; slot < (settings?.warmupConcurrency ?? 1); slot++) {
            const claim = await claimWarmup(prisma); if (!claim) break;
            const promise = executeWarmup({ prisma, claim, config, signal: controller.signal, log }).catch(error => log('warmup_worker_error', { errorType: error.name })).finally(() => active.delete(promise));
            active.add(promise);
          }
        }
      } catch (error) { log('warmup_service_error', { errorType: error.name, ...(typeof error.code === 'string' && /^[a-z0-9_]{1,80}$/.test(error.code) ? {code:error.code} : {}) }); }
      await sleep(3000, controller.signal).catch(() => {});
    }
  } finally {
    controller.abort(); await Promise.allSettled(active);
    await prisma.workflowLease.deleteMany({ where: { key: 'warmup-service', owner } });
    await prisma.$disconnect(); await release();
    process.off('SIGTERM', stop); process.off('SIGINT', stop);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(JSON.stringify({ event: 'warmup_startup_failed', errorType: error.name })); process.exitCode = 1; });
