import { taskInclude } from "@/lib/task-view";
import { prisma } from "@/lib/prisma";
import { ApiError, apiError, checkDeleteOrigin, json, readBody } from "@/lib/api";
import { replaceTaskSchema, updateTaskSchema, validTargetTask } from "@/lib/api-validation";
import { taskProfile } from "@/lib/task-profile";
import { refreshWarmupStatus } from "@/lib/profile-lifecycle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Context) {
  try {
    const task = await prisma.task.findUnique({ where: { id: (await params).id }, include: taskInclude });
    return task ? json(task) : json({ error: "Запись не найдена" }, 404);
  } catch (error) { return apiError(error); }
}

async function update(request: Request, { params }: Context, replace: boolean) {
  try {
    const { profileId, ...data } = (replace ? replaceTaskSchema : updateTaskSchema).parse(await readBody(request));
    const id = (await params).id;
    const task = await prisma.$transaction(async tx => {
      const current = await tx.task.findUniqueOrThrow({ where: { id } });
      if ((data.projectId ?? current.projectId) !== current.projectId || (data.projectId === null && current.projectId)) throw new ApiError(400, "Перенос задачи между проектами недоступен; создайте новую задачу");
      if (current.projectId && data.taskType === "warmup") throw new ApiError(400, "Прогрев создаётся вне проекта");
      const limit = data.targetExecutions ?? current.targetExecutions;
      if ((data.taskType ?? current.taskType) === "warmup" && data.targetExecutions !== undefined && data.targetExecutions !== current.targetExecutions) throw new ApiError(400, "Для повторного прогрева создайте отдельную задачу профиля");
      if (limit < current.currentExecutions) throw new ApiError(400, "План не может быть меньше уже выполненного количества");
      if (data.status === "running" && current.currentExecutions >= limit) throw new ApiError(400, "План уже выполнен; увеличьте количество выполнений перед запуском");
      if (!validTargetTask({ ...current, ...data })) {
        throw new ApiError(400, "Проверьте проект и параметры сценария");
      }
      const { projectId: _projectId, ...fields } = data;
      if (profileId) { const profile = await tx.profile.findUnique({ where: { id: profileId } }); if (profile && (profile.status === "banned" || !profile.isEnabled)) throw new ApiError(400, "Выбранный профиль заблокирован или выключен"); }
      const updated = await tx.task.update({ where: { id }, data: { ...fields, ...(profileId ? { profile: taskProfile(profileId) } : {}) }, include: taskInclude });
      if (updated.taskType === "warmup") await refreshWarmupStatus(tx, updated.profileId);
      if (current.taskType === "warmup" && current.profileId !== updated.profileId) await refreshWarmupStatus(tx, current.profileId);
      return tx.task.findUniqueOrThrow({ where: { id }, include: taskInclude });
    });
    return json(task);
  } catch (error) { return apiError(error); }
}
export async function PATCH(request: Request, context: Context) { return update(request, context, false); }
export async function PUT(request: Request, context: Context) { return update(request, context, true); }

export async function DELETE(request: Request, { params }: Context) {
  try {
    checkDeleteOrigin(request);
    const id = (await params).id;
    await prisma.$transaction(async tx => {
      const removed = await tx.task.delete({ where: { id } });
      if (removed.taskType === "warmup") await refreshWarmupStatus(tx, removed.profileId);
    });
    return new Response(null, { status: 204 });
  } catch (error) { return apiError(error); }
}
