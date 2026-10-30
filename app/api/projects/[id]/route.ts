import { deleteProjectTransaction, projectDeletionInfo } from "@/lib/project-deletion";
import archive from "@/utils/projectArchive";
import { z } from "zod";
import { projectAvailability } from "@/utils/profilePool";
import { withAuth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ApiError, apiError, json, readBody, checkDeleteOrigin } from "@/lib/api";
import { updateProjectSchema } from "@/lib/api-validation";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
async function GETHandler(request: Request, { params }: Context) {
  try {
    const id = (await params).id;
    if (new URL(request.url).searchParams.get("deletion") === "1") return json(await projectDeletionInfo(prisma, id));
    const project = await prisma.project.findUnique({
      where: { id },
      include: {
        _count: { select: { tasks: true, profileUses: true, profileHistory: true } },
      },
    });
    return project ? json({ ...project, pool: await projectAvailability(prisma, project.id) }) : json({ error: "Проект не найден" }, 404);
  } catch (error) { return apiError(error); }
}
async function PATCHHandler(request: Request, { params }: Context) {
  try {
    const id = (await params).id, data = updateProjectSchema.parse(await readBody(request));
    return json(await prisma.$transaction(async tx => {
      const current = await tx.project.findUniqueOrThrow({ where: { id } });
      const changesLocation = (data.yandexRegionId !== undefined && data.yandexRegionId !== current.yandexRegionId) ||
        (data.geolocation !== undefined && JSON.stringify(data.geolocation) !== JSON.stringify(current.geolocation));
      if (changesLocation && await tx.taskExecution.count({ where: { task: { projectId: id }, status: 'running' } })) {
        throw new ApiError(409, 'Дождитесь завершения активных попыток перед изменением региона или геолокации.');
      }
      return tx.project.update({ where: { id }, data });
    }));
  }
  catch (error) { return apiError(error); }
}
async function DELETEHandler(request: Request, { params }: Context) {
  try {
    checkDeleteOrigin(request); const id = (await params).id;
    const body = request.body !== null && request.headers.get("content-type")?.includes("application/json")
      ? z.object({ deleteHistory: z.literal(true), confirmation: z.string().min(1).max(100) }).strict().parse(await readBody(request))
      : null;
    await deleteProjectTransaction(prisma, id, body?.confirmation);
    return new Response(null, { status: 204 });
  } catch (error) { return apiError(error); }
}

async function POSTHandler(request: Request, { params }: Context) {
  try {
    const { action } = z.object({ action: z.enum(["archive", "restore"]) }).strict().parse(await readBody(request));
    const id = (await params).id;
    const result = await prisma.$transaction(tx => archive.changeArchive(tx, id, action));
    return json(result);
  } catch (error) {
    if (error instanceof Error && error.message === "project_active") return apiError(new ApiError(409, "В проекте выполняется задача. Приостановите проект и дождитесь завершения текущих попыток."));
    if (error instanceof Error && error.message === "project_missing") return apiError(new ApiError(404, "Проект не найден"));
    return apiError(error);
  }
}
export const POST = withAuth(POSTHandler);
export const GET = withAuth(GETHandler);
export const PATCH = withAuth(PATCHHandler);
export const DELETE = withAuth(DELETEHandler);
