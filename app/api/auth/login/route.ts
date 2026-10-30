import { z } from "zod";
import { apiError, ApiError, json, readBody } from "@/lib/api";
import { allowedEmail, checkLoginLimit, createSession } from "@/lib/auth";
import { verifyPassword } from "@/lib/password.mjs";
import { prisma } from "@/lib/prisma";
export const runtime = "nodejs";
const credentials = z.object({ email: z.string().trim().email().max(254), password: z.string().min(1).max(256), rememberMe: z.boolean().default(false) });
export async function POST(request: Request) {
  try {
    const body = credentials.parse(await readBody(request));
    await checkLoginLimit();
    const email = body.email.toLowerCase();
    const user = email === allowedEmail() ? await prisma.authUser.findUnique({ where: { email } }) : null;
    const valid = await verifyPassword(body.password, user?.passwordHash);
    if (!user || !valid) throw new ApiError(401, "Неверная почта или пароль");
    await createSession(user.id, body.rememberMe);
    await prisma.authThrottle.deleteMany({ where: { id: "login" } });
    return json({ ok: true });
  } catch (error) { return apiError(error); }
}
