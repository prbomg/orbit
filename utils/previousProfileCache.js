// Shared copy/seal/maintenance policy. Previous-only pruning runs after publication
// commits, while holding the profile's existing publication lock.
const { lstat, rm, open, readdir } = require('node:fs/promises');
const { join, dirname } = require('node:path');
const { constants } = require('node:fs');
// Exact paths relative to Chromium's userDataDir. Never match these basenames
// recursively: IndexedDB/*.blob and site-owned files are durable. ScriptCache
// contains installed ServiceWorker code; deleting it invalidates registrations.
const transientNames = new Set(['ShaderCache', 'GrShaderCache', 'GraphiteDawnCache', 'DawnGraphiteCache',
  'DawnCache', 'GPUCache', 'blob_storage', 'Crashpad', 'BrowserMetrics',
  'BrowserMetrics-spare.pma', 'OptimizationGuidePredictionModels']);
function isTransientProfilePath(relative, { previous = false } = {}) {
  if (relative === 'Default/Code Cache' || relative === 'Default/Service Worker/CacheStorage' ||
      previous && relative === 'Default/Cache') return true;
  const name = relative.startsWith('Default/') ? relative.slice(8) : relative;
  return !name.includes('/') && (transientNames.has(name) || /^(BrowserMetrics|OptimizationGuide)/.test(name));
}
async function directory(path, optional = false) {
  try {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Object.assign(new Error('invalid_profile_file'), { code: 'invalid_profile_file' });
    return true;
  } catch (error) { if (optional && error.code === 'ENOENT') return false; throw error; }
}
async function transientProfileArtifacts(root, options) {
  await directory(root);
  const defaults = join(root, 'Default');
  const hasDefault = await directory(defaults, true);
  const serviceWorker = join(defaults, 'Service Worker');
  const hasServiceWorker = hasDefault && await directory(serviceWorker, true);
  // Validate parents before removing any child; rm must never follow a parent
  // symlink into Cookies, IndexedDB or another published profile.
  const targets = [];
  for (const [base, prefix] of [[root, ''], ...(hasDefault ? [[defaults, 'Default/']] : []),
    ...(hasServiceWorker ? [[serviceWorker, 'Default/Service Worker/']] : [])]) {
    for (const name of await readdir(base)) {
      if (isTransientProfilePath(prefix + name, options)) {
        const path = join(base, name), stat = await lstat(path);
        if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
          throw Object.assign(new Error('invalid_profile_file'), { code: 'invalid_profile_file' });
        targets.push(path);
      }
    }
  }
  return targets;
}
async function pruneTransientProfileArtifacts(root, options) {
  const targets = await transientProfileArtifacts(root, options);
  const parents = new Set();
  for (const target of targets) {
    await rm(target, { recursive: true, force: true });
    parents.add(dirname(target));
  }
  for (const path of parents) {
    const parent = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await parent.sync(); } finally { await parent.close(); }
  }
}
async function prunePreviousProfileCache(browserRoot, expectedSnapshotId) {
  await directory(browserRoot);
  const previous = join(browserRoot, 'previous');
  await directory(previous);
  const file = await open(join(previous, '.orbit-snapshot-id'), constants.O_RDONLY | constants.O_NOFOLLOW).catch(error => {
    if (error.code === 'ENOENT' && expectedSnapshotId === null) return null;
    throw error;
  });
  let marker = null;
  if (file) { try { marker = await file.readFile('utf8'); } finally { await file.close(); } }
  if (marker !== expectedSnapshotId) throw Object.assign(new Error('profile_storage_version_mismatch'), { code: 'profile_storage_version_mismatch' });
  const defaults = join(previous, 'Default');
  const hasDefault = await directory(defaults, true);
  await pruneTransientProfileArtifacts(previous, { previous: true });
  for (const path of hasDefault ? [defaults, previous] : [previous]) {
    const parent = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await parent.sync(); } finally { await parent.close(); }
  }
}
module.exports = { prunePreviousProfileCache, pruneTransientProfileArtifacts, isTransientProfilePath, transientProfileArtifacts };
