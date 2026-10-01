import "server-only";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { ApiError } from "@/lib/api";
import { prisma } from "@/lib/prisma";

type RunRecord = { projectId: string; runId: string; pid: number; startedAt: string; updatedAt: string; event: string; visible?: boolean; taskId?: string; errorType?: string | null; errorCode?: string | null; providerCode?: string | null };
const root = process.cwd();
const runtimeDir = resolve(root, ".orbit-runtime");
const recordPath = resolve(runtimeDir, "project-worker.json");
const guardPath = resolve(runtimeDir, "manager-guard");
const dbUrl = process.env.DATABASE_URL ?? "";
const dbFile = dbUrl.startsWith("file:") ? decodeURIComponent(dbUrl.slice(5).split("?")[0]) : "";
const dbPath = dbFile ? isAbsolute(dbFile) ? dbFile : resolve(root, "prisma", dbFile) : "";

function alive(pid: number) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
function readRecord(): RunRecord | null {
  try { return JSON.parse(readFileSync(recordPath, "utf8")) as RunRecord; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw new ApiError(500, "Состояние исполнителя недоступно"); }
}
function writeRecord(value: RunRecord) {
  const temp = `${recordPath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  renameSync(temp, recordPath);
}
function readDbLock(): { pid: number; projectId?: string; runId?: string } | null {
  if (!dbPath) throw new ApiError(503, "DATABASE_URL не настроен");
  try { return JSON.parse(readFileSync(`${dbPath}.worker.lock`, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw new ApiError(503, "Не удалось прочитать блокировку воркера"); }
}
function withGuard<T>(action: () => T): T {
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  try { mkdirSync(guardPath, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    try { if (Date.now() - statSync(guardPath).mtimeMs > 30_000) { rmSync(guardPath, { recursive: true }); mkdirSync(guardPath, { mode: 0o700 }); } else throw new ApiError(409, "Управление исполнителем уже выполняется. Повторите запрос."); }
    catch (cause) { if (cause instanceof ApiError) throw cause; throw new ApiError(409, "Управление исполнителем уже выполняется. Повторите запрос."); }
  }
  try { return action(); } finally { rmSync(guardPath, { recursive: true, force: true }); }
}
export function projectRunStatus(projectId: string) {
  const record = readRecord();
  const lock = readDbLock();
  const lockLive = lock && alive(lock.pid);
  const starting = record?.event === "starting" && Date.now() - Date.parse(record.startedAt) < 30_000 && alive(record.pid);
  if (record?.projectId !== projectId) return { state: lockLive || starting ? "busy" : "stopped", projectId: record?.projectId ?? lock?.projectId ?? null };
  const running = Boolean(lockLive && lock?.pid === record.pid && lock?.runId === record.runId && lock?.projectId === projectId) || Boolean(starting);
  const state = running ? record.event === "stopping" ? "stopping" : record.event === "waiting" ? "waiting" : "running" : record.event === "project_finished" ? "completed" : record.event === "worker_stopped" || record.event === "stopping" ? "stopped" : "failed";
  return { state, projectId, taskId: record.taskId ?? null, event: record.event, visible: record.visible ?? false, errorType: record.errorType ?? null, errorCode: record.errorCode ?? null, providerCode: record.providerCode ?? null, startedAt: record.startedAt, updatedAt: record.updatedAt };
}
export async function startProjectRun(projectId: string, { visible = false }: { visible?: boolean } = {}) {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { targetUrl: true, tasks: { where: { status: "running", profile: { isEnabled: true, status: { not: "banned" } } }, select: { taskType: true, url: true, searchEngine: true, currentExecutions: true, targetExecutions: true } } } });
  if (!project) throw new ApiError(404, "Проект не найден");
  const tasks = project.tasks.filter(task => task.currentExecutions < task.targetExecutions);
  if (!tasks.length) throw new ApiError(409, "Нет задач в очереди. Создайте задачу или возобновите приостановленную.");
  const host = new URL(project.targetUrl).hostname;
  for (const task of tasks) {
    if (task.taskType !== "target" || (task.searchEngine && task.searchEngine !== "yandex") ||
        (!task.searchEngine && !(new URL(task.url).hostname === host || new URL(task.url).hostname.endsWith(`.${host}`)))) {
      throw new ApiError(409, "Для запуска из панели поддерживаются Яндекс и страницы домена проекта. Исправьте задачи в очереди.");
    }
  }
  if (!(await prisma.proxy.count({ where: { isActive: true } }))) throw new ApiError(409, "Нет включённых прокси. Добавьте прокси на странице «Прокси».");
  if (process.env.WORKER_PLAN_MODE === "openai" && tasks.some(task => !task.searchEngine)) {
    const settings = await prisma.settings.findUnique({ where: { id: 1 }, select: { openaiApiKey: true } });
    if (!settings?.openaiApiKey && !process.env.OPENAI_API_KEY) throw new ApiError(409, "Для прямого сценария нужен ключ OpenAI в настройках.");
  }
  return withGuard(() => {
    const lock = readDbLock(); const record = readRecord();
    const starting = record?.event === "starting" && Date.now() - Date.parse(record.startedAt) < 30_000 && alive(record.pid);
    if ((lock && alive(lock.pid)) || starting) throw new ApiError(409, "Исполнитель уже запущен. Остановите текущий проект перед новым запуском.");
    const runId = randomUUID();
    const logFd = openSync(resolve(runtimeDir, "project-worker.log"), "a", 0o600);
    let child;
    try {
      child = spawn(process.execPath, [resolve(root, "worker/index.js"), `--project=${projectId}`], {
        cwd: root, env: { ...process.env, ORBIT_WORKER_RUN_ID: runId, ...(visible ? { WORKER_HEADLESS: "0" } : {}) }, detached: true, stdio: ["ignore", logFd, logFd],
      });
    } finally { closeSync(logFd); }
    if (!child.pid) throw new ApiError(500, "Не удалось запустить процесс исполнителя");
    const now = new Date().toISOString();
    writeRecord({ projectId, runId, pid: child.pid, startedAt: now, updatedAt: now, event: "starting", visible });
    child.unref();
    return projectRunStatus(projectId);
  });
}
export function stopProjectRun(projectId: string) {
  return withGuard(() => {
    const record = readRecord();
    if (!record || record.projectId !== projectId) throw new ApiError(409, "Этот проект сейчас не выполняется");
    if (!alive(record.pid)) return projectRunStatus(projectId);
    const lock = readDbLock();
    if (!lock || lock.pid !== record.pid || lock.runId !== record.runId || lock.projectId !== projectId) throw new ApiError(409, "Процесс ещё запускается или уже завершился. Обновите состояние и повторите.");
    process.kill(record.pid, "SIGTERM");
    writeRecord({ ...record, event: "stopping", updatedAt: new Date().toISOString() });
    return projectRunStatus(projectId);
  });
}
