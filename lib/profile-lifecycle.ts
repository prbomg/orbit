import type { Prisma } from "@prisma/client";

export async function refreshWarmupStatus(tx: Prisma.TransactionClient, profileId: string) {
  const profile = await tx.profile.findUnique({ where: { id: profileId } });
  if (!profile || profile.status === "banned") return;
  const queued = await tx.task.count({ where: { profileId, taskType: "warmup", status: { in: ["running", "paused"] } } });
  const status = queued ? "warming_up" : profile.warmupScore > 0 || profile.warmedAt ? "ready" : "new";
  await tx.profile.update({ where: { id: profileId }, data: { status } });
}
