import { prisma } from "@/lib/prisma";
import { apiError, json, readBody } from "@/lib/api";
import { profileBatchSchema } from "@/lib/api-validation";
import { createProfileBatch } from "@/utils/profilePool";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try { const data = profileBatchSchema.parse(await readBody(request)); return json(await prisma.$transaction(tx => createProfileBatch(tx, data), { timeout: 15000 }), 201); }
  catch (error) { return apiError(error); }
}
