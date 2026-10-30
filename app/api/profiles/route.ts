import { profileGeneration } from "@/utils/profileGeneration";
import { warmupCapacity } from "@/lib/warmup-capacity";
import { eligibleProfiles } from "@/utils/profilePool";
import readinessPolicy from "@/utils/profileReadiness";
import { createProfileBatch } from "@/utils/profilePool";
import { withAuth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { apiError, json, readBody } from "@/lib/api";
import { createProfileSchema } from "@/lib/api-validation";
import { warmupJobView } from "@/lib/warmup-view";
import { profileSession } from "@/lib/profile-session";
import { profileReadiness } from "@/lib/profile-readiness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function GETHandler(request: Request) {
  try {
    const query = new URL(request.url).searchParams;
    if (!query.has("page")) return json(await prisma.profile.findMany({ where: { deletedAt: null }, omit: { fingerprint: true, fingerprintCheck: true }, orderBy: { createdAt: "desc" }, take: 100 }));
    const page = Math.max(1, Math.min(100000, Math.floor(Number(query.get("page"))) || 1));
    const search = (query.get("search") || "").slice(0, 100);
    const status = query.get("status") || "";
    const queue = query.get("queue") === "1";
    const where = { deletedAt: null as null, ...(search ? { OR: [{ name: { contains: search } }, { id: { contains: search } }] } : {}),
      ...(queue ? { warmupJob: { status: status || { not: "completed" } } } : status === "disabled" ? { isEnabled: false } : status === "ready" ? { AND: [eligibleProfiles()] } : status === 'needs_check' ? { AND: [readinessPolicy.needsCheckWhere()] } : status === "failed" ? { status: "failed", AND: [{ OR: [{ warmupJob: null }, { warmupJob: { status: { not: "paused" } } }] }] } : status ? { status } : {}) };
    const [total, profiles, leases, settings] = await Promise.all([
      prisma.profile.count({ where }),
      prisma.profile.findMany({ omit: { fingerprintCheck: true }, where, orderBy: query.get('sort') === 'oldest' ? { createdAt: 'asc' } : query.get('sort') === 'next' ? { warmupJob: { nextStageAt: 'asc' } } : { createdAt: 'desc' }, skip: (page - 1) * 25, take: 25,
        include: { warmupJob: { select: { id: true, status: true, attempts: true, stage: true, progress: true, currentStage: true, totalStages: true, errorCode: true, retryAfter: true, nextStageAt: true, completedAt: true, plan: true, firstSessionAt: true, minReadyAt: true, dependencySince: true, dependencyRetries: true } }, _count: { select: { projectUses: true } } } }),
      prisma.workflowLease.findMany({ where: { key: { startsWith: "profile:" }, expiresAt: { gt: new Date() } }, select: { key: true } }),
      prisma.settings.findUnique({ where: { id: 1 }, select: { warmupStageIntervalMinutes: true } }),
    ]);
    const capacity = await warmupCapacity();
    const busy = new Set(leases.map(l => l.key.slice(8)));
    const items = await Promise.all(profiles.map(async profile => {
      const session = await profileSession(profile.id);
      const { fingerprint, ...publicProfile } = profile;
      return { ...publicProfile, generationInfo: profileGeneration(fingerprint), session, readiness: profileReadiness(profile, session), warmupJob: warmupJobView(profile.warmupJob, settings?.warmupStageIntervalMinutes ?? 720, Date.now(), capacity), busy: busy.has(profile.id) };
    }));
    return json({ total, page, pageSize: 25, items });
  } catch (error) { return apiError(error); }
}

async function POSTHandler(request: Request) {
  try {
    const data = createProfileSchema.parse(await readBody(request));
    return json(await prisma.$transaction(async tx => { const result = await createProfileBatch(tx, { count: 1 }); return tx.profile.update({ where: { id: result.profiles[0].id }, data: { name: data.name } }); }), 201);
  }
  catch (error) { return apiError(error); }
}

export const GET = withAuth(GETHandler);
export const POST = withAuth(POSTHandler);
