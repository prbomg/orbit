import { withAuth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { apiError, json } from "@/lib/api";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const querySchema = z.object({ after: z.coerce.number().int().positive().optional(), before: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).strict();
export const GET = withAuth(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  try {
    const id = z.string().uuid().parse((await params).id);
    const query = querySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    if (!await prisma.profile.findFirst({ where: { id, deletedAt: null }, select: { id: true } })) return json({ error: "Профиль не найден" }, 404);
    const rows = await prisma.profileWarmupEvent.findMany({ where: { profileId: id, ...(query.after ? { id: { gt: query.after } } : {}), ...(query.before ? { id: { lt: query.before } } : {}) }, orderBy: { id: query.after ? "asc" : "desc" }, take: query.limit + 1,
      select: { id: true, createdAt: true, event: true, runId: true, stage: true, attempt: true, proxyId: true, proxyLabel: true, details: true } });
    const items = rows.slice(0, query.limit);
    return json({ items, hasMore: rows.length > query.limit, nextCursor: items.at(-1)?.id ?? null });
  } catch (error) { return apiError(error); }
});
