import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { LiveTaskView } from "@/components/live-task-view";

export const dynamic = "force-dynamic";

export default async function TaskLivePage({ params }: { params: Promise<{ id: string }> }) {
  const task = await prisma.task.findUnique({ where: { id: (await params).id }, select: { id: true, projectId: true, project: { select: { name: true, targetUrl: true } } } });
  if (!task?.projectId || !task.project) notFound();
  return <LiveTaskView taskId={task.id} projectId={task.projectId} projectName={task.project.name} targetUrl={task.project.targetUrl} />;
}
