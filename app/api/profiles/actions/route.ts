import { z } from "zod";
import { withAuth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { apiError, json, readBody } from "@/lib/api";
import { queueWarmups } from "@/utils/profilePool";
import { deleteProfiles } from "@/lib/delete-profiles";
import { actionReason } from "@/utils/profileActions";
import journal from "@/utils/warmupJournal";
const schema = z.object({ action: z.enum(["pause", "resume", "retry", "enable", "disable", "delete", "restart", "verify"]), profileIds: z.array(z.string().uuid()).min(1).max(1000) , preview: z.boolean().optional() }).strict();
export const POST = withAuth(async (request: Request) => {
  try {
    const { action, profileIds, preview } = schema.parse(await readBody(request));
    if (preview) {
      const [profiles, leases] = await Promise.all([prisma.profile.findMany({ where: { id: { in: profileIds }, deletedAt: null }, include: { warmupJob: true } }), prisma.workflowLease.findMany({ where: { key: { startsWith: 'profile:' }, expiresAt: { gt: new Date() } }, select: { key: true } })]);
      const items = profileIds.map(id => { const p = profiles.find(p => p.id === id); return { id, name: p?.name || id, reason: p ? actionReason(p, action, leases.some(l => l.key === `profile:${id}`)) : 'missing' }; });
      return json({ items, eligible: items.filter(p => !p.reason).length, skipped: items.filter(p => p.reason).length });
    }
    if (action === "delete") return json(await deleteProfiles(profileIds));
    return json(await prisma.$transaction(async tx => {
      await tx.$executeRaw`UPDATE "Settings" SET "id"="id" WHERE "id"=1`;
      if (["retry", "resume", "restart", "verify"].includes(action)) return queueWarmups(tx, { profileIds, action });
      if (action === "enable" || action === "disable") {
        const result = await tx.profile.updateMany({ where: { id: { in: profileIds }, deletedAt: null, status: { not: "banned" } }, data: { isEnabled: action === "enable" } });
        const profiles = await tx.profile.findMany({ where: { id: { in: profileIds }, deletedAt: null, status: { not: "banned" } }, select: { id: true } });
        await tx.profileWarmupEvent.createMany({ data: profiles.map(profile => journal.journalEntry({ profileId: profile.id }, action === "enable" ? "profile_enabled" : "profile_disabled")) });
        return { updated: result.count };
      }
      const jobs = await tx.warmupJob.findMany({ where: { profileId: { in: profileIds }, profile: { deletedAt: null }, status: { in: ["queued", "running", "retry_wait", "waiting_stage"] } }, select: { id: true, profileId: true, currentStage: true } });
      const result = await tx.warmupJob.updateMany({ where: { id: { in: jobs.map(job => job.id) } }, data: { status: "paused", stage: "paused" } });
      await tx.profileWarmupEvent.createMany({ data: jobs.map(job => journal.journalEntry({ profileId: job.profileId, jobId: job.id, stage: job.currentStage }, "paused")) });
      await tx.profile.updateMany({ where: { id: { in: profileIds }, deletedAt: null, status: { in: ["queued", "warming_up"] } }, data: { status: "queued" } });
      return { updated: result.count };
    }, { timeout: 15000 }));
  } catch (error) { return apiError(error); }
});
