import { openSync, closeSync, writeFileSync, readFileSync, unlinkSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import runtime from '../utils/workerRuntime.js';

function isAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}
function occupied(path) {
  try { return isAlive(JSON.parse(readFileSync(path, 'utf8')).pid); }
  catch (error) {
    if (error.code === 'ENOENT') return false;
    throw new Error('Worker lock is unreadable; inspect it before removing it');
  }
}

/** Independent project workers; the legacy all-project CLI remains exclusive. */
export async function acquireLock(databasePath, { projectId = null, runId = null } = {}) {
  const path = runtime.workerLockPath(databasePath, projectId);
  const globalPath = runtime.workerLockPath(databasePath);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const token = randomUUID();
  const release = async () => {
    try { if (JSON.parse(readFileSync(path, 'utf8')).token === token) unlinkSync(path); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    let handle;
    try { handle = openSync(path, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (occupied(path)) throw new Error('A worker is already using this project or database');
      try { unlinkSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      continue;
    }
    try { writeFileSync(handle, JSON.stringify({ pid: process.pid, token, projectId, runId })); }
    catch (error) { unlinkSync(path); throw error; }
    finally { closeSync(handle); }
    try {
      // Register first, then check the other scope. This also closes the race
      // between an all-project CLI launch and a scoped project launch.
      if (projectId !== null) {
        if (occupied(globalPath)) throw new Error('A worker is already using this database');
      } else {
        let files = [];
        try { files = readdirSync(`${databasePath}.workers`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (files.some(name => name.endsWith('.lock') && occupied(`${databasePath}.workers/${name}`))) throw new Error('A worker is already using this database');
      }
      return release;
    } catch (error) { await release(); throw error; }
  }
  throw new Error('Could not acquire worker lock');
}
