export type ResourcePaths = { release: string; application: string; data: string; logs: string; database?: string | null; extraDirectories?: {key: string; path: string}[] };
export type ResourceUsage = {
  checkedAt: string;
  disk: { measuredAt: string; scanState: 'scanning' | 'idle' | 'error'; scanStartedAt: string | null; bytes: number | null; knownBytes: number; complete: boolean; breakdown: {key: string; label: string; bytes: number | null}[]; activeReleaseBytes: number | null; releaseCount: number | null; scope?: string[]; warning?: string | null; volume: {totalBytes: number; usedBytes: number; availableBytes: number} | null };
  processes: { measuredAt: string; available: boolean; count: number | null; browserCount: number | null; memoryBytes: number | null; memoryAccounting: 'pss' | 'rss' | null; cpuCores: number | null; cpuCapacity: number | null; serverMemory: {totalBytes: number; availableBytes: number} | null };
};
export function resourcePaths(root?: string, env?: NodeJS.ProcessEnv): ResourcePaths;
export function resourceMonitor(config?: ResourcePaths): (options?: {refresh?: boolean}) => Promise<ResourceUsage>;
