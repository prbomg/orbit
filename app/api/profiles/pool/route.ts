import { CURRENT_GENERATION_VERSION, CURRENT_ADAPTER_VERSION } from "@/utils/fingerprint";
import { DEVICE_CATALOG } from "@/utils/deviceCatalog";
import { eligibleProfiles } from "@/utils/profilePool";
import readiness from "@/utils/profileReadiness";
import plans from "@/utils/warmupPlan";
import { withAuth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { json } from "@/lib/api";
export const dynamic = "force-dynamic";
export const GET = withAuth(async () => {
  const [total, ready, disabled, jobs, busy, service, proxies, settings, needsCheck, stalled] = await Promise.all([
    prisma.profile.count({ where: { deletedAt: null } }), prisma.profile.count({ where: eligibleProfiles() }),
    prisma.profile.count({ where: { deletedAt: null, isEnabled: false } }),
    prisma.warmupJob.groupBy({ by: ["status"], where: { profile: { deletedAt: null } }, _count: true }),
    prisma.workflowLease.count({ where: { key: { startsWith: "profile:" }, expiresAt: { gt: new Date() } } }),
    prisma.workflowLease.findUnique({ where: { key: "warmup-service" } }),
    prisma.proxy.findMany({ where: { isActive: true }, select: { channel: true, host: true, purpose: true } }),
    prisma.settings.findUnique({ where: { id: 1 }, select: { dailyProfileDemand: true, minReadyProfiles: true, maxPendingProfiles: true, warmupStageIntervalMinutes: true, warmupPlanPreset: true, fingerprintMode: true } }),
    prisma.profile.count({ where: readiness.needsCheckWhere() }),
    prisma.warmupJob.count({ where: { profile: { deletedAt: null }, status: { in: ['retry_wait', 'running'] }, dependencySince: { lte: new Date(Date.now() - 6 * 3600000) } } }),
  ]);
  return json({ plan: plans.createPlan(settings || {}), generator: { version: CURRENT_GENERATION_VERSION, adapter: CURRENT_ADAPTER_VERSION, catalogVersion: DEVICE_CATALOG.version, source: settings?.fingerprintMode || "auto" }, total, ready, disabled, busy, needsCheck, stalled, pipelineRecommended: Math.ceil((settings?.dailyProfileDemand || 0) * plans.createPlan(settings || {}).minAgeHours / 24 * 1.25), jobs: Object.fromEntries(jobs.map(j => [j.status, j._count])),
    workerOnline: Boolean(service && service.expiresAt > new Date()),
    proxyChannels: new Set(proxies.map(p => p.channel || p.host)).size,
    warmupProxyChannels: new Set(proxies.filter(p => p.purpose !== "target").map(p => p.channel || p.host)).size });
});
