import { withAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { apiError, json } from '@/lib/api';
import stats from '@/utils/warmupStats';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = withAuth(async (request: Request) => {
  try {
    const days = Math.min(30, Math.max(1, Number(new URL(request.url).searchParams.get('days')) || 7));
    const until = new Date(), since = new Date(+until - days * 86400000), limit = 20000;
    const rows = await prisma.profileWarmupEvent.findMany({ where: { profile: { deletedAt: null }, createdAt: { gte: since, lte: until }, event: { in: stats.EVENTS } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1, select: { id: true, runId: true, event: true, details: true, createdAt: true } });
    const truncated = rows.length > limit;
    const events = rows.slice(0, limit).reverse();
    return json({ ...stats.aggregate(events), since, until, eventsCount: events.length, truncated, oldestEventAt: events[0]?.createdAt ?? null });
  } catch (error) { return apiError(error); }
});
