/** Preserve project history while removing it from the active workspace. */
async function changeArchive(tx, id, action) {
  const project = await tx.project.findUnique({ where: { id } });
  if (!project) throw new Error('project_missing');
  if (action === 'archive') {
    if (await tx.taskExecution.count({ where: { task: { projectId: id }, status: 'running' } })) throw new Error('project_active');
    await tx.task.updateMany({ where: { projectId: id, status: 'running' }, data: { status: 'paused' } });
  }
  return tx.project.update({ where: { id }, data: { archivedAt: action === 'archive' ? project.archivedAt ?? new Date() : null } });
}
module.exports = { changeArchive };
