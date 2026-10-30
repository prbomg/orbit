// Explicit maintenance operation. Run with web/workers stopped and an online DB backup made.
// Dry run is the default; apply requires the inspected legacy count and a fresh backup directory.
import { PrismaClient } from '@prisma/client';
import { mkdir, writeFile, rename, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import generation from '../utils/profileGeneration.js';
import pool from '../utils/profilePool.js';
import publication from '../utils/profilePublication.js';
const args = process.argv.slice(2), apply = args.includes('--apply');
const option = name => args[args.indexOf(name) + 1];
const db = new PrismaClient();
try {
  const rows = await db.profile.findMany({ where: { deletedAt: null }, select: { id: true, fingerprint: true } });
  const ids = rows.filter(row => !generation.profileGeneration(row.fingerprint).current).map(row => row.id);
  const settings = await db.settings.findUniqueOrThrow({ where: { id: 1 } });
  const count = Math.min(settings.replenishBatchSize, settings.maxPendingProfiles);
  console.log(JSON.stringify({ legacy: ids.length, retainedCurrent: rows.length - ids.length, newBatch: count, mode: 'local', apply }));
  if (apply) {
    if (!args.includes('--expected') || Number(option('--expected')) !== ids.length || !ids.length) throw Error('legacy_count_changed');
    if (!args.includes('--backup')) throw Error('backup_required');
    const backup = resolve(option('--backup'));
    if (!(await stat(join(backup, 'before.db'))).isFile()) throw Error('database_backup_required');
    const directory = resolve(process.env.WORKER_PROFILES_DIR || 'profiles');
    if ((await publication.pendingPublications(directory)).length) throw Error('pending_publication_requires_recovery');
    await writeFile(join(backup, 'renewal-plan.json'), JSON.stringify({ ids, count, settings: { warmupEnabled: settings.warmupEnabled, autoReplenishEnabled: settings.autoReplenishEnabled, fingerprintMode: settings.fingerprintMode }, createdAt: new Date().toISOString() }, null, 2), { flag: 'wx', mode: 0o600 });
    await db.$transaction(async tx => {
      await tx.$executeRaw`UPDATE "Settings" SET "id"="id" WHERE "id"=1`;
      if (await tx.workflowLease.count({ where: { key: { startsWith: 'profile:' }, expiresAt: { gt: new Date() } } }) || await tx.warmupJob.count({ where: { status: 'running' } }) || await tx.taskExecution.count({ where: { status: 'running' } }) || await tx.task.count({ where: { status: 'running' } })) throw Error('active_work_prevents_renewal');
      if (await tx.profile.count({where:{deletedAt:null}}) !== rows.length) throw Error('pool_changed');
      await tx.settings.update({ where: { id: 1 }, data: { warmupEnabled: false, autoReplenishEnabled: false, fingerprintMode: 'local' } });
      for (let i = 0; i < ids.length; i += 200) {
        const chunk = ids.slice(i, i + 200);
        await tx.profile.updateMany({ where: { id: { in: chunk }, deletedAt: null }, data: { deletedAt: new Date(), isEnabled: false, readinessVersion: 0, readinessVerifiedAt: null, readinessValidUntil: null } });
        await tx.warmupJob.updateMany({ where: { profileId: { in: chunk } }, data: { status: 'paused', stage: 'paused', owner: null, retryAfter: null, nextStageAt: null } });
      }
    }, { timeout: 30000 });
    // Preserve old sessions in the backup, outside the live pool. Never delete project history.
    const archived = join(backup, 'sessions');
    await mkdir(join(archived, 'browser-data'), { recursive: true, mode: 0o700 });
    let moved = 0;
    for (const id of ids) {
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw Error('unsafe_profile_id');
      for (const name of [`${id}.json`, `${id}.json.previous`, `browser-data/${id}`]) {
        try { await rename(join(directory, name), join(archived, name)); moved++; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
    const result = await db.$transaction(tx => pool.createProfileBatch(tx, { count, namePrefix: 'Новый пул · local-v6' }), { timeout: 30000 });
    // The worker is enabled separately after deployment verification; preserve auto-fill preference.
    await db.settings.update({ where: { id: 1 }, data: { autoReplenishEnabled: settings.autoReplenishEnabled } });
    const report = { retired: ids.length, sessionsMoved: moved, created: result.queued, newIds: result.profiles.map(p => p.id), completedAt: new Date().toISOString() };
    await writeFile(join(backup, 'renewal-result.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ ...report, newIds: undefined }));
  }
} finally { await db.$disconnect(); }
