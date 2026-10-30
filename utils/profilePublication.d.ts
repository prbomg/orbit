export class PublicationError extends Error { code: string; constructor(code?: string); }
export function hasPendingPublication(directory: string, profileId: string): Promise<boolean>;
export function pendingPublications(directory: string): Promise<string[]>;
export function publishProfileFiles(options: { directory: string; profileId: string; maxProfileBytes?: number; stagedPath: string; persistentPath?: string | null; previousSnapshotId?: string | null; nextSnapshotId: string; allowInvalidPrevious?: boolean; checkpoint?: (step: string) => Promise<void> }): Promise<void>;
export function recoverProfilePublication(tx: { profile: { findUnique(args: { where: { id: string }; select: { snapshotId: true; deletedAt: true } }): Promise<{ snapshotId: string | null; deletedAt: Date | null } | null> } }, options: { directory: string; profileId: string; maxProfileBytes?: number; checkpoint?: (step: string) => Promise<void> }): Promise<string>;
