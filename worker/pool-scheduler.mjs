import { rateLimitDelay } from './http-retry.mjs';
import { reserveProjectLocation } from './project-geolocation.mjs';
import schedule from '../utils/projectSchedule.js';
import daily from '../utils/taskDailySchedule.js';
import { randomUUID, createHash } from 'node:crypto';
import pool from '../utils/profilePool.js';
import journal from '../utils/warmupJournal.js';
import readiness from '../utils/profileReadiness.js';
import publication from '../utils/profilePublication.js';
import { loadMobileProfile } from './profiles.mjs';
import sessionState from '../utils/sessionState.js';
import { resolve } from 'node:path';
import { rotateProxy, ProxyRotationError } from './proxy-rotation.mjs';
import { sleep, TaskStoppedError } from './behavior.mjs';
import { sqliteWrite } from './sqlite-write.mjs';
const TTL = 120_000;
import channels from '../utils/proxyChannel.js';
import tcp from '../utils/proxyTcp.js';
import { prepareConfiguredProxy } from './proxy-tcp.mjs';
export const {proxyKey, proxyKeys} = channels;
const expires = () => new Date(Date.now() + TTL);
const interruptedExecutions = ['stopped', 'database_busy', 'worker_interrupted'];
const transaction = (prisma, fn) => sqliteWrite(prisma, async tx => {
  await tx.$executeRaw`DELETE FROM "WorkflowLease" WHERE "expiresAt" <= ${new Date()}`;
  return fn(tx);
}, { maxWait: 10000, timeout: 15000 });
async function lock(tx, keys, owner) {
  if (await tx.workflowLease.count({ where: { OR: [{ key: { in: [...keys, ...keys.map(key => `cooldown:${key}`)] } }, ...keys.flatMap(key => ['warmup-share', 'target-share'].map(kind => ({ key: { startsWith: `${kind}:${key}:` } })))] } })) return false;
  await tx.workflowLease.createMany({ data: keys.map(key => ({ key, owner, expiresAt: expires() })) });
  return true;
}
export async function leaseActive(prisma, claim) {
  return (await prisma.workflowLease.count({ where: { owner: claim.owner, expiresAt: { gt: new Date() } } })) === claim.keys.length;
}
export async function renewLease(prisma, claim) {
  return transaction(prisma, async tx => {
    const result = await tx.workflowLease.updateMany({ where: { owner: claim.owner, expiresAt: { gt: new Date() } }, data: { expiresAt: expires() } });
    if (result.count !== claim.keys.length) return false;
    if (claim.sharedProxy) await tx.workflowLease.updateMany({ where: { owner: { in: ['preparing', 'ready', 'failed', 'draining'].map(phase => `${phase}:${claim.sharedProxy.groupId}`) } }, data: { expiresAt: expires() } });
    return true;
  });
}

async function sharedWarmupLock(tx, proxy, profileId, owner, resources) {
  if (await tx.workflowLease.count({ where: { OR: [{ key: { in: [...resources, ...resources.map(key => `cooldown:${key}`)] } }, ...resources.map(key => ({ key: { startsWith: `target-share:${key}:` } }))] } })) return null;
  const gateKeys = resources.map(key => `warmup-gate:${key}`);
  let gates = await tx.workflowLease.findMany({ where: { key: { in: gateKeys } } });
  for (const gate of gates) {
    const groupId = gate.owner.slice(gate.owner.indexOf(':') + 1);
    if (!await tx.workflowLease.count({ where: { key: { startsWith: `warmup-member:${groupId}:` } } })) {
      await tx.workflowLease.deleteMany({ where: { owner: { in: ['preparing', 'ready', 'failed'].map(phase => `${phase}:${groupId}`) } } });
    }
  }
  gates = await tx.workflowLease.findMany({ where: { key: { in: gateKeys } } });
  if (gates.some(gate => gate.owner.startsWith('failed:')) || new Set(gates.map(gate => gate.owner)).size > 1) return null;
  const groupId = gates.length ? gates[0].owner.split(':')[1] : owner;
  const phase = gates.length ? gates[0].owner.split(':')[0] : 'preparing';
  const profileKey = `profile:${profileId}`;
  if (!await lock(tx, [profileKey], owner)) return null;
  const keys = [profileKey, ...resources.map(key => `warmup-share:${key}:${owner}`), `warmup-member:${groupId}:${owner}`, `warmup-proxy:${proxy.id}:${owner}`];
  await tx.workflowLease.createMany({ data: keys.slice(1).map(key => ({ key, owner, expiresAt: expires() })) });
  await tx.workflowLease.createMany({ data: gateKeys.filter(key => !gates.some(gate => gate.key === key)).map(key => ({ key, owner: `${phase}:${groupId}`, expiresAt: expires() })) });
  return { keys, sharedProxy: { groupId, gateKeys } };
}
async function sharedTargetLock(tx, proxy, profileId, owner, resources) {
  if (await tx.workflowLease.count({ where: { OR: [{ key: { in: [...resources, ...resources.map(key => `cooldown:${key}`)] } }, ...resources.map(key => ({ key: { startsWith: `warmup-share:${key}:` } }))] } })) return null;
  const gateKeys = resources.map(key => `target-gate:${key}`);
  let gates = await tx.workflowLease.findMany({ where: { key: { in: gateKeys } } });
  for (const gate of gates) {
    const groupId = gate.owner.slice(gate.owner.indexOf(':') + 1);
    if (!await tx.workflowLease.count({ where: { key: { startsWith: `target-member:${groupId}:` } } }))
      await tx.workflowLease.deleteMany({ where: { owner: { in: ['preparing', 'ready', 'failed', 'draining'].map(phase => `${phase}:${groupId}`) } } });
  }
  gates = await tx.workflowLease.findMany({ where: { key: { in: gateKeys } } });
  if (gates.some(gate => /^(failed|draining):/.test(gate.owner)) || new Set(gates.map(gate => gate.owner)).size > 1) return null;
  const groupId = gates.length ? gates[0].owner.split(':')[1] : owner;
  if (gates.length) {
    const member = await tx.workflowLease.findFirst({ where: { key: { startsWith: `target-member:${groupId}:` } } });
    if (!member || !await tx.workflowLease.findUnique({ where: { key: `target-proxy:${proxy.id}:${member.owner}` } })) return null;
  }
  const phase = gates.length ? gates[0].owner.split(':')[0] : 'preparing';
  if (!await lock(tx, [`profile:${profileId}`], owner)) return null;
  const keys = [`profile:${profileId}`, ...resources.map(key => `target-share:${key}:${owner}`), `target-member:${groupId}:${owner}`, `target-proxy:${proxy.id}:${owner}`];
  await tx.workflowLease.createMany({ data: keys.slice(1).map(key => ({ key, owner, expiresAt: expires() })) });
  await tx.workflowLease.createMany({ data: gateKeys.filter(key => !gates.some(gate => gate.key === key)).map(key => ({ key, owner: `${phase}:${groupId}`, expiresAt: expires() })) });
  return { keys, sharedProxy: { kind: 'target', groupId, gateKeys } };
}

/** Rotate once before the cohort starts; followers reuse its IP, never rotate it. */
export async function prepareWarmupProxy(prisma, claim, options, rotation = prepareConfiguredProxy) {
  if (!claim.sharedProxy) return rotation({...options, prisma});
  const { groupId, gateKeys } = claim.sharedProxy;
  const deadline = Date.now() + 180_000; let waitingLogged = false;
  while (true) {
    options.signal?.throwIfAborted();
    if (!(await options.shouldContinue())) throw new TaskStoppedError();
    const gates = await prisma.workflowLease.findMany({ where: { key: { in: gateKeys }, expiresAt: { gt: new Date() } } });
    if (gates.length !== gateKeys.length || gates.some(gate => gate.owner === `failed:${groupId}`)) throw new ProxyRotationError('proxy_shared_preparation_failed');
    if (gates.every(gate => gate.owner === `ready:${groupId}`)) {
      options.log('proxy_rotation_shared', { proxyId: claim.proxy.id }); return;
    }
    if (claim.owner === groupId) {
      await rotation({...options, prisma});
      if (!(await options.shouldContinue())) throw new TaskStoppedError();
      await transaction(prisma, async tx => {
        if (!await leaseActive(tx, claim)) throw new TaskStoppedError();
        await tx.workflowLease.updateMany({ where: { owner: `preparing:${groupId}` }, data: { owner: `ready:${groupId}`, expiresAt: expires() } });
      });
      return;
    }
    if (Date.now() >= deadline) throw new ProxyRotationError('proxy_shared_preparation_failed');
    if (!waitingLogged) { options.log('proxy_rotation_waiting', { proxyId: claim.proxy.id }); waitingLogged = true; }
    await sleep(250, options.signal);
  }
}
export async function prepareTargetProxy(prisma, claim, options, rotation = prepareConfiguredProxy) {
  if (!claim.sharedProxy) return rotation({ ...options, prisma });
  const { groupId, gateKeys } = claim.sharedProxy;
  const deadline = Date.now() + 180_000;
  while (true) {
    options.signal?.throwIfAborted();
    if (!(await options.shouldContinue())) throw new TaskStoppedError();
    const gates = await prisma.workflowLease.findMany({ where: { key: { in: gateKeys }, expiresAt: { gt: new Date() } } });
    if (gates.some(gate => gate.owner === `draining:${groupId}`)) throw new TaskStoppedError();
    if (gates.length !== gateKeys.length || gates.some(gate => gate.owner === `failed:${groupId}`)) throw new ProxyRotationError('proxy_shared_preparation_failed');
    if (gates.every(gate => gate.owner === `ready:${groupId}`)) return;
    if (claim.owner === groupId) {
      await rotation({ ...options, prisma });
      if (!(await options.shouldContinue())) throw new TaskStoppedError();
      await transaction(prisma, async tx => {
        if (!await leaseActive(tx, claim)) throw new TaskStoppedError();
        await tx.workflowLease.updateMany({ where: { owner: `preparing:${groupId}`, key: { in: gateKeys } }, data: { owner: `ready:${groupId}`, expiresAt: expires() } });
      });
      return;
    }
    if (Date.now() >= deadline) throw new ProxyRotationError('proxy_shared_preparation_failed');
    await sleep(250, options.signal);
  }
}
export async function recoverAbandoned(prisma) {
  return transaction(prisma, async tx => {
    // Older releases paused the entire engine after one proxy returned 429.
    // Recovery is now scoped to the affected channel, including after restart.
    await tx.workflowLease.deleteMany({ where: { key: { startsWith: 'search-rate-limit:' } } });
    const owners = (await tx.workflowLease.findMany({ select: { owner: true } })).map(l => l.owner);
    const jobs = await tx.warmupJob.findMany({ where: { status: 'running', owner: { notIn: owners }, profile: { deletedAt: null } } });
    for (const job of jobs) {
      // An expired worker lease is an infrastructure interruption, not evidence
      // of a damaged profile. Preserve the real failure budget and back off.
      const attempts = Math.max(0, job.attempts - 1);
      const retryAfter = new Date(Date.now() + Math.min(10 * 60_000, 30_000 * 2 ** Math.min(5, job.dependencyRetries || 0)));
      await tx.warmupJob.update({ where: { id: job.id }, data: { status: 'retry_wait', stage: `stage_${job.currentStage}_interrupted`, errorCode: 'worker_interrupted', attempts, owner: null, retryAfter, nextStageAt: null, dependencySince: job.dependencySince || new Date(), dependencyRetries: { increment: 1 } } });
      await tx.profile.updateMany({ where: { id: job.profileId, status: { not: 'banned' } }, data: { status: 'queued' } });
      await tx.profileWarmupEvent.create({ data: journal.journalEntry({ profileId: job.profileId, jobId: job.id, runId: job.owner, stage: job.currentStage, attempt: job.attempts }, 'attempt_interrupted', { reason: 'worker_interrupted', retryAfter }) });
    }
    const running = await tx.taskExecution.findMany({ where: { status: 'running' } });
    for (const execution of running) {
      if (await tx.workflowLease.findUnique({ where: { key: `profile:${execution.profileId}` } })) continue;
      await tx.taskExecution.update({ where: { id: execution.id }, data: { status: 'failed', errorCode: 'worker_interrupted', completedAt: new Date() } });
      await recordTaskResult(tx, execution.taskId, { errorCode: 'worker_interrupted', errorType: 'WorkerInterrupted', profileId: execution.profileId, proxyId: execution.proxyId, retryDelayMs: 60_000 });
      await tx.projectProfileUse.deleteMany({ where: { taskId: execution.taskId, profileId: execution.profileId, usedAt: null } });
    }
  });
}
export async function claimWarmup(prisma, at) {
  return transaction(prisma, async tx => {
    const settings = await tx.settings.findUnique({ where: { id: 1 } });
    const now = at ?? new Date();
    if (!schedule.isWarmupAllowed(settings, now)) return null;
    if (await tx.warmupJob.count({ where: { status: 'running', profile: { deletedAt: null } } }) >= (settings?.warmupConcurrency ?? 1)) return null;
    const due = { status: { in: ['queued', 'retry_wait', 'waiting_stage'] }, AND: [
      { OR: [{ retryAfter: null }, { retryAfter: { lte: now } }] },
      { OR: [{ nextStageAt: null }, { nextStageAt: { lte: now } }] },
    ], profile: { isEnabled: true, deletedAt: null, status: { not: 'banned' } } };
    const continuing = await tx.warmupJob.findMany({ where: { ...due, currentStage: { gt: 1 } }, include: {profile:true}, orderBy: [{ nextStageAt: 'asc' }, { createdAt: 'asc' }], take: 100 });
    const fresh = await tx.warmupJob.findMany({ where: { ...due, currentStage: 1 }, include: {profile:true}, orderBy: { createdAt: 'asc' }, take: 100 });
    const counter = await tx.workflowLease.findUnique({ where: { key: 'warmup-priority-counter' } });
    const streak = Number(counter?.owner || 0);
    // Three due continuations, then one first stage when both groups are waiting.
    // The counter survives worker restarts and advances only on an actual claim.
    const jobs = continuing.length && (streak < 3 || !fresh.length) ? [...continuing, ...fresh] : [...fresh, ...continuing];
    const allProxies = await tx.proxy.findMany({ include: {tcpChannel:true} });
    const proxies = allProxies.filter(proxy => proxy.isActive && ['shared', 'warmup'].includes(proxy.purpose));
    const targetWaiting = await tx.workflowLease.findFirst({ where: { OR: [{ key: 'target-demand' }, { key: { startsWith: 'target-demand:' } }] } });
    const loads = new Map();
    for (const proxy of proxies) loads.set(proxy.id, await tx.workflowLease.count({ where: { key: { startsWith: `warmup-proxy:${proxy.id}:` } } }));
    proxies.sort((a, b) => loads.get(a.id) - loads.get(b.id));
    for (const job of jobs) for (const proxy of proxies) {
      if (!tcp.compatible(proxy, job.profile)) continue;
      if (targetWaiting && proxy.purpose === 'shared') continue;
      const owner = randomUUID(), resources = channels.channelKeys(allProxies, proxy); let allocation;
      if (settings?.warmupSharedProxy ?? true) allocation = await sharedWarmupLock(tx, proxy, job.profileId, owner, resources);
      else { const keys = [`profile:${job.profileId}`, ...resources]; if (await lock(tx, keys, owner)) allocation = { keys }; }
      if (!allocation) continue;
      await tx.warmupJob.update({ where: { id: job.id }, data: { status: 'running', stage: `stage_${job.currentStage}_starting`, progress: Math.round((job.currentStage - 1) / job.totalStages * 100), attempts: { increment: 1 }, startedAt: now, retryAfter: null, nextStageAt: null, errorCode: null, owner } });
      await tx.profile.update({ where: { id: job.profileId }, data: { status: 'warming_up' } });
      const claim = { owner, ...allocation, job: { ...job, attempts: job.attempts + 1 }, proxy };
      await tx.profileWarmupEvent.create({ data: journal.journalEntry(journal.claimContext(claim), 'attempt_started') });
      await tx.workflowLease.upsert({ where: { key: 'warmup-priority-counter' }, create: { key: 'warmup-priority-counter', owner: String(job.currentStage > 1 ? Math.min(3, streak + 1) : 0), expiresAt: new Date('2100-01-01') }, update: { owner: String(job.currentStage > 1 ? Math.min(3, streak + 1) : 0) } });
      return claim;
    }
    return null;
  });
}
export async function claimTarget(prisma, taskId, demandOwner, at, onUnavailable = () => {}) {
  const demandKey = `target-demand:${demandOwner}`;
  return transaction(prisma, async tx => {
    const task = await tx.task.findUnique({ where: { id: taskId }, include: { project: true } });
    if (!task || !task.projectId || task.taskType !== 'target' || task.status !== 'running' || task.currentExecutions >= task.targetExecutions) return null;
    let retry = task.retryState || {};
    if (['database_busy', 'worker_interrupted', 'P1008', 'P2024', 'P2034'].includes(retry.code) &&
        (retry.lastProfileId || retry.lastProxyId || retry.count)) {
      // Repair retry metadata left by older workers after infrastructure waits.
      // Keep the existing deadline; a healthy pair was never a search failure.
      const { lastProfileId, lastProxyId, key, ...rest } = retry;
      retry = { ...rest, count: 0 };
      await tx.task.update({ where: { id: taskId }, data: { retryState: retry } });
      task.retryState = retry;
    }
    if (retry.code === 'search_rate_limited') {
      const recovery = 'replace_proxy';
      if (retry.recovery !== recovery) {
        retry = await rateLimitedRetry(tx, retry, Math.max(0, Date.parse(retry.retryAfter) - Date.now()) || 0);
        await tx.task.update({ where: { id: taskId }, data: { retryState: retry } });
        task.retryState = retry;
      }
    }
    const now = at ?? new Date();
    if (retry.retryAfter && new Date(retry.retryAfter) > now) { onUnavailable({ reason: 'retry_pause', nextAt: retry.retryAfter }); return null; }
    // Check inside the reservation transaction, using the latest project settings.
    if (!schedule.isAllowed(task.project, now)) {
      await tx.workflowLease.deleteMany({ where: { key: { in: [demandKey, 'target-demand'] }, owner: demandOwner } });
      return null;
    }
    const activeCount = await tx.taskExecution.count({ where: { taskId, status: 'running' } });
    if (activeCount >= task.concurrency || task.currentExecutions + activeCount >= task.targetExecutions) return null;
    if (!(await daily.dailyState(tx, task, { now, create: true })).allowed) {
      await tx.workflowLease.deleteMany({ where: { key: { in: [demandKey, 'target-demand'] }, owner: demandOwner } });
      return null;
    }
    const profiles = await tx.profile.findMany({ where: { AND: [pool.eligibleProfiles(task.projectId),
      ...(retry.lastProfileId ? [{ id: { not: retry.lastProfileId } }] : []),
      { executions: { none: { taskId, status: 'failed', OR: [{ errorCode: null }, { errorCode: { notIn: interruptedExecutions } }] } } },
    ] }, orderBy: [{ warmedAt: 'asc' }, { createdAt: 'asc' }], take: 100 });
    if (profiles.length) await tx.workflowLease.upsert({ where: { key: demandKey }, create: { key: demandKey, owner: demandOwner, expiresAt: expires() }, update: { owner: demandOwner, expiresAt: expires() } });
    else await tx.workflowLease.deleteMany({ where: { key: { in: [demandKey, 'target-demand'] }, owner: demandOwner } });
    const allProxies = await tx.proxy.findMany({ include: {tcpChannel:true} });
    const eligibleProxies = allProxies.filter(proxy => proxy.isActive && ['shared', 'target'].includes(proxy.purpose));
    const resources = new Map(allProxies.map(proxy => [proxy.id, channels.channelKeys(allProxies, proxy)]));
    // A sibling's successful completion can clear retryState before the next
    // allocation. Keep that pending failure visible in execution history.
    const failure = await tx.taskExecution.findFirst({ where: { taskId, status: 'failed', OR: [{ errorCode: null }, { errorCode: { notIn: interruptedExecutions } }] }, orderBy: [{ completedAt: 'desc' }, { startedAt: 'desc' }] });
    const pendingFailure = failure && !await tx.taskExecution.count({ where: { taskId, startedAt: { gt: failure.completedAt || failure.startedAt } } });
    const failedProxyId = retry.lastProxyId || (pendingFailure ? failure.proxyId : null);
    const failedProxy = allProxies.find(proxy => proxy.id === failedProxyId);
    const failedChannels = new Set(failedProxy ? resources.get(failedProxy.id) : []);
    const running = await tx.taskExecution.findMany({ where: { status: 'running', task: { projectId: task.projectId } }, select: { proxyId: true } });
    const projectChannels = running.flatMap(execution => {
      const proxy = allProxies.find(item => item.id === execution.proxyId);
      return proxy ? [new Set(resources.get(proxy.id))] : [];
    });
    const projectTasks = await tx.task.findMany({ where: { projectId: task.projectId, taskType: 'target', status: 'running' }, select: { concurrency: true, currentExecutions: true, targetExecutions: true } });
    const slots = projectTasks.reduce((sum, row) => sum + Math.min(row.concurrency, Math.max(0, row.targetExecutions - row.currentExecutions)), 0);
    const independent = new Set(eligibleProxies.map(proxy => [...resources.get(proxy.id)].sort().join('|'))).size;
    const projectLoads = new Map(eligibleProxies.map(proxy => [proxy.id, projectChannels.filter(keys => resources.get(proxy.id).some(key => keys.has(key))).length]));
    const distinct = slots <= independent || running.length < independent;
    const proxies = eligibleProxies.filter(proxy => proxy.id !== failedProxyId &&
      !resources.get(proxy.id).some(key => failedChannels.has(key)) &&
      (!distinct || !projectLoads.get(proxy.id)));
    const loads = new Map();
    for (const proxy of proxies) loads.set(proxy.id, await tx.workflowLease.count({ where: { key: { startsWith: `target-proxy:${proxy.id}:` } } }));
    const usage = await tx.taskExecution.groupBy({ by: ['proxyId'], where: { proxyId: { in: proxies.map(proxy => proxy.id) } }, _max: { startedAt: true } });
    const lastUsed = new Map(usage.map(row => [row.proxyId, row._max.startedAt?.getTime() || 0]));
    proxies.sort((a, b) => projectLoads.get(a.id) - projectLoads.get(b.id) || loads.get(a.id) - loads.get(b.id) || (lastUsed.get(a.id) || 0) - (lastUsed.get(b.id) || 0));
    const readyIds = []; let compatiblePairs = 0;
    for (const profile of profiles) {
      if (!readiness.confirmed(profile)) {
        if (!await tx.workflowLease.count({ where: { key: `profile:${profile.id}`, expiresAt: { gt: now } } }))
          await tx.profile.update({ where: { id: profile.id }, data: { status: 'needs_check', readinessVersion: 0, readinessVerifiedAt: null, readinessValidUntil: null } });
        continue;
      }
      if (process.env.WORKER_PROFILES_DIR) {
        try {
          if (await publication.hasPendingPublication(resolve(process.env.WORKER_PROFILES_DIR), profile.id)) continue;
          const { profile: saved } = await loadMobileProfile(resolve(process.env.WORKER_PROFILES_DIR), profile.id);
          if (!sessionState.sessionSummary(saved).hasData || profile.snapshotId !== saved.snapshot?.id ||
            !readiness.verifiedSnapshot(profile.sessionCheck, saved.snapshot?.id, saved.savedAt, saved.snapshot?.passportHash)) throw new Error('Stale snapshot');
        } catch {
          await tx.profile.update({ where: { id: profile.id }, data: { status: 'needs_check', readinessVerifiedAt: null, readinessValidUntil: null } });
          continue;
        }
      }
      readyIds.push(profile.id);
      for (const proxy of proxies) {
      if (!tcp.compatible(proxy, profile)) continue;
      compatiblePairs++;
      const owner = randomUUID(), resources = channels.channelKeys(allProxies, proxy);
      const allocation = await sharedTargetLock(tx, proxy, profile.id, owner, resources);
      if (!allocation) continue;
      const execution = await tx.taskExecution.upsert({ where: { taskId_profileId: { taskId, profileId: profile.id } }, create: { taskId, profileId: profile.id, proxyId: proxy.id, status: 'running', attempts: 1, startedAt: now }, update: { selectedSearchQuery: null, status: 'running', proxyId: proxy.id, attempts: { increment: 1 }, startedAt: now, completedAt: null, errorCode: null } });
      const geolocation = await reserveProjectLocation(tx, task.project, profile.id, execution);
      await tx.projectProfileUse.create({ data: { projectId: task.projectId, profileId: profile.id, taskId, ...(geolocation ? { geolocation } : {}) } });
      await tx.workflowLease.deleteMany({ where: { key: { in: [demandKey, 'target-demand'] }, owner: demandOwner } });
      return { owner, ...allocation, task: { ...task, profileId: profile.id, executionId: execution.id }, proxy };
    }
    }
    const readyCount = readyIds.length;
    const occupiedProfiles = readyCount ? await tx.workflowLease.count({ where: { key: { in: readyIds.map(id => `profile:${id}`) } } }) : 0;
    onUnavailable({ reason: !readyCount ? 'no_ready_profiles' : !eligibleProxies.length ? 'no_active_proxies'
      : !proxies.length ? failedProxyId ? 'proxy_replacement_unavailable' : 'proxies_busy'
      : occupiedProfiles === readyCount ? 'profiles_busy' : !compatiblePairs ? 'pair_incompatible' : 'proxies_busy',
      readyProfiles: readyCount, activeProxies: eligibleProxies.length });
    return null;
  });
}
export async function markTargetUsed(prisma, claim) {
  return transaction(prisma, async tx => {
    if (!await leaseActive(tx, claim)) throw new Error('Lease lost');
    const { task } = claim;
    const current = await tx.task.findUnique({ where: { id: task.id } });
    const execution = await tx.taskExecution.findUnique({ where: { id: task.executionId }, include: { profile: true } });
    if (!current || current.status !== 'running' || !execution || execution.status !== 'running' || execution.profileId !== task.profileId || !readiness.confirmed(execution.profile)) throw new Error('Task stopped');
    await tx.projectProfileUse.updateMany({ where: { projectId: task.projectId, profileId: task.profileId, taskId: task.id, usedAt: null }, data: { usedAt: new Date() } });
  });
}
async function rateLimitedRetry(tx, retry, requestedDelayMs) {
  const proxies = await tx.proxy.findMany();
  const proxy = proxies.find(item => item.id === retry.lastProxyId);
  const rotationAvailable = Boolean(proxy?.rotationUrl?.trim());
  if (rotationAvailable) await tx.workflowLease.deleteMany({ where: { owner: `search-rate-limit:${proxy.id}`, key: { startsWith: 'cooldown:' } } });
  if (proxy && !rotationAvailable) {
    // Without a rotation URL, quarantine this channel and try another proxy.
    // Never silently retry the same IP or pause unrelated search channels.
    const until = Date.now() + rateLimitDelay(retry.count, requestedDelayMs);
    for (const resource of channels.channelKeys(proxies, proxy)) {
      const key = `cooldown:${resource}`;
      const existing = await tx.workflowLease.findUnique({ where: { key } });
      const data = { owner: `search-rate-limit:${proxy.id}`, expiresAt: new Date(Math.max(until, existing?.expiresAt?.getTime() || 0)) };
      await tx.workflowLease.upsert({ where: { key }, create: { key, ...data }, update: data });
    }
  }
  return { ...retry, recovery: 'replace_proxy', retryAfter: retry.count >= 5 ? null : new Date(Math.max(Date.parse(retry.retryAfter) || 0, Date.now() + Math.max(60_000, Number.isFinite(requestedDelayMs) ? requestedDelayMs : 0))).toISOString() };
}
async function recordTaskResult(tx, taskId, { success, stopped, errorCode, errorType = 'Error', providerCode, profileId, proxyId, retryDelayMs = 0 }) {
  const task = await tx.task.findUnique({ where: { id: taskId } });
  if (!task || stopped || (!success && task.status !== 'running') || task.status === 'failed') return null;
  if (success) { await tx.task.update({ where: { id: taskId }, data: { retryState: {} } });return { retryState: {}, taskStopped: false }; }
  const safe = (value, fallback) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value) ? value : fallback;
  const code = safe(errorCode, 'execution_failed'), type = safe(errorType, 'Error'), provider = safe(providerCode, '');
  const key = `${type}:${code}:${provider}`;
  const previous = task.retryState || {};
  if (['database_busy', 'worker_interrupted'].includes(code)) {
    // Preserve the real failure streak and last failed pair. A database wait
    // must neither consume its budget nor blacklist a healthy profile/proxy.
    const retryState = { ...previous, code: previous.code || code, type: previous.type || type,
      count: previous.count || 0, retryAfter: new Date(Math.max(Date.parse(previous.retryAfter) || 0, Date.now() + retryDelayMs)).toISOString() };
    await tx.task.update({ where: { id: taskId }, data: { retryState } });
    return { retryState, taskStopped: false };
  }
  const count = previous.key === key ? Math.min(5, (previous.count || 0) + 1) : 1;
  const taskStopped = count >= 5;
  let retryState = { key, code, type, count, lastProfileId: profileId, lastProxyId: proxyId, at: new Date().toISOString(), retryAfter: taskStopped ? null : new Date(Date.now() + retryDelayMs).toISOString() };
  if (code === 'search_rate_limited') {
    // A parallel failure must not shorten a deadline already set by the server.
    if (!taskStopped) retryState.retryAfter = new Date(Math.max(Date.parse(previous.retryAfter) || 0, Date.parse(retryState.retryAfter) || 0)).toISOString();
    retryState = await rateLimitedRetry(tx, retryState, retryDelayMs);
  }
  await tx.task.update({ where: { id: taskId }, data: { retryState, ...(taskStopped ? { status: 'failed' } : {}) } });
  return { retryState, taskStopped };
}
export async function finishClaim(prisma, claim, { success = false, errorCode = null, errorType = 'Error', providerCode, retryDelayMs = 0, stopped = false, proxyFailed = false } = {}) {
  return transaction(prisma, async tx => {
    // Stale owners must never modify a newer attempt or release its resources.
    if (!await leaseActive(tx, claim)) return;
    let result = null;
    if (claim.job) {
      const job = await tx.warmupJob.findUnique({ where: { id: claim.job.id } });
      if (job?.owner === claim.owner && job.status === 'running') {
        // Unavailable donors, proxies, disk space and browser engines are dependencies. They
        // must not consume the budget for actual session/fingerprint failures.
        const sitesUnavailable = errorCode === 'warmup_sites_unavailable';
        const databaseBusy = errorCode === 'database_busy';
        const storageUnavailable = ['ENOSPC','EDQUOT','SQLITE_FULL','profile_disk_full'].includes(errorCode);
        if (storageUnavailable) errorCode = 'profile_disk_full';
        const ipCheckUnavailable = errorCode === 'proxy_ip_check_failed';
        const browserUnavailable = ['browser_qualification_failed', 'browser_qualification_lease_lost', 'browser_runtime_downgrade', 'browser_runtime_metadata_unavailable', 'browser_runtime_version_invalid', 'browser_runtime_changed'].includes(errorCode);
        const dependencyFailed = proxyFailed || sitesUnavailable || databaseBusy || ipCheckUnavailable || browserUnavailable || storageUnavailable;
        const attempts = stopped || dependencyFailed ? Math.max(0, job.attempts - 1) : job.attempts;
        const status = stopped ? 'queued' : attempts >= 3 && !dependencyFailed ? 'failed' : 'retry_wait';
        const retryAfter = new Date(Date.now() + (stopped ? 5000 : storageUnavailable ? 5 * 60_000 * 2 ** Math.min(2, job.dependencyRetries || 0) : proxyFailed || databaseBusy || ipCheckUnavailable || browserUnavailable ? 60_000 : sitesUnavailable ? 15 * 60_000 : 30_000 * 2 ** Math.max(0, attempts - 1)));
        const activity = !stopped && storageUnavailable ? 'disk_wait' : !stopped && proxyFailed ? 'proxy_wait' : !stopped && sitesUnavailable ? 'sites_wait' : !stopped && databaseBusy ? 'database_wait' : status;
        await tx.warmupJob.update({ where: { id: job.id }, data: { status, stage: `stage_${job.currentStage}_${activity}`, errorCode: errorCode || (stopped ? null : 'warmup_failed'), owner: null, attempts, retryAfter, nextStageAt: null, ...(dependencyFailed ? { dependencySince: job.dependencySince || new Date(), dependencyRetries: { increment: 1 } } : {}) } });
        await tx.profile.updateMany({ where: { id: job.profileId, status: { not: 'banned' } }, data: { status: status === 'failed' ? 'failed' : 'queued' } });
        await tx.profileWarmupEvent.create({ data: journal.journalEntry(journal.claimContext(claim), stopped ? 'attempt_stopped' : status === 'failed' ? 'attempt_failed' : 'retry_scheduled', { reason: stopped ? undefined : errorCode || 'warmup_failed', ...(status === 'failed' ? {} : { retryAfter }) }) });
      }
    } else {
      if (errorCode && /^profile_|^invalid_.*profile|^fingerprint_/.test(errorCode)) {
        await tx.profile.updateMany({ where: { id: claim.task.profileId, status: 'ready' }, data: { status: 'needs_check', readinessVerifiedAt: null, readinessValidUntil: null } });
      }
      await tx.taskExecution.updateMany({ where: { id: claim.task.executionId, status: 'running' }, data: { status: success ? 'completed' : 'failed', errorCode: stopped ? 'stopped' : errorCode, completedAt: new Date() } });
      result = await recordTaskResult(tx, claim.task.id, { success, stopped, errorCode, errorType, providerCode, profileId: claim.task.profileId, proxyId: claim.proxy.id, retryDelayMs });
      await tx.projectProfileUse.deleteMany({ where: { projectId: claim.task.projectId, profileId: claim.task.profileId, taskId: claim.task.id, usedAt: null } });
    }
    await tx.workflowLease.deleteMany({ where: { owner: claim.owner } });
    if (claim.sharedProxy) {
      const groupId = claim.sharedProxy.groupId;
      const member = claim.sharedProxy.kind === 'target' ? 'target-member' : 'warmup-member';
      // Close this IP cohort to new members. Existing browsers finish before
      // a new cohort invokes the affected proxy's rotation URL exactly once.
      if (claim.sharedProxy.kind === 'target' && errorCode === 'search_rate_limited' && !stopped) {
        await tx.workflowLease.updateMany({ where: { key: { in: claim.sharedProxy.gateKeys } }, data: { owner: `draining:${groupId}`, expiresAt: expires() } });
      }
      if (claim.owner === groupId) await tx.workflowLease.updateMany({ where: { owner: `preparing:${groupId}`, key: { in: claim.sharedProxy.gateKeys } }, data: { owner: `failed:${groupId}` } });
      if (!await tx.workflowLease.count({ where: { key: { startsWith: `${member}:${groupId}:` } } })) {
        await tx.workflowLease.deleteMany({ where: { owner: { in: ['preparing', 'ready', 'failed', 'draining'].map(phase => `${phase}:${groupId}`) } } });
      }
    }
    if (proxyFailed && !stopped) for (const channel of proxyKeys(claim.proxy)) {
      const key = `cooldown:${channel}`, data = { owner: `cooldown:${claim.owner}`, expiresAt: new Date(Date.now() + 60_000) };
      await tx.workflowLease.upsert({ where: { key }, create: { key, ...data }, update: data });
    }
    return result;
  });
}
