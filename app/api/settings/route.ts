import { DEVICE_CATALOG, resolveWeights } from '@/utils/deviceCatalog';
import { isWarmupAllowed } from "@/utils/projectSchedule";
import type { Settings } from "@prisma/client";
import { withAuth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { apiError, json, readBody } from "@/lib/api";
import { settingsSchema } from "@/lib/api-validation";
import { resolveDonorSites } from "@/utils/donorSites";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function publicSettings(settings: Settings | null) {
  const stored = Boolean(settings?.openaiApiKey);
  const environment = Boolean(process.env.OPENAI_API_KEY?.trim());
  const warmupSharedProxy = settings?.warmupSharedProxy ?? true;
  return { warmupPlanPreset: settings?.warmupPlanPreset ?? "standard", fingerprintCatalog:DEVICE_CATALOG, fingerprintDeviceWeights:resolveWeights(settings?.fingerprintDeviceWeights), fingerprintDistributionRevision:settings?.fingerprintDistributionRevision??1, capguruConfigured: Boolean(settings?.capguruApiKey), captchaPrimary: settings?.captchaPrimary ?? "rucaptcha", captchaFallbackAfter: settings?.captchaFallbackAfter ?? 2, warmupScheduleAllowed: isWarmupAllowed(settings), updatedAt: settings?.updatedAt.toISOString() ?? null, dailyProfileDemand: settings?.dailyProfileDemand ?? 0, readinessFreshnessHours: settings?.readinessFreshnessHours ?? 72, fingerprintDevicePreset: settings?.fingerprintDevicePreset ?? "mixed", fingerprintMode: settings?.fingerprintMode ?? "auto", fingerprintLocale: settings?.fingerprintLocale ?? "ru-RU", fingerprintTimezone: settings?.fingerprintTimezone ?? "Europe/Moscow", mobileProxyConfigured: Boolean(settings?.mobileProxyApiKey || process.env.MOBILEPROXY_API_KEY), warmupEnabled: settings?.warmupEnabled ?? true, warmupScheduleHours: settings?.warmupScheduleHours ?? "1".repeat(168), warmupScheduleTimezone: settings?.warmupScheduleTimezone ?? "Europe/Moscow", warmupConcurrency: settings?.warmupConcurrency ?? 1, warmupStageIntervalHours: (settings?.warmupStageIntervalMinutes ?? 720) / 60, warmupSites: resolveDonorSites(settings), warmupSitePauses: settings?.warmupSitePauses ?? [], maxPendingProfiles: settings?.maxPendingProfiles ?? 500, autoReplenishEnabled: settings?.autoReplenishEnabled ?? false, minReadyProfiles: settings?.minReadyProfiles ?? 100, replenishBatchSize: settings?.replenishBatchSize ?? 100, rucaptchaConfigured: Boolean(settings?.rucaptchaApiKey), openaiConfigured: stored || environment,
    warmupSharedProxy, openaiStored: stored, openaiSource: stored ? "database" : environment ? "environment" : "none" };
}

async function GETHandler() {
  try {
    const settings = await prisma.settings.findUnique({ where: { id: 1 } });
    return json(publicSettings(settings));
  } catch (error) { return apiError(error); }
}

async function PATCHHandler(request: Request) {
  try {
    const body = await readBody(request);
    const { warmupStageIntervalHours, expectedUpdatedAt, ...rest } = settingsSchema.parse(body);
    const submittedSites = (body as { warmupSites?: string[] }).warmupSites;
    const warmupSitesDuplicatesRemoved = submittedSites && rest.warmupSites ? submittedSites.length - rest.warmupSites.length : undefined;
    const data = { ...rest, ...(warmupStageIntervalHours !== undefined ? { warmupStageIntervalMinutes: Math.round(warmupStageIntervalHours * 60) } : {}) };
    const settings = await prisma.$transaction(async tx => {
      await tx.$executeRaw`UPDATE "Settings" SET "id"="id" WHERE "id"=1`;
      const current = await tx.settings.findUnique({ where: { id: 1 } });
      if (expectedUpdatedAt !== undefined && (current?.updatedAt.toISOString() ?? null) !== expectedUpdatedAt) return null;
      const weightsChanged=data.fingerprintDeviceWeights!==undefined && DEVICE_CATALOG.templates.some(t=>resolveWeights(current?.fingerprintDeviceWeights)[t.id]!==data.fingerprintDeviceWeights![t.id]);
      const change={...data,...(weightsChanged?{fingerprintDistributionRevision:(current?.fingerprintDistributionRevision??1)+1}:{})};
      return tx.settings.upsert({ where: { id: 1 }, create: { id: 1, ...change }, update: change });
    });
    if (!settings) return json({ error: "Настройки изменились в другой вкладке. Обновите форму перед сохранением." }, 409);
    if (data.mobileProxyApiKey !== undefined) await prisma.workflowLease.deleteMany({ where: { key: "fingerprint-provider-cooldown" } });
    // Return only configuration status; the stored secret is never sent back.
    return json({ ...publicSettings(settings), ...(warmupSitesDuplicatesRemoved !== undefined ? { warmupSitesDuplicatesRemoved } : {}) });
  } catch (error) { return apiError(error); }
}

export const GET = withAuth(GETHandler);
export const PATCH = withAuth(PATCHHandler);
