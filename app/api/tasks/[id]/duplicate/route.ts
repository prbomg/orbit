import { Prisma } from "@prisma/client";
import { withAuth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ApiError, apiError, json, checkDeleteOrigin as checkWriteOrigin } from "@/lib/api";
export const runtime = "nodejs";
const copyJson = (value: Prisma.JsonValue) => value === null ? Prisma.JsonNull : value as Prisma.InputJsonValue;
export const POST = withAuth(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  try {
    checkWriteOrigin(request);
    const { id } = await params;
    const copy = await prisma.$transaction(async tx => {
      const source = await tx.task.findUnique({ where: { id }, include: { project: true } });
      if (!source) throw new ApiError(404, "Задача не найдена");
      if (source.taskType !== "target" || !source.project) throw new ApiError(400, "Можно копировать только задачи проекта");
      if (source.project.archivedAt) throw new ApiError(409, "Сначала восстановите проект из архива");
      // New identity and paused state; defaults reset progress, retries and leases.
      // No worker launch: the operator starts the copy explicitly.
      return tx.task.create({ data: {
        name: source.name, projectId: source.projectId, taskType: "target", status: "paused",
        targetExecutions: source.targetExecutions, concurrency: source.concurrency,
        dailyExecutionLimit: source.dailyExecutionLimit, yandexRegionId: source.yandexRegionId,
        searchEngine: source.searchEngine, searchDepth: source.searchDepth,
        searchQueries: copyJson(source.searchQueries), vitalPhrases: copyJson(source.vitalPhrases),
        visitSettings: copyJson(source.visitSettings), url: source.url,
        targetKeywords: copyJson(source.targetKeywords),
      } });
    });
    return json(copy, 201);
  } catch (error) { return apiError(error); }
});
