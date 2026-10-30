import { withAuth } from "@/lib/auth";
import { json } from "@/lib/api";
import { workerSystemStatus } from "@/lib/project-runner";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function GETHandler() {
  let status: ReturnType<typeof workerSystemStatus> = { workerState: 'unknown', projectRuns: [], activeProjectCount: 0, projectRun: null };
  try { status = workerSystemStatus(); } catch { /* Keep the status unknown if runtime state is unreadable. */ }
  return json({ ...status, checkedAt: new Date().toISOString(),
    headless: process.env.WORKER_HEADLESS !== "0", proxyScheme: process.env.WORKER_PROXY_SCHEME ?? "http", planMode: process.env.WORKER_PLAN_MODE === "openai" ? "openai" : "local",
    directVisitSeconds: [Number(process.env.WORKER_MIN_DWELL_MS ?? 60000) / 1000, Number(process.env.WORKER_MAX_DWELL_MS ?? 120000) / 1000],
    searchVisitSeconds: [60, 300], rotationWaitSeconds: 15, mobileDevices: ["Android", "iOS"],
    captchaProvider: (process.env.WORKER_CAPTCHA_BASE_URL ?? "https://rucaptcha.com").startsWith("https://2captcha.com") ? "2Captcha" : "RuCaptcha",
  });
}

export const GET = withAuth(GETHandler);
