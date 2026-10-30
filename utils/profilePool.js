const { localPassport, identityHash } = require('./fingerprint.js');
const { randomUUID } = require('node:crypto');
const { Prisma } = require('@prisma/client');
const { journalEntry } = require('./warmupJournal.js');
const { actionReason } = require('./profileActions.js');
const plans = require('./warmupPlan.js');
const readiness = require('./profileReadiness.js');
const WARMUP_STAGES = 6;
const eligibleProfiles = readiness.eligibleWhere;
class PoolError extends Error {
  constructor(code, message, available = 0) { super(message); this.name = 'PoolError'; this.code = code; this.available = available; }
}
async function createProfileBatch(tx, { count, namePrefix = 'Мобильный профиль', warmup = true }) {
  if (!warmup) throw new PoolError('warmup_required', 'Новые профили обязательно проходят прогрев');
  const batch = randomUUID().slice(0, 8);
  const settings = await tx.settings.findUnique({ where: { id: 1 } });
  const plan = plans.createPlan(settings || {});
  const profiles = Array.from({ length: count }, (_, index) => { const fingerprint = localPassport(settings || {}), id = randomUUID(); return { id, name: `${namePrefix} · ${batch} · ${index + 1}`, status: 'queued', storageMode: 'persistent', fingerprint, fingerprintHash: identityHash(id, fingerprint) }; });
  await tx.profile.createMany({ data: profiles });
  await tx.warmupJob.createMany({ data: profiles.map(profile => ({ id: randomUUID(), profileId: profile.id, currentStage: 1, totalStages: plan.offsetsHours.length, plan, stage: 'stage_1_queued', updatedAt: new Date() })) });
  await tx.profileWarmupEvent.createMany({ data: profiles.map(profile => journalEntry({ profileId: profile.id, stage: 1 }, 'queued')) });
  return { profiles: profiles.map(({ fingerprint, ...profile }) => profile), queued: count, warmupTasksCreated: 0 };
}
/** Actions never reset a completed preparation implicitly.
 * @param {any} tx @param {{profileIds?: string[], count?: number, action?: string}} options */
async function queueWarmups(tx, { profileIds, count, action = 'retry' }) {
  const leased = await tx.workflowLease.findMany({ where: { key: { startsWith: 'profile:' }, expiresAt: { gt: new Date() } } });
  const settings = await tx.settings.findUnique({ where: { id: 1 } });
  const profiles = await tx.profile.findMany({ where: { isEnabled: true, deletedAt: null, status: { not: 'banned' }, ...(profileIds ? { id: { in: profileIds } } : { warmedAt: null }) }, include: { warmupJob: true }, orderBy: { createdAt: 'asc' }, ...(count ? { take: count } : {}) });
  const processed = [], skippedDetails = [];
  for (const profile of profiles) {
    const old = profile.warmupJob;
    const reason = actionReason(profile, action, leased.some(l => l.key === `profile:${profile.id}`));
    if (reason) { skippedDetails.push({ id: profile.id, reason }); continue; }
    const restart = action === 'restart';
    const verification = action === 'verify';
    const plan = verification ? plans.createPlan(settings || {}, 'verification') : restart || !old ? plans.createPlan(settings || {}) : plans.planFor(old, settings || {});
    const currentStage = restart || verification ? 1 : old?.currentStage || 1;
    const nextStageAt = restart || verification ? null : old?.nextStageAt;
    const retryAfter = restart || verification ? null : old?.retryAfter;
    const status = nextStageAt && nextStageAt > new Date() ? 'waiting_stage' : retryAfter && retryAfter > new Date() ? 'retry_wait' : 'queued';
    const data = { status, attempts: action === 'resume' ? old?.attempts || 0 : 0, currentStage, totalStages: plan.offsetsHours.length, plan, stage: `stage_${currentStage}_${status}`, progress: Math.round((currentStage - 1) / plan.offsetsHours.length * 100), errorCode: action === 'resume' ? old?.errorCode : null, retryAfter, nextStageAt, owner: null, startedAt: null, completedAt: null, ...(restart ? { firstSessionAt: null, minReadyAt: null } : {}), dependencySince: action === 'resume' ? old?.dependencySince || null : null, dependencyRetries: action === 'resume' ? old?.dependencyRetries || 0 : 0 };
    const job = await tx.warmupJob.upsert({ where: { profileId: profile.id }, create: { profileId: profile.id, ...data }, update: data });
    await tx.profile.update({ where: { id: profile.id }, data: { status: verification ? 'needs_check' : 'queued', readinessVersion: 0, readinessVerifiedAt: null, readinessValidUntil: null, ...(restart || (!old && !verification) ? { warmedAt: null, sessionCheck: Prisma.DbNull } : {}) } });
    await tx.profileWarmupEvent.create({ data: journalEntry({ profileId: profile.id, jobId: job.id, stage: currentStage }, restart ? 'restart_queued' : verification ? 'verification_queued' : action === 'resume' ? 'resumed' : 'queued', { nextStageAt, retryAfter }) });
    processed.push(profile.id);
  }
  for (const id of profileIds || []) if (!profiles.some(p => p.id === id)) skippedDetails.push({ id, reason: 'disabled_or_missing' });
  return { queued: processed.length, skipped: skippedDetails.length, skippedDetails, profileIds: processed };
}
async function projectAvailability(tx, projectId) {
  const [available, tasks] = await Promise.all([
    tx.profile.count({ where: eligibleProfiles(projectId) }),
    tx.task.findMany({ where: { projectId, taskType: 'target', status: 'running' }, select: { targetExecutions: true, currentExecutions: true } }),
  ]);
  const remaining = tasks.reduce((sum, t) => sum + Math.max(0, t.targetExecutions - t.currentExecutions), 0);
  return { available, remaining, deficit: Math.max(0, remaining - available) };
}
async function replenishPool(prisma) {
  return prisma.$transaction(async tx => {
    // Acquire the SQLite writer before reads, serializing competing replenishers.
    await tx.$executeRaw`UPDATE "Settings" SET "id" = "id" WHERE "id" = 1`;
    const settings = await tx.settings.findUnique({ where: { id: 1 } });
    if (!settings?.autoReplenishEnabled) return { created: 0 };
    const ready = await tx.profile.count({ where: eligibleProfiles() });
    const pending = await tx.warmupJob.count({ where: { status: { in: ['queued', 'running', 'retry_wait', 'waiting_stage'] }, profile: { isEnabled: true, deletedAt: null, status: { not: 'banned' } } } });
    const unresolved = pending;
    const pipelineTarget = Math.ceil(settings.dailyProfileDemand * plans.createPlan(settings).minAgeHours / 24 * 1.25);
    let needed = Math.max(0, settings.minReadyProfiles + pipelineTarget - ready);
    const projects = await tx.project.findMany({ where: { tasks: { some: { taskType: 'target', status: 'running' } } }, select: { id: true } });
    for (const project of projects) needed = Math.max(needed, (await projectAvailability(tx, project.id)).deficit);
    // A new profile can serve several projects, so deficits are not summed.
    const count = Math.min(settings.replenishBatchSize, Math.max(0, settings.maxPendingProfiles - unresolved), Math.max(0, needed - pending));
    if (count) await createProfileBatch(tx, { count, namePrefix: 'Автопополнение' });
    return { created: count, ready, pending };
  }, { maxWait: 10000, timeout: 15000 });
}
module.exports = { WARMUP_STAGES, PoolError, eligibleProfiles, createProfileBatch, queueWarmups, projectAvailability, replenishPool };
