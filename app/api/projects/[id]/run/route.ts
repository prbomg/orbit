import { withAuth } from "@/lib/auth";
import { z } from "zod";
import { apiError, json, readBody } from "@/lib/api";
import { projectRunStatus, startProjectRun, stopProjectRun } from "@/lib/project-runner";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start"), visible: z.boolean().optional() }).strict(),
  z.object({ action: z.literal("stop") }).strict(),
]);
async function GETHandler(_request: Request, { params }: Context) {
  try { return json(projectRunStatus((await params).id)); } catch (error) { return apiError(error); }
}
async function POSTHandler(request: Request, { params }: Context) {
  try {
    const command = actionSchema.parse(await readBody(request));
    const id = (await params).id;
    return json(command.action === "start" ? await startProjectRun(id, { visible: command.visible }) : stopProjectRun(id));
  } catch (error) { return apiError(error); }
}

export const GET = withAuth(GETHandler);
export const POST = withAuth(POSTHandler);
