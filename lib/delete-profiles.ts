import "server-only";
import { unlink, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/api";
import publication from '@/utils/profilePublication';

export async function deleteProfiles(ids: string[]) {
  const profileIds = [...new Set(ids)];
  const result = await prisma.$transaction(async tx => {
    // All profile claims use SQLite write transactions. Take the writer lock before inspecting leases.
    await tx.$executeRaw`UPDATE "Settings" SET "id"="id" WHERE "id"=1`;
    const profiles = await tx.profile.findMany({ where: { id: { in: profileIds }, deletedAt: null }, select: { id: true } });
    if (profiles.length !== profileIds.length) throw new ApiError(404, "Один или несколько профилей не найдены. Обновите список.");
    const active = await tx.workflowLease.findFirst({ where: { key: { in: profileIds.map(id => `profile:${id}`) }, expiresAt: { gt: new Date() } } });
    const runningJob = await tx.warmupJob.findFirst({ where: { profileId: { in: profileIds }, status: "running" } });
    const runningExecution = await tx.taskExecution.findFirst({ where: { profileId: { in: profileIds }, status: "running" } });
    if (active || runningJob || runningExecution) throw new ApiError(409, "Среди выбранных есть занятые профили. Дождитесь завершения работы и повторите удаление.");
    for (const id of profileIds) await publication.recoverProfilePublication(tx, { directory: resolve(process.cwd(), process.env.WORKER_PROFILES_DIR ?? 'profiles'), profileId: id });
    await tx.profile.updateMany({ where: { id: { in: profileIds }, deletedAt: null }, data: { deletedAt: new Date(), isEnabled: false } });
    await tx.warmupJob.updateMany({ where: { profileId: { in: profileIds } }, data: { status: "paused", stage: "paused", owner: null, retryAfter: null } });
    return { deleted: profileIds.length };
  }, { maxWait: 10000, timeout: 15000 });
  let cleanupFailed = 0;
  for (const id of profileIds) {
    try { await rm(resolve(process.cwd(), process.env.WORKER_PROFILES_DIR ?? 'profiles', 'browser-data', id), { recursive: true, force: true }); await rm(resolve(process.cwd(), process.env.WORKER_PROFILES_DIR ?? 'profiles', `${id}.json.previous`), { force: true }); await unlink(resolve(process.cwd(), process.env.WORKER_PROFILES_DIR ?? "profiles", `${id}.json`)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") cleanupFailed++; }
  }
  return { ...result, cleanupFailed };
}
