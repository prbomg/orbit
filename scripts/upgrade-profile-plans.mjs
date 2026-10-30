import { PrismaClient } from '@prisma/client';
import pool from '../utils/profilePool.js';
import plans from '../utils/warmupPlan.js';
import journal from '../utils/warmupJournal.js';
import { pathToFileURL } from 'node:url';
export async function upgradeProfilePlans(prisma, { apply = false, pilotCount = 10 } = {}) {
  const jobs = await prisma.warmupJob.findMany({ where: { plan: { equals: (await import('@prisma/client')).Prisma.DbNull }, profile: { deletedAt: null, status: { not: 'banned' } } }, include: { profile: true } });
  if (!apply) return { profilesToUpgrade: jobs.length, pilotCount };
  if (!jobs.length) return { upgraded: 0, pilots: 0 };
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`UPDATE "Settings" SET "id"="id" WHERE "id"=1`;
    if (await tx.workflowLease.count({ where: { key: { startsWith: 'profile:' }, expiresAt: { gt: new Date() } } })) throw new Error('Stop active workers before upgrading plans');
    const settings = await tx.settings.upsert({ where: { id: 1 }, create: { id: 1, warmupStageIntervalMinutes: 720 }, update: { warmupStageIntervalMinutes: 720, maxPendingProfiles: 500 } });
    const plan = plans.createPlan(settings);
    let upgraded = 0;
    for (const job of jobs) {
      const saved = await tx.profileWarmupEvent.findFirst({ where: { profileId: job.profileId, event: 'session_saved' }, orderBy: { id: 'asc' }, select: { createdAt: true } });
      const firstSessionAt = saved?.createdAt || job.profile.warmedAt || null;
      const currentStage = Math.min(3, job.currentStage);
      const status = ['paused','failed'].includes(job.status) ? job.status : currentStage > 1 && firstSessionAt ? 'waiting_stage' : 'queued';
      const nextStageAt = currentStage > 1 && firstSessionAt ? new Date(Math.max(Date.now(), firstSessionAt.getTime() + plan.offsetsHours[currentStage-1]*plans.HOUR, job.nextStageAt?.getTime() || 0)) : null;
      await tx.warmupJob.update({ where: { id: job.id }, data: { plan, totalStages: 6, currentStage, firstSessionAt, minReadyAt: firstSessionAt ? new Date(firstSessionAt.getTime()+72*plans.HOUR) : null, status, stage: `stage_${currentStage}_${status}`, progress: Math.round((currentStage-1)/6*100), owner: null, startedAt: null, completedAt: null, nextStageAt, ...(status === 'queued' || status === 'waiting_stage' ? { errorCode: null } : {}) } });
      await tx.profile.update({ where: { id: job.profileId }, data: { status: status === 'failed' ? 'failed':'queued', warmedAt: null, readinessVerifiedAt: null, readinessValidUntil: null } });
      await tx.profileWarmupEvent.create({ data: journal.journalEntry({ profileId: job.profileId, jobId: job.id, stage: currentStage }, 'plan_upgraded', { nextStageAt }) });
      upgraded++;
    }
    const pilots = await tx.profile.findMany({ where: { deletedAt: null, isEnabled: true, status: 'queued', storageMode: 'snapshot', warmupJob: { status: { in: ['queued', 'waiting_stage'] } } }, select: { id: true }, take: pilotCount, orderBy: { createdAt: 'desc' } });
    await tx.profile.updateMany({ where: { id: { in: pilots.map(p => p.id) } }, data: { storageMode: 'persistent' } });
    return { upgraded, pilots: pilots.length, durationHours: plan.minAgeHours };
  }, { timeout: 60000 });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
 const prisma = new PrismaClient();try{console.log(JSON.stringify(await upgradeProfilePlans(prisma,{apply:process.argv.includes('--apply')})));}finally{await prisma.$disconnect();}
}
