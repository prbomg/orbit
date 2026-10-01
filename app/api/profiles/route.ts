import { profileSession } from "@/lib/profile-session";
import { prisma } from "@/lib/prisma";
import { apiError, json, readBody } from "@/lib/api";
import { createProfileSchema } from "@/lib/api-validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const profiles = await prisma.profile.findMany({ orderBy: { createdAt: "desc" } });
    return json(await Promise.all(profiles.map(async profile => ({ ...profile, session: await profileSession(profile.id) }))));
  }
  catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  try { return json(await prisma.profile.create({ data: createProfileSchema.parse(await readBody(request)) }), 201); }
  catch (error) { return apiError(error); }
}
