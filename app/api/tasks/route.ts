import { taskInclude } from "@/lib/task-view";
import { prisma } from "@/lib/prisma";
import { ApiError, apiError, json, readBody } from "@/lib/api";
import { createTaskSchema } from "@/lib/api-validation";
import { taskProfile } from "@/lib/task-profile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try { const projectId = new URL(request.url).searchParams.get("projectId"); return json(await prisma.task.findMany({ where: projectId ? { projectId } : {}, orderBy: { createdAt: "desc" }, include: taskInclude })); }
  catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  try {
    const { profileId, projectId, ...data } = createTaskSchema.parse(await readBody(request));
    if (data.taskType === "warmup" && data.targetExecutions !== 1) throw new ApiError(400, "Одна задача прогрева соответствует одному обходу профиля");
    const task = await prisma.$transaction(async tx => {
      const project = projectId ? await tx.project.findUniqueOrThrow({ where: { id: projectId } }) : null;
      if (profileId) { const profile = await tx.profile.findUnique({ where: { id: profileId } }); if (profile && (profile.status === "banned" || !profile.isEnabled)) throw new ApiError(400, "Выбранный профиль заблокирован или выключен"); }
      const created = await tx.task.create({ data: { ...data, url: data.taskType === "target" && !data.searchEngine ? data.url || project!.targetUrl : "", profile: taskProfile(profileId), ...(project ? { project: { connect: { id: project.id } } } : {}) }, include: taskInclude });
      if (data.taskType === "warmup") await tx.profile.update({ where: { id: created.profileId }, data: { status: "warming_up" } });
      return tx.task.findUniqueOrThrow({ where: { id: created.id }, include: taskInclude });
    });
    return json(task, 201);
  } catch (error) { return apiError(error); }
}
