import { channelKeys } from "@/utils/proxyChannel";
import type { Prisma } from "@prisma/client";
import { ApiError } from "@/lib/api";
async function assertProxyAvailable(tx: Prisma.TransactionClient, id: string, mode: "idle" | "add" | "rotation") {
  const proxy = await tx.proxy.findUniqueOrThrow({ where: { id } });
  const keys = channelKeys(await tx.proxy.findMany(), proxy);
  const leases = await tx.workflowLease.findMany({ where: { expiresAt: { gt: new Date() } } });
  const conflicts = leases.some(lease => {
    const sameChannel = keys.includes(lease.key) || keys.some(key => ["warmup-share", "target-share"].some(kind => lease.key.startsWith(`${kind}:${key}:`))) || (proxy.tcpChannelId && lease.key === `tcp-management:${proxy.tcpChannelId.replace('mobileproxy:', '')}`);
    // A new row or rotation URL does not alter a running session. The scheduler acquires
    // all channel locks before using it. TCP operations must keep stable membership.
    const changesChannel = lease.owner.startsWith("tcp-operation:") || lease.key.startsWith("tcp-management:");
    return sameChannel && (mode === "idle" || changesChannel);
  });
  if (conflicts) throw new ApiError(409, mode !== "idle"
    ? "Сейчас выполняется настройка TCP-пресета канала. Дождитесь её завершения и повторите сохранение прокси."
    : "Прокси сейчас используется. Приостановите выполняющийся прогрев или проект и дождитесь освобождения канала.");
}

export const assertProxyIdle = (tx: Prisma.TransactionClient, id: string) => assertProxyAvailable(tx, id, "idle");
export const assertProxyCanBeAdded = (tx: Prisma.TransactionClient, id: string) => assertProxyAvailable(tx, id, "add");
export const assertProxyCanChangeRotation = (tx: Prisma.TransactionClient, id: string) => assertProxyAvailable(tx, id, "rotation");
