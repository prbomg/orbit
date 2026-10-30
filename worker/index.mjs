import { safeLogDetails } from './log-redaction.mjs';
import { PrismaClient } from '@prisma/client';
import { loadConfig } from './config.mjs';
import { acquireLock } from './lock.mjs';
import { pollDatabase } from './runner.mjs';
import { writeManagedEvent } from './managed-state.mjs';
import { appendTaskLiveEvent } from './live-view.mjs';
import { recoverProfileSaves } from './profile-publication.mjs';
import { createTechLogger, closeTechLogs, TECH_LOG_FORMAT_VERSION } from './tech-logger.mjs';

const log = (event, details = {}) => console.log(JSON.stringify({ time: new Date().toISOString(), event, ...safeLogDetails(details) }));
const MAX_CACHED_LOGGERS = 64;

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--once' && !/^--project=[a-zA-Z0-9_-]{1,128}$/.test(arg)) || args.filter(arg => arg.startsWith('--project=')).length > 1) {
    throw new Error('Usage: node worker/index.js [--once] [--project=ID]');
  }
  const config = loadConfig();
  config.projectId = args.find(arg => arg.startsWith('--project='))?.slice(10) ?? null;
  const runId = process.env.ORBIT_WORKER_RUN_ID;
  config.runId = runId;
  const release = await acquireLock(config.databasePath, { projectId: config.projectId, runId });
  const prisma = new PrismaClient({ datasources: { db: { url: config.databaseUrl } } });
  const controller = new AbortController();
  const browsers = new Set();

  // Кэш промисов инстансов файловых логгеров по ID задач (исключает гонку при параллельных логах)
  const techLoggers = new Map();

  const baseEmit = (evt, dtls) => {
    log(evt, dtls);
    if (config.projectId && runId) {
      writeManagedEvent(config.projectId, runId, evt, dtls);
      if (typeof dtls.taskId === 'string' || typeof dtls.taskId === 'number') {
        appendTaskLiveEvent(runId, String(dtls.taskId), evt, dtls);
      }
    }
  };

  const getTaskLogger = taskId => {
    const key = String(taskId);
    let loggerPromise = techLoggers.get(key);
    if (loggerPromise) {
      // Обновляем позицию ключа в Map (LRU)
      techLoggers.delete(key);
      techLoggers.set(key, loggerPromise);
      return loggerPromise;
    }

    if (techLoggers.size >= MAX_CACHED_LOGGERS) {
      const oldestKey = techLoggers.keys().next().value;
      if (oldestKey !== undefined) techLoggers.delete(oldestKey);
    }

    loggerPromise = Promise.resolve()
      .then(() => createTechLogger(key, baseEmit, { projectId: config.projectId, runId }, executionId => prisma.taskExecution.findFirst({ where: { id: executionId, taskId: key }, select: { startedAt: true, attempts: true } })))
      .catch(() => {
        techLoggers.delete(key);
        return null;
      });

    techLoggers.set(key, loggerPromise);
    return loggerPromise;
  };

  const emit = (event, details = {}) => {
    const taskId = details?.taskId;
    if (taskId) {
      void getTaskLogger(taskId).then(taskLogger => {
        if (taskLogger && typeof taskLogger.log === 'function') {
          taskLogger.log(event, details);
        } else {
          baseEmit(event, details);
        }
      });
    } else {
      baseEmit(event, details);
    }
  };

  const stop = () => {
    if (controller.signal.aborted) return;
    emit('stopping');
    controller.abort();
    for (const browser of browsers) void browser.close().catch(() => {});
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  try {
    await recoverProfileSaves(prisma, config.profilesDirectory, { log: emit });
    if (config.projectId && !(await prisma.project.findUnique({ where: { id: config.projectId }, select: { id: true } }))) {
      throw new Error('Project not found');
    }
    emit('worker_started', { once: args.includes('--once'), projectId: config.projectId, technicalLogFormat: TECH_LOG_FORMAT_VERSION });
    return await pollDatabase({
      prisma,
      config,
      signal: controller.signal,
      once: args.includes('--once'),
      onBrowser: (value, previous) => {
        if (previous) browsers.delete(previous);
        if (value) browsers.add(value);
      },
      log: emit,
    });
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await Promise.allSettled([...browsers].map(browser => browser.close()));
    try {
      await Promise.allSettled([...techLoggers.values()]);
      await closeTechLogs();
      await prisma.$disconnect();
    } finally {
      await release();
      emit('worker_stopped');
    }
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  log('startup_failed', {
    errorType: error.name,
    message: error.message.startsWith('Invalid ') || /^(Set DATABASE_URL|SQLite file|DATABASE_URL must|A worker|Could not acquire|Worker lock|Usage:|WORKER_)/.test(error.message)
      ? error.message
      : 'Worker could not start; check database setup and configuration',
  });
  process.exitCode = 1;
}