import { withAuth } from "@/lib/auth";
import { ApiError, apiError, json } from "@/lib/api";
import { resourceMonitor } from "@/utils/serviceResources";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const usage = resourceMonitor();
async function GETHandler(request: Request) {
  try { return json(await usage({ refresh: new URL(request.url).searchParams.get("refresh") === "1" })); }
  catch { return apiError(new ApiError(503, "Не удалось получить сведения о ресурсах сервиса")); }
}
export const GET = withAuth(GETHandler);
