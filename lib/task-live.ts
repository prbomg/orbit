import "server-only";
import { readEventPage } from "@/utils/liveHistory";
import proxyNetwork from "@/utils/proxyNetwork";
import { readProjectRecord } from "@/utils/workerRuntime";
import { liveSocketPath } from "@/utils/liveSocket";
import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { projectRunStatus } from "@/lib/project-runner";

const runtime = resolve(process.env.ORBIT_LIVE_RUNTIME_DIRECTORY || resolve(process.cwd(), ".orbit-runtime"));
const safeId = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);

type RecordData = { projectId?: string; runId?: string; taskId?: string };
const fileCache = new Map<string,{runId:string|null;expires:number}>();
export async function taskLiveFiles(projectId: string, taskId: string, executionId?: string | null) {
  if (!safeId(projectId)||!safeId(taskId)||(executionId&&!safeId(executionId))) return null;
  const key=executionId||taskId, cacheKey=`${projectId}:${taskId}:${key}`, root=resolve(runtime,'live');
  const files=(runId:string)=>({record:{projectId,taskId,runId},socket:liveSocketPath(runtime,runId,key),events:resolve(root,runId,`${key}.jsonl`),network:resolve(root,runId,`${key}.network.json`),screenshot:resolve(root,runId,`${key}.jpg`)});
  const age=async(runId:string)=>{let time:number|null=null;const f=files(runId);for(const path of [f.events,f.network,f.screenshot])try{const info=await lstat(path);if(info.isFile())time=Math.max(time??0,info.mtimeMs);}catch{}return time;};
  let current:RecordData|null=null;try{current=readProjectRecord(runtime,projectId);}catch{}
  if(current?.projectId===projectId&&safeId(current.runId)){
    const found=files(current.runId);if(await age(current.runId)!==null)return found;
    // A live execution may not have written its first event yet.
    if(!executionId)return found;
  }
  const cached=fileCache.get(cacheKey);if(cached&&cached.expires>Date.now())return cached.runId?files(cached.runId):null;
  let latest:{runId:string;time:number}|null=null;
  try{for(const dir of await readdir(root,{withFileTypes:true})){if(!dir.isDirectory()||!safeId(dir.name))continue;const time=await age(dir.name);if(time!==null&&(!latest||time>latest.time))latest={runId:dir.name,time};}}catch{}
  fileCache.set(cacheKey,{runId:latest?.runId||null,expires:Date.now()+(latest?30000:5000)});if(fileCache.size>256)fileCache.delete(fileCache.keys().next().value!);
  return latest?files(latest.runId):null;
}

// Display-only cutoff: TaskExecution rows, counters and log files stay intact.
// Removing this runtime file restores the complete attempt picker history.
export async function taskAttemptListCutoff(): Promise<Date | null> {
  let text: string;
  try { text = await readFile(resolve(runtime, 'task-attempt-list.json'), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  const value = JSON.parse(text);
  const time = typeof value?.visibleSince === 'string' ? Date.parse(value.visibleSince) : NaN;
  if (value?.version !== 1 || !Number.isFinite(time)) throw new Error('Invalid attempt list visibility configuration');
  return new Date(time);
}

export async function readLiveNetwork(path: string, executionId: string | null) {
  try {
    if ((await stat(path)).size > 8192) return null;
    const value = proxyNetwork.networkSnapshot(JSON.parse(await readFile(path, "utf8")));
    return value && (!executionId || value.executionId === executionId) ? value : null;
  } catch { return null; }
}

export async function readLiveEvents(path:string) {return (await readEventPage(path)).events;}

export async function screenshotVersion(path: string) {
  try { return (await stat(path)).mtimeMs; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

export function taskLiveStatus(projectId: string, taskId: string) {
  const run = projectRunStatus(projectId);
  return { state: run.state, active: run.taskId === taskId && run.state === "running" && ["session_started", "search_started", "search_target_clicked"].includes("event" in run ? run.event : ""), currentTaskId: run.taskId ?? null, updatedAt: "updatedAt" in run ? run.updatedAt : null, nextCheckAt: "nextCheckAt" in run ? run.nextCheckAt : null, nextAt: "nextAt" in run ? run.nextAt : null, waitReason: "waitReason" in run ? run.waitReason : null };
}
