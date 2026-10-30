export type RunRecord = { nextCheckAt?: string | null; nextAt?: string | null; waitReason?: string | null; projectId: string; runId: string; pid: number; startedAt: string; updatedAt: string; event: string; visible?: boolean; taskId?: string; errorType?: string | null; errorCode?: string | null; providerCode?: string | null };
export function safeProjectId(id: unknown): id is string;
export function projectPaths(runtime: string, projectId: string): {directory: string; record: string; log: string; guard: string};
export function workerLockPath(databasePath: string, projectId?: string | null): string;
export function readJson(path: string): {pid: number; projectId?: string; runId?: string} | null;
export function readProjectRecord(runtime: string, projectId: string): RunRecord | null;
export function projectIds(runtime: string, databasePath: string): string[];
