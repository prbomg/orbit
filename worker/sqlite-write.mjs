// SQLite has one writer. Queue this client's transactions before opening them,
// instead of filling its connection pool with transactions waiting on each other.
import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
const queues = new WeakMap();
const measurements = new AsyncLocalStorage();
export const measureSqliteWrites = (operation, observe) => measurements.run(observe, operation);
export function sqliteWrite(prisma, callback, options = { maxWait: 10000, timeout: 15000 }) {
  const queuedAt = performance.now(), observe = measurements.getStore();
  return serializeSqlite(prisma, async () => {
    const started = performance.now(); let failed = false;
    try {
      for (let attempt = 0; ; attempt++) {
        let entered = false;
        try {
          return await prisma.$transaction(async tx => {
            // Take the writer lock before reads establish a stale WAL snapshot.
            // WHERE 0 changes no rows, including leases. Only admission retries:
            // callbacks can publish files or perform other irreversible effects.
            await tx.$executeRaw`DELETE FROM "WorkflowLease" WHERE 0`;
            entered = true;
            return callback(tx);
          }, options);
        } catch (error) {
          if (entered || attempt >= 5 || !isDatabaseUnavailable(error)) throw error;
          // The failed transaction has closed before waiting. Keep this client
          // serialized without holding a SQLite connection during backoff.
          await delay(Math.min(1000, 100 * 2 ** attempt));
        }
      }
    }
    catch (error) { failed = true; throw error; }
    finally { observe?.({ queueMs: started - queuedAt, transactionMs: performance.now() - started, failed }); }
  });
}
/** Queue a helper that already opens its own transaction, without nesting one. */
export function serializeSqlite(prisma, operation) {
  const pending = (queues.get(prisma) || Promise.resolve()).then(operation);
  queues.set(prisma, pending.catch(() => {}));
  return pending;
}

/** Only observational events/progress belong here, never leases or commits. */
export function sqliteTelemetryBuffer(prisma, writeBatch) {
  let entries = [], data = {}, tail = Promise.resolve();
  return {
    push(entry) { entries.push(entry); },
    update(value) { Object.assign(data, value); },
    get size() { return entries.length; },
    flush() {
      const operation = tail.then(async () => {
        if (!entries.length && !Object.keys(data).length) return;
        const batch = entries, progress = data; entries = []; data = {};
        try { await sqliteWrite(prisma, tx => writeBatch(tx, batch, progress)); }
        catch (error) {
          // Rollback preserves the batch. Newer progress wins, event order stays
          // intact, and a rejected write never poisons subsequent flushes.
          entries = [...batch, ...entries]; data = { ...progress, ...data };
          throw error;
        }
      });
      tail = operation.catch(() => {});
      return operation;
    },
  };
}

/** Infrastructure contention must not exhaust a browser profile's attempt budget. */
export function isDatabaseUnavailable(error) {
  const message = String(error?.message || '');
  return ['P1008', 'P2024', 'P2034', 'GenericFailure'].includes(error?.code) ||
    error?.code === 'P2028' && /timeout|expired|already closed/i.test(message) ||
    /SQLITE_BUSY|database is locked/i.test(message);
}