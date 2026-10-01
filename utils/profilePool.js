const { randomUUID } = require('node:crypto');
const eligibleProfiles = projectId => ({ status: { not: 'banned' }, isEnabled: true, warmedAt: { not: null },
  tasks: { none: { taskType: 'warmup', status: { in: ['running', 'paused'] } } },
  ...(projectId ? { projectUses: { none: { projectId } } } : { projectUses: { none: {} } }),
});

class PoolError extends Error {
  constructor(code, message, available) { super(message); this.name = 'PoolError'; this.code = code; this.available = available; }
}

async function createProfileBatch(tx, { count, namePrefix = 'Мобильный профиль', warmup = true }) {
  const batch = randomUUID().slice(0, 8);
  const profiles = Array.from({ length: count }, (_, index) => ({ id: randomUUID(), name: `${namePrefix} · ${batch} · ${index + 1}`, status: warmup ? 'warming_up' : 'new' }));
  await tx.profile.createMany({ data: profiles });
  if (warmup) await tx.task.createMany({ data: profiles.map(profile => ({ id: randomUUID(), profileId: profile.id, taskType: 'warmup', targetExecutions: 1 })) });
  return { profiles, warmupTasksCreated: warmup ? count : 0 };
}

/** @param {any} tx @param {{profileIds?: string[], count?: number}} options */
async function queueWarmups(tx, { profileIds, count }) {
  const profiles = await tx.profile.findMany({
    where: { status: { not: 'banned' }, isEnabled: true, ...(profileIds ? { id: { in: profileIds } } : { warmedAt: null }),
      tasks: { none: { taskType: 'warmup', status: { in: ['running', 'paused'] } } } },
    orderBy: { createdAt: 'asc' }, ...(count ? { take: count } : {}),
  });
  if (profileIds && profiles.length !== profileIds.length) throw new PoolError('warmup_unavailable', 'Часть профилей недоступна или уже поставлена на прогрев');
  if (!profiles.length) throw new PoolError('warmup_unavailable', 'Нет новых активных профилей без задачи прогрева');
  await tx.task.createMany({ data: profiles.map(profile => ({ id: randomUUID(), profileId: profile.id, taskType: 'warmup', targetExecutions: 1 })) });
  await tx.profile.updateMany({ where: { id: { in: profiles.map(profile => profile.id) } }, data: { status: 'warming_up' } });
  return { queued: profiles.length, profileIds: profiles.map(profile => profile.id) };
}

async function allocateProjectTask(tx, data) {
  const project = await tx.project.findUnique({ where: { id: data.projectId } });
  if (!project) throw new PoolError('project_missing', 'Проект не найден');
  if (data.taskType !== 'target') throw new PoolError('invalid_project_task', 'Прогрев создаётся отдельно от проекта');
  if (data.currentExecutions) throw new PoolError('invalid_counter', 'Новая задача проекта должна начинаться с нулевого счётчика');
  const profiles = await tx.profile.findMany({ where: eligibleProfiles(project.id), orderBy: [{ warmedAt: 'asc' }, { createdAt: 'asc' }], take: data.targetExecutions });
  if (profiles.length < data.targetExecutions) throw new PoolError('insufficient_profiles', `Нужно ${data.targetExecutions} прогретых профилей; доступно ${profiles.length}. Пополните запас и повторите создание.`, profiles.length);
  const { profileId: _manualProfile, ...fields } = data;
  const task = await tx.task.create({ data: { ...fields, yandexRegionId: Number(project.yandexRegionId), profileId: profiles[0].id } });
  await tx.projectProfileUse.createMany({ data: profiles.map(profile => ({ id: randomUUID(), projectId: project.id, profileId: profile.id, taskId: task.id })) });
  await tx.taskExecution.createMany({ data: profiles.map(profile => ({ id: randomUUID(), taskId: task.id, profileId: profile.id })) });
  return task;
}

async function replenishPool(prisma) {
  return prisma.$transaction(async tx => {
    const settings = await tx.settings.findUnique({ where: { id: 1 } });
    if (!settings?.autoReplenishEnabled) return { created: 0 };
    const ready = await tx.profile.count({ where: eligibleProfiles() });
    const warming = await tx.profile.count({ where: { status: { not: 'banned' }, isEnabled: true, warmedAt: null, tasks: { some: { taskType: 'warmup', status: 'running' } } } });
    const count = Math.min(settings.replenishBatchSize, Math.max(0, settings.minReadyProfiles - ready - warming));
    if (!count) return { created: 0, ready, warming };
    await createProfileBatch(tx, { count, namePrefix: 'Автопополнение', warmup: true });
    return { created: count, ready, warming };
  }, { timeout: 15000 });
}
module.exports = { PoolError, eligibleProfiles, createProfileBatch, queueWarmups, allocateProjectTask, replenishPool };
