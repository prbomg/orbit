import { Prisma } from "@prisma/client";
import { withAuth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ApiError, apiError, json, checkDeleteOrigin as checkWriteOrigin } from "@/lib/api";
export const runtime = "nodejs";
export const POST = withAuth(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  try {
    checkWriteOrigin(request);
    const { id } = await params;
    const copy = await prisma.$transaction(async tx => {
      const source = await tx.project.findUnique({ where: { id } });
      if (!source) throw new ApiError(404, "Проект не найден");
      // Copy settings explicitly: no tasks, profile uses, history or archive state.
      return tx.project.create({ data: {
        name: `${source.name.slice(0, 92)} — копия`, targetUrl: source.targetUrl,
        yandexRegionId: source.yandexRegionId, regionName: source.regionName,
        scheduleHours: source.scheduleHours, scheduleTimezone: source.scheduleTimezone,
        geolocation: source.geolocation === null ? Prisma.JsonNull : source.geolocation as Prisma.InputJsonValue,
      } });
    });
    return json(copy, 201);
  } catch (error) { return apiError(error); }
});
