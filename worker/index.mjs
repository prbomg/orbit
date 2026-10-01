import { PrismaClient } from '@prisma/client';
import { loadConfig } from './config.mjs';
import { acquireLock } from './lock.mjs';
import { pollDatabase } from './runner.mjs';
import { writeManagedEvent } from './managed-state.mjs';
import { appendTaskLiveEvent } from './live-view.mjs';

const log = (event, details = {}) => console.log(JSON.stringify({ time: new Date().toISOString(), event, ...details }));
async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--once' && !/^--project=[a-zA-Z0-9_-]{1,128}$/.test(arg)) || args.filter(arg => arg.startsWith('--project=')).length > 1) throw new Error('Usage: node worker/index.js [--once] [--project=ID]');
  const config = loadConfig();
  config.projectId = args.find(arg => arg.startsWith('--project='))?.slice(10) ?? null;
  const runId = process.env.ORBIT_WORKER_RUN_ID;
  config.runId = runId;
  const release = await acquireLock(config.databasePath, { projectId: config.projectId, runId });
  const prisma = new PrismaClient({ datasources: { db: { url: config.databaseUrl } } });
  const controller = new AbortController();
  let browser;
  const emit = (event, details = {}) => {
    log(event, details);
    if (config.projectId && runId) {
      writeManagedEvent(config.projectId, runId, event, details);
      if (typeof details.taskId === 'string') appendTaskLiveEvent(runId, details.taskId, event, details);
    }
  };
  const stop = () => {
    if (controller.signal.aborted) return;
    emit('stopping'); controller.abort();
    void browser?.close().catch(() => {});
  };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    if (config.projectId && !(await prisma.project.findUnique({ where: { id: config.projectId }, select: { id: true } }))) throw new Error('Project not found');
    emit('worker_started', { once: args.includes('--once'), projectId: config.projectId });
    return await pollDatabase({ prisma, config, signal: controller.signal, once: args.includes('--once'), onBrowser: value => { browser = value; }, log: emit });
  } finally {
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    if (browser) await browser.close().catch(() => {});
    try { await prisma.$disconnect(); }
    finally { await release(); emit('worker_stopped'); }
  }
}
try { process.exitCode = await main(); }
catch (error) {
  // Startup errors are controlled messages; never print browser stacks or DB URLs.
  log('startup_failed', { errorType: error.name, message: error.message.startsWith('Invalid ') || /^(Set DATABASE_URL|SQLite file|DATABASE_URL must|A worker|Could not acquire|Worker lock|Usage:|WORKER_)/.test(error.message) ? error.message : 'Worker could not start; check database setup and configuration' });
  process.exitCode = 1;
}
