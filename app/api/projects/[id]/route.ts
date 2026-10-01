import { prisma } from "@/lib/prisma";
import { ApiError, apiError, json, readBody, checkDeleteOrigin } from "@/lib/api";
import { updateProjectSchema } from "@/lib/api-validation";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export async function GET(_request: Request, { params }: Context) {
  try {
    const project = await prisma.project.findUnique({
      where: { id: (await params).id },
      include: {
        _count: { select: { tasks: true, profileUses: true, profileHistory: true } },
        profileHistory: { orderBy: { executedAt: "desc" }, take: 100, include: { profile: { select: { id: true, name: true } } } },
      },
    });
    return project ? json(project) : json({ error: "Проект не найден" }, 404);
  } catch (error) { return apiError(error); }
}
export async function PATCH(request: Request, { params }: Context) {
  try { return json(await prisma.project.update({ where: { id: (await params).id }, data: updateProjectSchema.parse(await readBody(request)) })); }
  catch (error) { return apiError(error); }
}
export async function DELETE(request: Request, { params }: Context) {
  try {
    checkDeleteOrigin(request); const id = (await params).id;
    await prisma.$transaction(async tx => {
      if (await tx.task.count({ where: { projectId: id } }) || await tx.projectProfileUse.count({ where: { projectId: id } }) || await tx.profileProjectHistory.count({ where: { projectId: id } })) throw new ApiError(409, "Проект с задачами или историей профилей удалить нельзя");
      await tx.project.delete({ where: { id } });
    });
    return new Response(null, { status: 204 });
  } catch (error) { return apiError(error); }
}
