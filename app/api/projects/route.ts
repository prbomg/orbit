import { prisma } from "@/lib/prisma";
import { apiError, json, readBody } from "@/lib/api";
import { projectSchema } from "@/lib/api-validation";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    const projects = await prisma.project.findMany({ orderBy: { createdAt: "desc" }, include: { _count: { select: { tasks: true, profileUses: true } } } });
    return json(projects);
  } catch (error) { return apiError(error); }
}
export async function POST(request: Request) {
  try { return json(await prisma.project.create({ data: { regionName: "", ...projectSchema.parse(await readBody(request)) } }), 201); }
  catch (error) { return apiError(error); }
}
