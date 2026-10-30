import { apiError, checkDeleteOrigin, json } from "@/lib/api";
import { deleteSession } from "@/lib/auth";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try { checkDeleteOrigin(request); await deleteSession(); return json({ ok: true }); }
  catch (error) { return apiError(error); }
}
