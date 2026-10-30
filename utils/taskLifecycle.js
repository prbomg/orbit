/** Database bookkeeping shared by executors. This function performs no browser actions. */
async function commitTaskExecution(tx, { taskId, profileId, where = {}, completeAfterRun = false, publish = async () => {}, executionId }) {
  const task = await tx.task.findUnique({ where: { id: taskId }, include: { profile: true } });
  const execution = executionId ? await tx.taskExecution.findUnique({ where: { id: executionId }, include: { profile: true } }) : null;
  const profile = executionId ? execution?.profile : task?.profile;
  if (!task || !profile || (executionId ? execution?.taskId !== taskId || execution.profileId !== profileId || execution.status !== 'running' : task.profileId !== profileId) || task.status !== 'running' || !profile.isEnabled || profile.status === 'banned' || task.currentExecutions >= task.targetExecutions) return { count: 0 };
  const completed = task.currentExecutions + 1 >= task.targetExecutions || completeAfterRun;
  const result = await tx.task.updateMany({
    where: { ...where, id: taskId, ...(executionId ? {} : { profileId, profile: { isEnabled: true, status: { not: 'banned' } } }), status: 'running', currentExecutions: task.currentExecutions, targetExecutions: task.targetExecutions },
    data: { currentExecutions: { increment: 1 }, ...(completed ? { status: 'completed' } : {}) },
  });
  if (!result.count) return result;
  if (executionId) {
    const execution = await tx.taskExecution.updateMany({ where: { id: executionId, taskId, profileId, status: 'running' }, data: { status: 'completed', completedAt: new Date() } });
    if (!execution.count) throw new Error('Execution already committed');
  }
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
