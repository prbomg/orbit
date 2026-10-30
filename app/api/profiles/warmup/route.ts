import { withAuth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { apiError, json, readBody } from "@/lib/api";
import { warmupBatchSchema } from "@/lib/api-validation";
import { queueWarmups } from "@/utils/profilePool";
export const runtime = "nodejs";
async function POSTHandler(request: Request) {
  try { const data = warmupBatchSchema.parse(await readBody(request)); return json(await prisma.$transaction(tx => queueWarmups(tx, data), { timeout: 15000 }), 201); }
  catch (error) { return apiError(error); }
}

export const POST = withAuth(POSTHandler);
