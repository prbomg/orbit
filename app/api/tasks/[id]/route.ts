import { withAuth } from "@/lib/auth";
import { taskInclude, withTaskDailyState } from "@/lib/task-view";
import { prisma } from "@/lib/prisma";
import { ApiError, apiError, checkDeleteOrigin, json, readBody } from "@/lib/api";
import { replaceTaskSchema, updateTaskSchema, validTargetTask } from "@/lib/api-validation";
import { startProjectRun } from "@/lib/project-runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

async function GETHandler(_request: Request, { params }: Context) {
  try {
    const task = await prisma.task.findUnique({ where: { id: (await params).id }, include: taskInclude });
    return task ? json(await withTaskDailyState(task)) : json({ error: "Запись не найдена" }, 404);
  } catch (error) { return apiError(error); }
}

async function update(request: Request, { params }: Context, replace: boolean) {
  try {
    const { profileId, ...data } = (replace ? replaceTaskSchema : updateTaskSchema).parse(await readBody(request));
    const id = (await params).id;
    let metadataOnly = false;
    const task = await prisma.$transaction(async tx => {
      const current = await tx.task.findUniqueOrThrow({ where: { id } });
      if ((data.projectId ?? current.projectId) !== current.projectId || (data.projectId === null && current.projectId)) throw new ApiError(400, "Перенос задачи между проектами недоступен; создайте новую задачу");
      if (current.projectId && data.taskType === "warmup") throw new ApiError(400, "Прогрев создаётся вне проекта");
      if (data.status === "running" && current.projectId && (await tx.project.findUnique({ where: { id: current.projectId } }))?.archivedAt) throw new ApiError(409, "Проект в архиве. Сначала восстановите его.");
      const limit = data.targetExecutions ?? current.targetExecutions;
      if ((data.taskType ?? current.taskType) === "warmup" && data.targetExecutions !== undefined && data.targetExecutions !== current.targetExecutions) throw new ApiError(400, "Для повторного прогрева создайте отдельную задачу профиля");
      if (limit < current.currentExecutions) throw new ApiError(400, "План не может быть меньше уже выполненного количества");
      if (data.status === "running" && current.currentExecutions >= limit) throw new ApiError(400, "План уже выполнен; увеличьте количество выполнений перед запуском");
      if (!validTargetTask({ ...current, ...data })) {
        throw new ApiError(400, "Проверьте проект и параметры сценария");
      }
      const { projectId: _projectId, ...fields } = data;
      if (profileId) throw new ApiError(400, "Профиль подбирается автоматически");
      if (data.taskType && data.taskType !== "target") throw new ApiError(400, "Прогрев управляется в разделе «Профили»");
      metadataOnly = data.name !== undefined && Object.entries(fields).every(([key, value]) => key === "name" || JSON.stringify(value) === JSON.stringify(current[key as keyof typeof current]));
      await tx.task.update({ where: { id }, data: { ...fields, ...(data.status === 'running' && current.status === 'failed' ? { retryState: {} } : {}) } });
      return tx.task.findUniqueOrThrow({ where: { id }, include: taskInclude });
    });
    if (!metadataOnly && task.status === "running" && task.currentExecutions < task.targetExecutions && task.projectId) {
      try { await startProjectRun(task.projectId); }
      catch (error) { if (!(error instanceof ApiError && error.status === 409)) console.error("Task updated; project worker could not start", error instanceof Error ? error.name : "Error"); }
    }
    return json(await withTaskDailyState(task));
  } catch (error) { return apiError(error); }
}
async function PATCHHandler(request: Request, context: Context) { return update(request, context, false); }
async function PUTHandler(request: Request, context: Context) { return update(request, context, true); }

async function DELETEHandler(request: Request, { params }: Context) {
  try {
    checkDeleteOrigin(request);
    const id = (await params).id;
    await prisma.$transaction(async tx => {
      await tx.task.delete({ where: { id } });
    });
    return new Response(null, { status: 204 });
  } catch (error) { return apiError(error); }
}

export const GET = withAuth(GETHandler);
export const PATCH = withAuth(PATCHHandler);
export const PUT = withAuth(PUTHandler);
export const DELETE = withAuth(DELETEHandler);
