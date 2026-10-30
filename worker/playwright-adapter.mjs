import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Lazy: importing the worker must remain possible with an unpatched installation.
export function readPlaywrightAdapter() {
  const require = createRequire(import.meta.url);
  const runtime = createRequire(require.resolve('playwright/package.json'));
  const filename = runtime.resolve('playwright-core/package.json');
  return { version: JSON.parse(readFileSync(filename, 'utf8')).version,
    source: readFileSync(join(dirname(filename), 'lib/coreBundle.js'), 'utf8') };
}

// Check both definitions and call sites. A version label or a copied marker alone
// cannot establish compatibility. Protocol behavior is verified by browser tests.
export function adapterCapabilities({ source = '' } = {}) {
  const matches = expressions => expressions.every(expression => expression.test(source));
  return {
    passport: matches([
      /\/\* orbit-worker-passport-v1:/,
      /function\s+orbitUserAgentOverride\(context\)/,
      /async function\s+orbitResumeWorker\(context,\s*session/,
      /void orbitResumeWorker\(this\._crPage\._browserContext,\s*session2/,
      /this\._orbitReady\s*=\s*orbitResumeWorker\(this\.browserContext/,
      /orbitAttachSharedWorker\(context,\s*session2\)/,
      /\.\.\.orbitUserAgentOverride\(this\._crPage\._browserContext\)/,
      /orbit-storage-probe-v1/,
      /orbit-storage-origins-v2:/,
      /orbitOrigins:\s*tOptional\(tArray\(tString\)\)/,
      /orbitOrigins:\s*options\.orbitOrigins/,
      /for \(const origin of orbitOrigins\)/,
      /originsToSave\.add\(origin\)/,
      /!this\._page\?\.isStorageStatePage/,
      /"Network\.setBypassServiceWorker",\s*\{ bypass: true \}/,
      /async _orbitEnableServiceWorkerBootstrap\(\)/,
      /async _orbitContinueServiceWorkerBootstrap\(event\)/,
      /await this\._browser\._orbitEnableServiceWorkerBootstrap\(\)/,
      /resourceType:\s*"Other",\s*requestStage:\s*"Request"/,
      /"Network.setUserAgentOverride",\s*metadata\.override/,
      /"Fetch.continueRequest",\s*\{ requestId: event\.requestId, headers \}/,
    ]),
    persistentCache: matches([
      /\/\* orbit-persistent-cache-v1 \*\//,
      /const orbitPersistentCache\s*=\s*!this\._page\?\.isStorageStatePage\s*&&\s*orbitCacheContext\?\.initScripts\.some/,
      /cacheDisabled:\s*enabled\s*&&\s*!orbitPersistentCache/,
      /!this\._protocolRequestInterceptionEnabled\s*\|\|\s*\(!this\._page\?\.isStorageStatePage\s*&&\s*orbitCacheContext\?\.initScripts\.some/,
    ]),
  };
}

export function assertAdapterCapability(capability, read = readPlaywrightAdapter) {
  const code = capability === 'passport' ? 'worker_passport_adapter_unavailable' : 'persistent_cache_adapter_unavailable';
  try {
    if (adapterCapabilities(read())[capability]) return;
  } catch { /* Dependency resolution and file errors use the same actionable code. */ }
  const error = new Error(code);
  error.code = code;
  throw error;
}
