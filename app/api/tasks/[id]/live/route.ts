import { prisma } from "@/lib/prisma";
import { apiError, json } from "@/lib/api";
import { readLiveEvents, screenshotVersion, taskLiveFiles, taskLiveStatus } from "@/lib/task-live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const task = await prisma.task.findUnique({ where: { id }, select: { id: true, projectId: true, status: true, currentExecutions: true, targetExecutions: true } });
    if (!task) return json({ error: "Задача не найдена" }, 404);
    if (!task.projectId) return json({ error: "Наблюдение доступно для задач проекта" }, 400);
    const files = await taskLiveFiles(task.projectId, id);
    const [events, imageVersion] = files ? await Promise.all([readLiveEvents(files.events), screenshotVersion(files.screenshot)]) : [[], null];
    return json({ task, run: taskLiveStatus(task.projectId, id), events, imageVersion });
  } catch (error) { return apiError(error); }
}
