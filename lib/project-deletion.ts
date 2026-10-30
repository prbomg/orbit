import { setTimeout as delay } from "node:timers/promises";
import type { PrismaClient, Prisma } from "@prisma/client";
import { ApiError } from "@/lib/api";
import { projectRunStatus } from "@/lib/project-runner";

export async function projectDeletionInfo(tx: Prisma.TransactionClient, id: string) {
  const project = await tx.project.findUnique({ where: { id }, select: { name: true } });
  if (!project) throw new ApiError(404, "Проект не найден");
  const [tasks, executions, visits, profileUses, profileHistory, runningTasks, runningExecutions] = await Promise.all([
    tx.task.count({ where: { projectId: id } }),
    tx.taskExecution.count({ where: { task: { projectId: id } } }),
    tx.projectVisit.count({ where: { projectId: id } }),
    tx.projectProfileUse.count({ where: { projectId: id } }),
    tx.profileProjectHistory.count({ where: { projectId: id } }),
    tx.task.count({ where: { projectId: id, status: "running" } }),
    tx.taskExecution.count({ where: { task: { projectId: id }, status: "running" } }),
  ]);
  const run = projectRunStatus(id);
  const blocked = runningTasks > 0 || runningExecutions > 0 || ["running", "waiting", "stopping"].includes(run.state);
  return { name: project.name, tasks, executions, visits, profileUses, profileHistory, blocked };
}

export async function deleteProject(tx: Prisma.TransactionClient, id: string, confirmation?: string) {
  const info = await projectDeletionInfo(tx, id);
  if (info.blocked) throw new ApiError(409, "Остановите проект и дождитесь завершения активных выполнений, затем повторите удаление.");
  if (confirmation !== undefined && confirmation !== info.name) throw new ApiError(400, "Название проекта не совпадает. Обновите окно удаления и введите точное название.");
  if (confirmation === undefined && (info.tasks || info.executions || info.visits || info.profileUses || info.profileHistory)) {
    throw new ApiError(409, "Для удаления проекта с задачами и историей требуется подтверждение названия проекта.");
  }
  // Remove only project-owned records. Profiles, proxies and other projects stay intact.
  // TaskExecution and TaskDailyPlan cascade from Task in the existing schema.
  await tx.projectVisit.deleteMany({ where: { projectId: id } });
  await tx.projectProfileUse.deleteMany({ where: { projectId: id } });
  await tx.profileProjectHistory.deleteMany({ where: { projectId: id } });
  await tx.task.deleteMany({ where: { projectId: id } });
  await tx.project.delete({ where: { id } });
}

// Retry only database contention; every failed attempt rolls back all deletions.
export async function deleteProjectTransaction(db: PrismaClient, id: string, confirmation?: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.$transaction(async tx => {
        // Acquire the writer before taking a WAL read snapshot; no rows change.
        await tx.$executeRaw`DELETE FROM "Project" WHERE 0`;
        await deleteProject(tx, id, confirmation);
      }, { maxWait: 10000, timeout: 15000 });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (attempt >= 3 || !["P1008", "P2024", "P2034"].includes(code || "")) {
        if (["P1008", "P2024", "P2034"].includes(code || "")) throw new ApiError(503, "База занята. Проект не удалён; повторите удаление позже.");
        throw error;
      }
      await delay(100 * 2 ** attempt);
    }
  }
}
