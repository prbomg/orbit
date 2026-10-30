import { z } from "zod";
import { withAuth } from "@/lib/auth";
import { apiError, json, readBody } from "@/lib/api";
import { createReleaseManager, ReleaseError } from "@/utils/releaseManager";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const manager = createReleaseManager();
const selection = z.object({ releases: z.array(z.object({ id: z.string().min(1).max(128), revision: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1).max(100) }).strict();
function failure(error: unknown) { return error instanceof ReleaseError ? json({ error: error.message, code: error.code }, error.status) : apiError(error); }
async function GETHandler() { try { return json(await manager.list()); } catch (error) { return failure(error); } }
async function DELETEHandler(request: Request) { try { const body = selection.parse(await readBody(request)); return json(await manager.deleteSelected(body.releases), 202); } catch (error) { return failure(error); } }
async function POSTHandler(request: Request) { try { const body = z.object({ action: z.literal('retry'), jobId: z.string() }).strict().parse(await readBody(request)); return json(await manager.retry(body.jobId), 202); } catch (error) { return failure(error); } }
export const GET = withAuth(GETHandler);
export const DELETE = withAuth(DELETEHandler);
export const POST = withAuth(POSTHandler);
