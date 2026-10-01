import { open, readFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

/** One serial worker per database, without changing the requested DB schema. */
export async function acquireLock(databasePath, { projectId = null, runId = null } = {}) {
  const path = `${databasePath}.worker.lock`;
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    let handle;
    try { handle = await open(path, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner;
      try { owner = JSON.parse(await readFile(path, 'utf8')); }
      catch { throw new Error('Worker lock is unreadable; inspect it before removing it'); }
      if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || isAlive(owner.pid)) throw new Error('A worker is already using this database');
      await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
      continue;
    }
    try { await handle.writeFile(JSON.stringify({ pid: process.pid, token, projectId, runId })); }
    catch (error) { await unlink(path).catch(() => {}); throw error; }
    finally { await handle.close(); }
    return async () => {
      try {
        const owner = JSON.parse(await readFile(path, 'utf8'));
        if (owner.token === token) await unlink(path);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    };
  }
  throw new Error('Could not acquire worker lock');
}
