import { prisma } from "@/lib/prisma";
export async function warmupCapacity() {
  const [settings, queue, runs] = await Promise.all([
    prisma.settings.findUnique({ where: { id: 1 }, select: { warmupConcurrency: true } }),
    prisma.warmupJob.count({ where: { status: { in: ['queued', 'waiting_stage', 'retry_wait'] }, profile: { isEnabled: true, deletedAt: null }, AND: [{ OR: [{ nextStageAt: null }, { nextStageAt: { lte: new Date() } }] }, { OR: [{ retryAfter: null }, { retryAfter: { lte: new Date() } }] }] } }),
    prisma.profileWarmupEvent.findMany({ where: { event: 'session_saved', createdAt: { gte: new Date(Date.now() - 7 * 86400000) } }, orderBy: { id: 'desc' }, take: 300, select: { details: true } }),
  ]);
  const durations = runs.map(r => Number((r.details as { durationMs?: number }).durationMs)).filter(v => Number.isFinite(v) && v > 60000).sort((a,b) => a-b);
  const durationP50Ms = durations.length ? durations[Math.floor((durations.length - 1) * .5)] : 240000;
  const durationP90Ms = durations.length ? durations[Math.floor((durations.length - 1) * .9)] : 420000;
  return { durationP50Ms, durationP90Ms, queueDelayMs: Math.ceil(queue / (settings?.warmupConcurrency || 1)) * durationP50Ms };
}
