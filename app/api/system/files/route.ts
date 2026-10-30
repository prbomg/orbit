import { z } from "zod";
import { withAuth } from "@/lib/auth";
import { ApiError, apiError, json, readBody, checkDeleteOrigin as checkWriteOrigin } from "@/lib/api";
import { createProjectFiles, FileManagerError, UPLOAD_LIMIT } from "@/utils/projectFiles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const files = createProjectFiles();
const pathname = z.string().min(1).max(2000);
const revision = z.string().regex(/^[0-9a-f]{64}$/);
const page = z.coerce.number().int().min(0).max(1000000);
function failure(error: unknown) {
  return error instanceof FileManagerError ? json({ error: error.message }, error.status) : apiError(error);
}
async function GETHandler(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const relative = params.get("path") || "";
    switch (params.get("action") || "list") {
      case "list": return json(await files.list({ path: relative, query: (params.get("q") || "").slice(0, 255), offset: page.parse(params.get("offset") || 0) }));
      case "read": return json(await files.read(pathname.parse(relative)));
      case "stat": return json(await files.stat(pathname.parse(relative)));
      case "history": return json(await files.history({ offset: page.parse(params.get("offset") || 0) }));
      case "archive":
      case "download": {
        const archive = params.get("action") === "archive";
        const file = archive ? await files.archive(relative, { signal: request.signal }) : await files.download(pathname.parse(relative));
        const name = encodeURIComponent(file.name).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16)}`);
        return new Response(file.stream, { headers: {
          "Content-Type": archive ? "application/zip" : "application/octet-stream",
          "Content-Disposition": `attachment; filename="${archive ? "folder.zip" : "download"}"; filename*=UTF-8''${name}`,
          "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
          "X-Accel-Buffering": "no",
          "Content-Security-Policy": "sandbox",
        } });
      }
      default: throw new ApiError(400, "Неизвестная файловая операция");
    }
  } catch (error) { return failure(error); }
}
async function PATCHHandler(request: Request) {
  try {
    const body = z.object({ path: pathname, revision, content: z.string().max(524288) }).strict().parse(await readBody(request));
    return json(await files.save(body.path, body.revision, body.content));
  } catch (error) { return failure(error); }
}
async function DELETEHandler(request: Request) {
  try {
    const body = z.object({ path: pathname, revision }).strict().parse(await readBody(request));
    return json(await files.remove(body.path, body.revision));
  } catch (error) { return failure(error); }
}
async function POSTHandler(request: Request) {
  try {
    const body = z.discriminatedUnion("action", [
      z.object({ action: z.literal("restore"), id: z.string().uuid(), revision: revision.nullable() }).strict(),
      z.object({ action: z.literal("purge"), id: z.string().uuid() }).strict(),
    ]).parse(await readBody(request));
    return json(body.action === "restore" ? await files.restore(body.id, body.revision) : await files.purge(body.id));
  } catch (error) { return failure(error); }
}
async function PUTHandler(request: Request) {
  try {
    checkWriteOrigin(request);
    const params = new URL(request.url).searchParams;
    const path = pathname.parse(params.get("path"));
    const expected = revision.nullable().parse(params.get("revision"));
    const length = request.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > UPLOAD_LIMIT)) {
      throw new ApiError(413, "Файл больше 20 МиБ");
    }
    if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/octet-stream") {
      throw new ApiError(415, "Ожидается двоичный поток файла");
    }
    const stream = request.body || new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
    return json(await files.upload(path, expected, stream, { signal: request.signal }));
  } catch (error) { return failure(error); }
}
export const GET = withAuth(GETHandler);
export const PATCH = withAuth(PATCHHandler);
export const DELETE = withAuth(DELETEHandler);
export const POST = withAuth(POSTHandler);
export const PUT = withAuth(PUTHandler);
