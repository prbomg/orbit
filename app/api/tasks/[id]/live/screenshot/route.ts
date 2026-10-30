import { withAuth } from "@/lib/auth";
import { readFile } from "node:fs/promises";
import { prisma } from "@/lib/prisma";
import { taskLiveFiles, screenshotVersion } from "@/lib/task-live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function GETHandler(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = await prisma.task.findUnique({ where: { id }, select: { projectId: true } });
  if (!task?.projectId) return new Response(null, { status: 404 });
  const requested = new URL(request.url).searchParams.get("executionId");
  const execution = requested ? await prisma.taskExecution.findFirst({where:{id:requested,taskId:id},select:{id:true,startedAt:true}}) : await prisma.taskExecution.findFirst({where:{taskId:id},orderBy:{startedAt:'desc'},select:{id:true,startedAt:true}});
  if(requested&&!execution)return new Response(null,{status:404});
  const selected=execution?.id;
  const files = await taskLiveFiles(task.projectId, id, selected);
  if (!files) return new Response(null, { status: 404 });
  const imagePath = new URL(request.url).searchParams.get("kind") === "failure" ? files.screenshot.replace(/\.jpg$/, ".failure.jpg") : files.screenshot;
  if(execution?.startedAt){const version=await screenshotVersion(imagePath);if(version===null||version<execution.startedAt.getTime())return new Response(null,{status:404});}
  try {
    const image = await readFile(imagePath);
    return new Response(new Uint8Array(image), { headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store, max-age=0", "X-Content-Type-Options": "nosniff" } });
  } catch { return new Response(null, { status: 404 }); }
}

export const GET = withAuth(GETHandler);
