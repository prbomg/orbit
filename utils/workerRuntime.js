const { readFileSync, readdirSync } = require('node:fs');
const { resolve } = require('node:path');
const safeProjectId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id);
function projectPaths(runtime, projectId) {
  if (!safeProjectId(projectId)) throw new Error('Invalid project ID');
  const directory = resolve(runtime, 'projects', projectId);
  return { directory, record: resolve(directory, 'worker.json'), log: resolve(directory, 'worker.log'), guard: resolve(directory, 'manager-guard') };
}
function workerLockPath(databasePath, projectId = null) {
  if (projectId === null) return `${databasePath}.worker.lock`;
  if (!safeProjectId(projectId)) throw new Error('Invalid project ID');
  return resolve(`${databasePath}.workers`, `${projectId}.lock`);
}
function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function readProjectRecord(runtime, projectId) {
  const current = readJson(projectPaths(runtime, projectId).record);
  if (current) return current.projectId === projectId ? current : null;
  const legacy = readJson(resolve(runtime, 'project-worker.json'));
  return legacy?.projectId === projectId ? legacy : null;
}
function projectIds(runtime, databasePath) {
  const ids = new Set();
  for (const [directory, suffix] of [[resolve(runtime, 'projects'), ''], [`${databasePath}.workers`, '.lock']]) {
    try { for (const name of readdirSync(directory)) {
      if (suffix && !name.endsWith(suffix)) continue;
      const id = suffix ? name.slice(0, -suffix.length) : name;
      if (safeProjectId(id)) ids.add(id);
    } } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const legacy = readJson(resolve(runtime, 'project-worker.json'));
  if (safeProjectId(legacy?.projectId)) ids.add(legacy.projectId);
  return [...ids];
}
module.exports = { safeProjectId, projectPaths, workerLockPath, readJson, readProjectRecord, projectIds };
