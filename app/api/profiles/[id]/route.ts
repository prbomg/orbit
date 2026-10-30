import { profileQuality } from "@/lib/profile-quality";
import { warmupCapacity } from "@/lib/warmup-capacity";
import { eligibleProfiles } from "@/utils/profilePool";
import { withAuth } from "@/lib/auth";
import { profileSession } from "@/lib/profile-session";
import { profileReadiness } from "@/lib/profile-readiness";
import { prisma } from "@/lib/prisma";
import { ApiError, apiError, json, readBody } from "@/lib/api";
import { checkDeleteOrigin } from "@/lib/api";
import { deleteProfiles } from "@/lib/delete-profiles";
import { z } from "zod";
import { warmupJobView } from "@/lib/warmup-view";
import { updateProfileSchema } from "@/lib/api-validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

async function PATCHHandler(request: Request, { params }: Context) {
  try {
    const data = updateProfileSchema.parse(await readBody(request));
    const id = (await params).id;
    return json(await prisma.$transaction(async tx => {
      await tx.$executeRaw`UPDATE "Settings" SET "id"="id" WHERE "id"=1`;
      const current = await tx.profile.findUniqueOrThrow({ where: { id, deletedAt: null }, select: { storageMode: true } });
      const storageChanged = Boolean(data.storageMode && data.storageMode !== current.storageMode);
      if (storageChanged && await tx.workflowLease.count({ where: { key: `profile:${id}`, expiresAt: { gt: new Date() } } })) throw new ApiError(409, 'Хранилище нельзя менять во время работы профиля.');
      return tx.profile.update({ where: { id, deletedAt: null }, data: { ...data, ...(storageChanged ? { storageResetRequested: true, readinessVerifiedAt: null, readinessValidUntil: null } : {}) } });
    }));
  } catch (error) { return apiError(error); }
}

export const PATCH = withAuth(PATCHHandler);

export const GET = withAuth(async (_request: Request, { params }: Context) => {
  try {
    const id = (await params).id;
    const [profile, settings] = await Promise.all([
      prisma.profile.findUnique({ where: { id, deletedAt: null }, include: { warmupJob: { select: { id: true, status: true, attempts: true, stage: true, progress: true, currentStage: true, totalStages: true, errorCode: true, retryAfter: true, nextStageAt: true, completedAt: true, plan: true, firstSessionAt: true, minReadyAt: true, dependencySince: true, dependencyRetries: true } }, projectUses: { orderBy: { reservedAt: "desc" }, take: 100, select: { id: true, reservedAt: true, usedAt: true, project: { select: { id: true, name: true } } } } } }),
      prisma.settings.findUnique({ where: { id: 1 }, select: { warmupStageIntervalMinutes: true } }),
    ]);
    if (!profile) return json({ error: "Профиль не найден" }, 404);
    const [session, capacity, lease] = await Promise.all([profileSession(id), warmupCapacity(), prisma.workflowLease.findUnique({ where: { key: `profile:${id}` } })]);
    const [measurements, qualification] = await Promise.all([
      prisma.fingerprintMeasurement.findMany({ where: { profileId: id }, orderBy: { createdAt: 'desc' }, take: 20 }),
      prisma.browserQualification.findFirst({ orderBy: { checkedAt: 'desc' } }),
    ]);
    return json({ ...profile, quality: profileQuality(profile, session, measurements, qualification), busy: Boolean(lease && lease.expiresAt > new Date()), warmupJob: warmupJobView(profile.warmupJob, settings?.warmupStageIntervalMinutes ?? 720, Date.now(), capacity), session, readiness: profileReadiness(profile, session) });
  } catch (error) { return apiError(error); }
});

export const DELETE = withAuth(async (request: Request, { params }: Context) => {
  try { checkDeleteOrigin(request); return json(await deleteProfiles([z.string().uuid().parse((await params).id)])); }
  catch (error) { return apiError(error); }
});
