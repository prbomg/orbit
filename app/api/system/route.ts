import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { json } from "@/lib/api";
import { projectRunStatus } from "@/lib/project-runner";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  let workerState = "unknown";
  let projectRun: ReturnType<typeof projectRunStatus> | null = null;
  try {
    const filename = decodeURIComponent((process.env.DATABASE_URL ?? "").slice(5).split("?")[0]);
    if (!process.env.DATABASE_URL?.startsWith("file:") || !filename) throw new Error("Unknown database");
    const databasePath = isAbsolute(filename) ? filename : resolve(process.cwd(), "prisma", filename);
    const lock = JSON.parse(await readFile(`${databasePath}.worker.lock`, "utf8"));
    if (!Number.isSafeInteger(lock.pid) || lock.pid < 1) throw new Error("Invalid lock");
    try { process.kill(lock.pid, 0); workerState = "running"; if (typeof lock.projectId === "string" && lock.projectId) projectRun = projectRunStatus(lock.projectId); }
    catch (error) { workerState = (error as NodeJS.ErrnoException).code === "ESRCH" ? "stale" : "unknown"; }
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") workerState = "stopped"; }
  return json({ workerState, projectRun, checkedAt: new Date().toISOString(),
    headless: process.env.WORKER_HEADLESS !== "0", proxyScheme: process.env.WORKER_PROXY_SCHEME ?? "http", planMode: process.env.WORKER_PLAN_MODE === "openai" ? "openai" : "local",
    directVisitSeconds: [Number(process.env.WORKER_MIN_DWELL_MS ?? 60000) / 1000, Number(process.env.WORKER_MAX_DWELL_MS ?? 120000) / 1000],
    searchVisitSeconds: [60, 300], rotationWaitSeconds: 15, mobileDevices: ["Android", "iOS"],
    captchaProvider: (process.env.WORKER_CAPTCHA_BASE_URL ?? "https://rucaptcha.com").startsWith("https://2captcha.com") ? "2Captcha" : "RuCaptcha",
  });
}
