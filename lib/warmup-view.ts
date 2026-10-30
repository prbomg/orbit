import plans from "@/utils/warmupPlan";
type TimedWarmupJob = { status: string; currentStage: number; totalStages: number; nextStageAt: Date | null; retryAfter: Date | null; completedAt: Date | null; firstSessionAt: Date | null; minReadyAt: Date | null; plan: unknown; dependencySince: Date | null };
export function warmupJobView<T extends TimedWarmupJob>(job: T | null, intervalMinutes: number, now = Date.now(), capacity = { queueDelayMs: 0, durationP50Ms: 240000, durationP90Ms: 420000 }) {
  if (!job) return null;
  const plan = plans.planFor(job, { warmupStageIntervalMinutes: intervalMinutes });
  const elapsedHours = job.firstSessionAt ? Math.max(0, (now - job.firstSessionAt.getTime()) / plans.HOUR) : 0;
  const dependencyHours = job.dependencySince ? Math.max(0, (now - job.dependencySince.getTime()) / plans.HOUR) : 0;
  const firstStart = Math.max(now, job.nextStageAt?.getTime() ?? 0, job.retryAfter?.getTime() ?? 0);
  const remaining = Math.max(1, job.totalStages - job.currentStage + 1);
  const remainingWait = Math.max(0, (plan.offsetsHours.at(-1)! - (plan.offsetsHours[job.currentStage - 1] || 0)) * plans.HOUR);
  const earliest = new Date(Math.max(job.minReadyAt?.getTime() || 0, firstStart + remainingWait, !job.firstSessionAt && plan.mode === 'preparation' ? firstStart + plan.minAgeHours * plans.HOUR : 0));
  const estimated = Math.max(earliest.getTime(), firstStart + remainingWait + remaining * capacity.durationP50Ms + capacity.queueDelayMs);
  const inactive = ['failed', 'paused'].includes(job.status);
  return { ...job, stageLabel: plans.stageLabel({ ...job, plan }), planLabel: plan.label, elapsedHours, dependencyHours,
    overdue: ['waiting_stage', 'queued', 'retry_wait'].includes(job.status) && firstStart === now && Boolean(job.nextStageAt && job.nextStageAt.getTime() < now - 900000),
    earliestReadyAt: job.status === 'completed' ? job.completedAt : earliest,
    estimatedReadyAt: inactive ? null : job.status === 'completed' ? job.completedAt : new Date(estimated),
    estimatedReadyUntil: inactive ? null : job.status === 'completed' ? job.completedAt : new Date(estimated + remaining * Math.max(0, capacity.durationP90Ms - capacity.durationP50Ms) + capacity.queueDelayMs),
  };
}
