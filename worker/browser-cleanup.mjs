import { readFile, readdir } from 'node:fs/promises';
import { withDeadline } from './warmup-timing.mjs';

async function processIdentity(pid) {
  try {
    const raw = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
    return { pid, parent: Number(fields[1]), started: fields[19] };
  } catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return null; throw error; }
}
async function ownedByWorker(identity) {
  for (let row = identity, depth = 0; row && depth < 32; depth++) {
    if (row.parent === process.pid) return true;
    if (row.parent <= 1) return false;
    row = await processIdentity(row.parent);
  }
  return false;
}

/** Capture only Chromium launched by this worker, with PID-reuse protection. */
export function browserCleanup({ cleanupMs = 5000, log = () => {} } = {}) {
  const browsers = new Map();
  async function track(browser) {
    if (!browser || browsers.has(browser)) return;
    browsers.set(browser, null);
    if (process.platform !== 'linux' || !browser.newBrowserCDPSession) return;
    let cdp;
    try {
      const identity = await withDeadline(async () => {
        cdp = await browser.newBrowserCDPSession();
        const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
        const pid = processInfo.find(row => row.type === 'browser')?.id;
        if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return null;
        const row = await processIdentity(pid);
        return row && await ownedByWorker(row) ? row : null;
      }, { timeoutMs: 2000 });
      browsers.set(browser, identity);
    } catch { log('warmup_cleanup_identity_unavailable'); }
    finally { if (cdp) void cdp.detach().catch(() => {}); }
  }
  async function force(identity) {
    if (!identity) return false;
    const current = await processIdentity(identity.pid);
    if (!current) return true;
    if (current.started !== identity.started || !await ownedByWorker(current)) return false;
    const rows = (await Promise.all((await readdir('/proc')).filter(name => /^\d+$/.test(name)).map(name => processIdentity(Number(name))))).filter(Boolean);
    const owned = new Set([identity.pid]);
    for (let added = true; added;) {
      added = false;
      for (const row of rows) if (owned.has(row.parent) && !owned.has(row.pid)) { owned.add(row.pid); added = true; }
    }
    // Stop the browser before its children so it cannot launch more renderers.
    const victims = [identity, ...rows.filter(row => row.pid !== identity.pid && owned.has(row.pid))];
    for (const row of victims) {
      const latest = await processIdentity(row.pid);
      if (latest?.started !== row.started) continue;
      try { process.kill(row.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    return true;
  }
  async function close() {
    await Promise.all([...browsers].map(async ([browser, identity]) => {
      try { await withDeadline(() => browser.close(), { timeoutMs: cleanupMs, code: 'warmup_cleanup_timeout' }); }
      catch {
        const killed = await withDeadline(() => force(identity), { timeoutMs: cleanupMs, code: 'warmup_cleanup_timeout' }).catch(() => false);
        log(killed ? 'warmup_browser_terminated' : 'warmup_cleanup_failed');
        if (!killed) throw new Error('warmup_cleanup_failed');
      }
    }));
  }
  return { track, close };
}
