import { readFile } from "node:fs/promises";
import { prisma } from "@/lib/prisma";
import { taskLiveFiles } from "@/lib/task-live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = await prisma.task.findUnique({ where: { id }, select: { projectId: true } });
  if (!task?.projectId) return new Response(null, { status: 404 });
  const files = await taskLiveFiles(task.projectId, id);
  if (!files) return new Response(null, { status: 404 });
  try {
    const image = await readFile(files.screenshot);
    return new Response(new Uint8Array(image), { headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store, max-age=0", "X-Content-Type-Options": "nosniff" } });
  } catch { return new Response(null, { status: 404 }); }
}
