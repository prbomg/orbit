import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { ProjectWorkspace } from "@/components/project-workspace";
export const dynamic = "force-dynamic";

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const project = await prisma.project.findUnique({ where: { id: (await params).id }, include: { _count: { select: { tasks: true, profileUses: true, profileHistory: true } }, profileHistory: { orderBy: { executedAt: "desc" }, take: 100, include: { profile: { select: { id: true, name: true } } } } } });
  if (!project) notFound();
  return <ProjectWorkspace initialProject={JSON.parse(JSON.stringify(project))} />;
}
