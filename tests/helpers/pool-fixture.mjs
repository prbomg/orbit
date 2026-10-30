import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PrismaClient } from '@prisma/client';
import { attestedSession } from './attestation.mjs';
export const migrations = async () => Promise.all((await readdir(new URL('../../prisma/migrations/', import.meta.url))).filter(n => /^\d/.test(n)).sort().map(n => readFile(new URL(`../../prisma/migrations/${n}/migration.sql`, import.meta.url), 'utf8')));
export async function poolFixture({ wal = process.env.ORBIT_TEST_SQLITE_WAL === '1' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'orbit-pool-'));
  const sql = new DatabaseSync(join(dir, 'test.db')); if(wal)sql.exec('PRAGMA journal_mode=WAL'); for (const migration of await migrations()) sql.exec(migration); sql.close();
  const db = new PrismaClient({ datasources: { db: { url: `file:${dir}/test.db` } } });
  await db.settings.create({ data: { id: 1, autoReplenishEnabled: false, warmupConcurrency: 2, warmupSharedProxy: false } });
  const project = await db.project.create({ data: { name: 'Fixture', targetUrl: 'https://example.test/', yandexRegionId: '213', regionName: '' } });
  const proxy = await db.proxy.create({ data: { host: '127.0.0.1', port: 8000, username: 'fixture', password: 'fixture' } });
  return { dir, db, project, proxy,
    ready: () => { const evidence = attestedSession(); return db.profile.create({ data: { name: 'Ready', status: 'ready', warmedAt: new Date(), fingerprintState: 'verified', snapshotId: evidence.snapshotId, sessionCheck: evidence.sessionCheck, readinessVersion: 1, readinessVerifiedAt: new Date(), readinessValidUntil: new Date(Date.now() + 86400000) } }); },
    task: (projectId = project.id, targetExecutions = 1) => db.task.create({ data: { projectId, url: 'https://example.test/', targetExecutions } }),
    cleanup: async () => { await db.$disconnect(); await rm(dir, { recursive: true, force: true }); } };
}
