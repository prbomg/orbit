import { withAuth } from "@/lib/auth";
import { taskInclude, withTaskDailyState } from "@/lib/task-view";
import { prisma } from "@/lib/prisma";
import { ApiError, apiError, json, readBody } from "@/lib/api";
import { createTaskSchema } from "@/lib/api-validation";
import { startProjectRun } from "@/lib/project-runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function GETHandler(request: Request) {
  try { const projectId = new URL(request.url).searchParams.get("projectId"); const tasks = await prisma.task.findMany({ where: { taskType: "target", ...(projectId ? { projectId } : { project: { archivedAt: null } }) }, orderBy: { createdAt: "desc" }, include: taskInclude }); return json(await Promise.all(tasks.map(withTaskDailyState))); }
  catch (error) { return apiError(error); }
}

async function POSTHandler(request: Request) {
  try {
    const { profileId, projectId, ...data } = createTaskSchema.parse(await readBody(request));
    if (data.taskType !== "target") throw new ApiError(400, "Прогрев управляется в разделе «Профили»");
    if (profileId) throw new ApiError(400, "Прогретый профиль подбирается автоматически перед выполнением");
    const task = await prisma.$transaction(async tx => {
      const project = await tx.project.findUniqueOrThrow({ where: { id: projectId! } });
      if (project.archivedAt) throw new ApiError(409, "Проект в архиве. Сначала восстановите его.");
      return tx.task.create({ data: { ...data, name: data.name ?? project.name, projectId: project.id, profileId: null, url: !data.searchEngine ? data.url || project.targetUrl : "" }, include: taskInclude });
    });
    if (task.status === "running") {
      try { await startProjectRun(task.projectId!); }
      catch (error) { if (!(error instanceof ApiError && error.status === 409)) console.error("Task created; project worker could not start", error instanceof Error ? error.name : "Error"); }
    }
    return json(await withTaskDailyState(task), 201);
  } catch (error) { return apiError(error); }
}

export const GET = withAuth(GETHandler);
export const POST = withAuth(POSTHandler);
