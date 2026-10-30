import { withAuth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { apiError, json, readBody } from "@/lib/api";
import { projectSchema } from "@/lib/api-validation";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function GETHandler(request: Request) {
  try {
    const projects = await prisma.project.findMany({ where: new URL(request.url).searchParams.get("archived") === "1" ? { archivedAt: { not: null } } : { archivedAt: null }, orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }, { id: "asc" }], include: { _count: { select: { tasks: true, profileUses: true } } } });
    return json(projects);
  } catch (error) { return apiError(error); }
}
async function POSTHandler(request: Request) {
  try {
    const data = projectSchema.parse(await readBody(request));
    const geolocation = !data.geolocation || data.geolocation.mode === 'region'
      ? { mode: 'region', radiusKm: 5, ...data.geolocation }
      : data.geolocation;
    return json(await prisma.project.create({ data: { regionName: "", ...data, geolocation } }), 201);
  }
  catch (error) { return apiError(error); }
}

export const GET = withAuth(GETHandler);
export const POST = withAuth(POSTHandler);
