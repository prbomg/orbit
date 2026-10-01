import "server-only";
import { open, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { projectRunStatus } from "@/lib/project-runner";

const runtime = resolve(process.cwd(), ".orbit-runtime");
const safeId = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);

type RecordData = { projectId?: string; runId?: string; taskId?: string };
export async function taskLiveFiles(projectId: string, taskId: string) {
  if (!safeId(taskId)) return null;
  let record: RecordData;
  try { record = JSON.parse(await readFile(resolve(runtime, "project-worker.json"), "utf8")); }
  catch { return null; }
  if (record.projectId !== projectId || !safeId(record.runId)) return null;
  const dir = resolve(runtime, "live", record.runId);
  return { record, events: resolve(dir, `${taskId}.jsonl`), screenshot: resolve(dir, `${taskId}.jpg`) };
}

export async function readLiveEvents(path: string) {
  let file;
  try {
    file = await open(path, "r");
    const { size } = await file.stat();
    const length = Math.min(size, 256_000);
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, size - length);
    const content = buffer.toString("utf8");
    const complete = size > length ? content.slice(content.indexOf("\n") + 1) : content;
    return complete.split("\n").filter(Boolean).slice(-120).flatMap(line => {
      try { return [JSON.parse(line) as { time: string; event: string; url?: string; tab?: number; status?: number }]; }
      catch { return []; }
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  } finally { await file?.close(); }
}

export async function screenshotVersion(path: string) {
  try { return (await stat(path)).mtimeMs; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

export function taskLiveStatus(projectId: string, taskId: string) {
  const run = projectRunStatus(projectId);
  return { state: run.state, active: run.taskId === taskId && run.state === "running" && ["session_started", "search_started", "search_target_clicked"].includes("event" in run ? run.event : ""), currentTaskId: run.taskId ?? null, updatedAt: "updatedAt" in run ? run.updatedAt : null };
}
