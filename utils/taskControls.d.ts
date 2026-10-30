export type TaskCommand = 'start' | 'pause' | 'restart';
export function controlTask(id: string, action: TaskCommand, options?: {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  now?: () => number;
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  stopTimeoutMs?: number;
}): Promise<{ status: string; currentExecutions: number; targetExecutions: number }>;
