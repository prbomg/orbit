import { prisma } from "@/lib/prisma";
import { apiError, json, readBody } from "@/lib/api";
import { settingsSchema } from "@/lib/api-validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function publicSettings(settings: { rucaptchaApiKey: string | null; openaiApiKey: string | null; autoReplenishEnabled: boolean; minReadyProfiles: number; replenishBatchSize: number } | null) {
  const stored = Boolean(settings?.openaiApiKey);
  const environment = Boolean(process.env.OPENAI_API_KEY?.trim());
  return { autoReplenishEnabled: settings?.autoReplenishEnabled ?? false, minReadyProfiles: settings?.minReadyProfiles ?? 100, replenishBatchSize: settings?.replenishBatchSize ?? 100, rucaptchaConfigured: Boolean(settings?.rucaptchaApiKey), openaiConfigured: stored || environment,
    openaiStored: stored, openaiSource: stored ? "database" : environment ? "environment" : "none" };
}

export async function GET() {
  try {
    const settings = await prisma.settings.findUnique({ where: { id: 1 } });
    return json(publicSettings(settings));
  } catch (error) { return apiError(error); }
}

export async function PATCH(request: Request) {
  try {
    const data = settingsSchema.parse(await readBody(request));
    const settings = await prisma.settings.upsert({ where: { id: 1 }, create: { id: 1, ...data }, update: data });
    // Return only configuration status; the stored secret is never sent back.
    return json(publicSettings(settings));
  } catch (error) { return apiError(error); }
}
