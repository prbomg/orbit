import publication from '../utils/profilePublication.js';
import { sqliteWrite } from './sqlite-write.mjs';

export async function recoverProfileSaves(prisma, directory, { profileId, owner, maxProfileBytes, log = () => {} } = {}) {
  if (!directory) return;
  const ids = profileId ? [profileId] : await publication.pendingPublications(directory);
  for (const id of ids) {
    if (!await publication.hasPendingPublication(directory, id)) continue;
    try {
      const result = await sqliteWrite(prisma, async tx => {
        await tx.$executeRaw`UPDATE "Settings" SET "id"="id" WHERE "id"=1`;
        const lease = await tx.workflowLease.findUnique({ where: { key: `profile:${id}` } });
        if (lease && lease.expiresAt > new Date() && lease.owner !== owner) return 'busy';
        return publication.recoverProfilePublication(tx, { directory, profileId: id, maxProfileBytes });
      });
      if (result === 'busy' && profileId) throw new publication.PublicationError('profile_publication_busy');
      if (['committed', 'rolled_back'].includes(result)) log('profile_publication_recovered', { profileId: id, result });
    } catch (error) {
      if (error.code === 'profile_publication_busy') throw error;
      // Leave the journal and recovery data available for the next attempt.
      await sqliteWrite(prisma, tx => tx.profile.updateMany({ where: { id, status: 'ready' },
        data: { status: 'needs_check', readinessVersion: 0, readinessVerifiedAt: null, readinessValidUntil: null } })).catch(() => {});
      log('profile_publication_recovery_failed', { profileId: id, code: error.code || 'profile_publication_recovery_required' });
      if (profileId) throw error;
    }
  }
}
