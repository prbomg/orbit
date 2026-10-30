import { withAuth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { apiError, json } from "@/lib/api";
import { getBalance } from "@/utils/capguruApi";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = withAuth(async (request: Request) => {
  try {
    const settings = await prisma.settings.findUnique({where: {id: 1}, select: {capguruApiKey: true}});
    const key = settings?.capguruApiKey?.trim() || null;
    return json({key, capguruConfigured: Boolean(key), ...await getBalance(key, {refresh: new URL(request.url).searchParams.get("refresh") === "1"})});
  } catch (error) { return apiError(error); }
});
