import type { ResourcePaths } from './serviceResources';
export type ReleaseInfo = { id: string; revision: string; savedAt: string; dateSource: 'created' | 'modified'; bytes: number | null; protected: boolean; reasons: ('current' | 'in_use' | 'unsafe' | 'preparing' | 'storage')[] };
export type DeletionJob = { id: string; status: 'deleting' | 'failed' | 'completed'; createdAt: string; completedAt: string | null; total: number; done: number; releases: string[]; error: string | null };
export type ReleaseList = { checkedAt: string; releases: ReleaseInfo[]; sizesPending: boolean; deletions: DeletionJob[] };
export class ReleaseError extends Error { code: string; status: number; }
export function createReleaseManager(config?: ResourcePaths): { list(): Promise<ReleaseList>; deleteSelected(selected: {id: string; revision: string}[]): Promise<DeletionJob>; retry(id: string): Promise<DeletionJob>; waitForCleanup(): Promise<void> };
export function withReleaseOperation<T>(application: string, action: () => Promise<T>): Promise<T>;
