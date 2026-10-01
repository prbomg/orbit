/** Database bookkeeping shared by executors. This function performs no browser actions. */
async function commitTaskExecution(tx, { taskId, profileId, where = {}, completeAfterRun = false, publish = async () => {} }) {
  const task = await tx.task.findUnique({ where: { id: taskId }, include: { profile: true } });
  if (!task || task.profileId !== profileId || task.status !== 'running' || !task.profile.isEnabled || task.profile.status === 'banned' || task.currentExecutions >= task.targetExecutions) return { count: 0 };
  const completed = task.currentExecutions + 1 >= task.targetExecutions || completeAfterRun;
  const result = await tx.task.updateMany({
    where: { ...where, id: taskId, profileId, status: 'running', currentExecutions: task.currentExecutions, targetExecutions: task.targetExecutions, profile: { isEnabled: true, status: { not: 'banned' } } },
    data: { currentExecutions: { increment: 1 }, ...(completed ? { status: 'completed' } : {}) },
  });
  if (!result.count) return result;
  await publish();
  if (task.taskType === 'warmup') {
    await tx.profile.update({ where: { id: profileId }, data: { status: 'ready', warmupScore: { increment: 1 }, warmedAt: new Date() } });
  } else if (task.projectId) {
    await tx.profileProjectHistory.create({ data: { profileId, projectId: task.projectId } });
    await tx.projectProfileUse.updateMany({ where: { taskId, profileId, projectId: task.projectId, usedAt: null }, data: { usedAt: new Date() } });
  }
  return result;
}
module.exports = { commitTaskExecution };
