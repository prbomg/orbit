import { prisma } from "@/lib/prisma";
import { apiError, json, readBody } from "@/lib/api";
import { updateProfileSchema } from "@/lib/api-validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Context) {
  try {
    const data = updateProfileSchema.parse(await readBody(request));
    return json(await prisma.profile.update({ where: { id: (await params).id }, data }));
  } catch (error) { return apiError(error); }
}
