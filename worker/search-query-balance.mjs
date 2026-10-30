import { randomInt } from 'node:crypto';
import { sqliteWrite } from './sqlite-write.mjs';
import { TaskStoppedError } from './behavior.mjs';

// A successful opening counts once, including vital refinements. In-flight
// selections count temporarily so concurrent sessions distribute their work.
export async function reserveSearchQuery(prisma, task, queries, pick = randomInt) {
  return sqliteWrite(prisma, async tx => {
    const execution = task.executionId ? await tx.taskExecution.findUnique({ where: { id: task.executionId } }) : null;
    if (task.executionId && (execution?.taskId !== task.id || execution.status !== 'running')) throw new TaskStoppedError();
    if (execution?.selectedSearchQuery && queries.includes(execution.selectedSearchQuery)) return execution.selectedSearchQuery;
    const counts = new Map([...new Set(queries)].map(query => [query, 0]));
    if (!counts.size) throw new Error('No search queries');
    const visits = await tx.projectVisit.groupBy({ by: ['query'], where: { taskId: task.id, kind: 'search' }, _count: { _all: true } });
    for (const visit of visits) if (counts.has(visit.query)) counts.set(visit.query, visit._count._all);
    const active = await tx.taskExecution.findMany({ where: { taskId: task.id, status: 'running', selectedSearchQuery: { not: null } }, select: { id: true, selectedSearchQuery: true } });
    const recorded = new Set((await tx.projectVisit.findMany({ where: { taskId: task.id, executionId: { in: active.map(row => row.id) } }, select: { executionId: true } })).map(row => row.executionId));
    for (const row of active) if (!recorded.has(row.id) && counts.has(row.selectedSearchQuery)) counts.set(row.selectedSearchQuery, counts.get(row.selectedSearchQuery) + 1);
    const minimum = Math.min(...counts.values());
    const candidates = [...counts].filter(([, count]) => count === minimum).map(([query]) => query);
    const query = candidates[pick(candidates.length)];
    if (execution) await tx.taskExecution.update({ where: { id: execution.id }, data: { selectedSearchQuery: query } });
    return query;
  });
}
