import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";
import { ApiError, apiError } from "@/lib/api";

export const sessionCookie = "orbit_session";
export const sessionSeconds = 12 * 60 * 60;
export const rememberedSessionSeconds = 30 * 24 * 60 * 60;
export const allowedEmail = () => (process.env.AUTH_EMAIL || "seo@uniofweb.ru").trim().toLowerCase();
const digest = (token: string) => createHash("sha256").update(token).digest("hex");
export function cookieOptions() {
  const origin = new URL(process.env.APP_ORIGIN || "http://127.0.0.1:3000");
  if (process.env.NODE_ENV === "production" && !process.env.APP_ORIGIN) throw new Error("APP_ORIGIN is required");
  return { httpOnly: true, secure: origin.protocol === "https:", sameSite: "lax" as const, path: "/" };
}
export async function getSession() {
  const token = (await cookies()).get(sessionCookie)?.value;
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const session = await prisma.authSession.findUnique({ where: { tokenHash: digest(token) }, include: { user: { select: { email: true } } } });
  if (!session || session.expiresAt.getTime() <= Date.now() || session.user.email !== allowedEmail()) return null;
  return { email: session.user.email };
}
export async function createSession(userId: string, rememberMe = false) {
  const jar = await cookies();
  const token = randomBytes(32).toString("hex");
  const options = cookieOptions();
  const lifetime = rememberMe ? rememberedSessionSeconds : sessionSeconds;
  await deleteSession();
  await prisma.authSession.deleteMany({ where: { expiresAt: { lte: new Date() } } });
  await prisma.authSession.create({ data: { tokenHash: digest(token), userId, expiresAt: new Date(Date.now() + lifetime * 1000) } });
  jar.set(sessionCookie, token, { ...options, ...(rememberMe ? { maxAge: lifetime } : {}) });
}
export async function deleteSession() {
  const jar = await cookies();
  const token = jar.get(sessionCookie)?.value;
  if (token && /^[a-f0-9]{64}$/.test(token)) await prisma.authSession.deleteMany({ where: { tokenHash: digest(token) } });
  jar.set(sessionCookie, "", { ...cookieOptions(), maxAge: 0 });
}
export async function checkLoginLimit() {
  const now = BigInt(Date.now());
  const resetAt = now + BigInt(15 * 60 * 1000);
  // One shared counter survives restarts and cannot be bypassed with spoofed IP headers.
  await prisma.$executeRaw`INSERT INTO "AuthThrottle" ("id", "attempts", "resetAt") VALUES ('login', 1, ${resetAt})
    ON CONFLICT("id") DO UPDATE SET
      "attempts" = CASE WHEN "resetAt" <= ${now} THEN 1 ELSE "attempts" + 1 END,
      "resetAt" = CASE WHEN "resetAt" <= ${now} THEN ${resetAt} ELSE "resetAt" END`;
  const state = await prisma.authThrottle.findUniqueOrThrow({ where: { id: "login" } });
  if (state.attempts > 20) throw new ApiError(429, "Слишком много попыток. Повторите вход через 15 минут.");
}
export function withAuth<Args extends unknown[]>(handler: (...args: Args) => Promise<Response>) {
  return async (...args: Args): Promise<Response> => {
    try {
      if (!await getSession()) throw new ApiError(401, "Войдите в аккаунт");
      return await handler(...args);
    } catch (error) { return apiError(error); }
  };
}
