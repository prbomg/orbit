import { mkdir, appendFile, writeFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Bounded observational I/O, ordered per file. Frames replace queued frames. */
export function asyncFileQueue({ maxPending = 256 } = {}) {
  const states = new Map();
  function enqueue(file, operation, { replace = false } = {}) {
    let state = states.get(file);
    if (!state) { state = { pending: [], draining: null }; states.set(file, state); }
    const last = state.pending.at(-1);
    if (replace && last?.replace) { last.operation = operation; return last.promise; }
    if (state.pending.length >= maxPending) return Promise.reject(Error('live_io_queue_full'));
    let resolve, reject;
    const promise = new Promise((a, b) => { resolve = a; reject = b; });
    state.pending.push({ operation, replace, resolve, reject, promise });
    if (!state.draining) state.draining = Promise.resolve().then(async () => {
      while (state.pending.length) {
        const item = state.pending.shift();
        try { await item.operation(); item.resolve(); }
        catch (error) { item.reject(error); }
      }
      states.delete(file);
    });
    return promise;
  }
  return { enqueue, async flush(directory) {
    for (;;) {
      const pending = [...states].filter(([file]) => file.startsWith(directory + '/')).map(([, state]) => state.draining);
      if (!pending.length) return;
      await Promise.all(pending);
    }
  } };
}
export const liveFiles = asyncFileQueue();
export async function appendLiveFile(file, text) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await appendFile(file, text, { mode: 0o600 });
}
export async function replaceLiveFile(file, value) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  try { await writeFile(temp, value, { mode: 0o600 }); await rename(temp, file); }
  finally { await rm(temp, { force: true }).catch(() => {}); }
}
