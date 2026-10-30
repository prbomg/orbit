import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { ProjectWorkspace } from "@/components/project-workspace";
export const dynamic = "force-dynamic";

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const project = await prisma.project.findUnique({ where: { id: (await params).id }, include: { _count: { select: { tasks: true, profileUses: true, profileHistory: true } } } });
  if (!project) notFound();
  return <>{project.archivedAt && <div className="panel mb-6 p-4 text-sm">Проект в архиве. История сохранена, запуск задач недоступен. Восстановить проект можно во вкладке «Архив» на странице проектов.</div>}<ProjectWorkspace initialProject={JSON.parse(JSON.stringify(project))} /></>;
}
