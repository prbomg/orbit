import pool from '../utils/profilePool.js';
import sessionState from '../utils/sessionState.js';
import { loadMobileProfile } from './profiles.mjs';
import { sqliteWrite } from './sqlite-write.mjs';
import readiness from '../utils/profileReadiness.js';
import publication from '../utils/profilePublication.js';
export async function maintainReadiness(prisma, config) {
  // Inspect a rotating batch of files as well as DB stamps. Task preflight also
  // checks the exact file, so a broken file is never used between sweeps.
  if (config.profilesDirectory) {
    const cursor = await prisma.workflowLease.findUnique({ where: { key: 'readiness-file-cursor' } });
    let ready = await prisma.profile.findMany({ where: { ...pool.eligibleProfiles(), ...(cursor ? { id: { gt: cursor.owner } } : {}) }, orderBy: { id: 'asc' }, take: 100 });
    if (!ready.length && cursor) ready = await prisma.profile.findMany({ where: pool.eligibleProfiles(), orderBy: { id: 'asc' }, take: 100 });
    for (const row of ready) {
      try {
        if (await publication.hasPendingPublication(config.profilesDirectory, row.id)) continue;
        const { profile } = await loadMobileProfile(config.profilesDirectory, row.id);
        if (!readiness.confirmed(row) || !sessionState.sessionSummary(profile).hasData || row.snapshotId !== profile.snapshot?.id ||
          !readiness.verifiedSnapshot(row.sessionCheck, profile.snapshot?.id, profile.savedAt, profile.snapshot?.passportHash)) throw new Error('Snapshot no longer valid');
      } catch {
        await sqliteWrite(prisma, async tx => {
          if (await tx.workflowLease.count({ where: { key: `profile:${row.id}`, expiresAt: { gt: new Date() } } })) return;
          await tx.profile.updateMany({ where: { id: row.id, status: 'ready' }, data: { status: 'needs_check', readinessVersion: 0, readinessVerifiedAt: null, readinessValidUntil: null } });
        });
      }
    }
    if (ready.length) await sqliteWrite(prisma, tx => tx.workflowLease.upsert({ where: { key: 'readiness-file-cursor' }, create: { key: 'readiness-file-cursor', owner: ready.at(-1).id, expiresAt: new Date('2100-01-01') }, update: { owner: ready.at(-1).id } }));
  }
  // Already queued rows must not starve later batches. Explicit pauses and
  // exhausted retry budgets require a user action, rather than being reset here.
  const candidates = await prisma.profile.findMany({ where: { AND: [readiness.needsCheckWhere(),
    { isEnabled: true, warmedAt: { not: null }, OR: [{ warmupJob: null }, { warmupJob: { status: 'completed' } }] }] },
    select: { id: true }, orderBy: { id: 'asc' }, take: 100 });
  if (candidates.length) await sqliteWrite(prisma, tx => pool.queueWarmups(tx, { profileIds: candidates.map(p => p.id), action: 'verify' }));
}
