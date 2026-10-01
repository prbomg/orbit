import { PoolError } from "@/utils/profilePool";
import { Prisma } from "@prisma/client";
import { z } from "zod";

export const proxySelect = {
  id: true, host: true, port: true, username: true, isActive: true, rotationUrl: true,
} satisfies Prisma.ProxySelect;

export function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function checkOrigin(request: Request) {
  const origin = request.headers.get("origin");
  // Next.js may use an internal hostname in request.url. Host reflects the
  // browser-facing authority, including its port.
  const host = request.headers.get("host") ?? new URL(request.url).host;
  const protocol = request.headers.get("x-forwarded-proto") ?? new URL(request.url).protocol.replace(":", "");
  if ((origin && origin !== `${protocol}://${host}`) || request.headers.get("sec-fetch-site") === "cross-site") {
    throw new ApiError(403, "Запрос из другого источника запрещён");
  }
}

export async function readBody(request: Request): Promise<unknown> {
  // Reject cross-origin browser writes while allowing CLI / server clients.
  checkOrigin(request);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new ApiError(415, "Нужен Content-Type: application/json");
  const text = await request.text();
  if (text.length > 1_000_000) throw new ApiError(413, "Запрос слишком большой");
  try { return JSON.parse(text); } catch { throw new ApiError(400, "Некорректный JSON"); }
}

export function checkDeleteOrigin(request: Request) {
  checkOrigin(request);
}

export function apiError(error: unknown): Response {
  if (error instanceof PoolError) return json({ error: error.message, code: error.code, available: error.available }, error.code === "project_missing" ? 404 : 409);
  if (error instanceof ApiError) return json({ error: error.message }, error.status);
  if (error instanceof z.ZodError) return json({
    error: "Проверьте поля запроса",
    details: error.issues.map(issue => ({ field: issue.path.join("."), message: issue.message })),
  }, 400);
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2025") return json({ error: "Запись не найдена" }, 404);
    if (error.code === "P2002") return json({ error: "Такой прокси уже существует (host, port, username)" }, 409);
  }
  // Never expose Prisma diagnostics, SQL, credentials or filesystem paths.
  console.error("Database request failed", error instanceof Prisma.PrismaClientKnownRequestError ? error.code : "INTERNAL");
  return json({ error: "Не удалось выполнить запрос к базе данных" }, 500);
}
