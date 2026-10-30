import { withAuth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { apiError, json } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withAuth(async () => {
  try {
    const settings = await prisma.settings.findUnique({ where: { id: 1 }, select: { mobileProxyApiKey: true } });
    const stored = settings?.mobileProxyApiKey?.trim();
    const environment = process.env.MOBILEPROXY_API_KEY?.trim();
    return json({ key: stored || environment || null, source: stored ? "database" : environment ? "environment" : "none" });
  } catch (error) { return apiError(error); }
});
