import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readPlaywrightAdapter, assertAdapterCapability } from './playwright-adapter.mjs';
import catalog from '../utils/deviceCatalog.js';
const files = ['cookie-observation.mjs','../utils/cookieAge.js','network-transport.mjs','profiles.mjs','page-session.mjs','runner.mjs','persistent-cache.mjs','first-document.mjs','context-matrix.mjs','api-behavior.mjs','native-baseline.mjs','fingerprint-check.mjs','client-hints.mjs','battery-runtime.mjs','canvas-profile.mjs','worker-passport.mjs','webgl-limits.mjs','browser-qualification.mjs','runtime-metadata.mjs','qualification-context.mjs','playwright-adapter.mjs','native-signatures.mjs','../utils/fingerprint.js','../utils/structuredFields.js','../utils/profile-base.json','../utils/device-catalog.json'];
let cachedAdapterVersion;
function adapterVersion(readAdapter) {
  if (readAdapter === readPlaywrightAdapter && cachedAdapterVersion) return cachedAdapterVersion;
  let adapter;
  assertAdapterCapability('passport', () => (adapter = readAdapter()));
  const hash = createHash('sha256');
  for (const file of files) hash.update(file).update(readFileSync(new URL(file, import.meta.url)));
  // Qualify the effective installed code, not a versioned patch or a lockfile
  // that may not be shipped in a runtime-only deployment.
  hash.update(adapter.version || '').update(adapter.source);
  const require = createRequire(import.meta.url);
  for (const name of ['fingerprint-injector','fingerprint-generator','playwright-extra','puppeteer-extra-plugin-stealth']) {
    const entry = require.resolve(name);
    let directory = dirname(entry);
    for (;;) {
      const parent = dirname(directory);
      try {
        const pkg = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
        if (pkg.name === name) { hash.update(name).update(pkg.version).update(readFileSync(entry)); break; }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (parent === directory) throw Error('worker_passport_adapter_unavailable');
      directory = parent;
    }
  }
  const value = hash.digest('hex');
  if (readAdapter === readPlaywrightAdapter) cachedAdapterVersion = value;
  return value;
}
export function qualificationContext(runtimeVersion, { readAdapter = readPlaywrightAdapter } = {}) {
  const fontEnvironment=process.env.FONTCONFIG_FILE?createHash('sha256').update(readFileSync(process.env.FONTCONFIG_FILE)).update(readFileSync(new URL('./manifest.json',`file://${process.env.FONTCONFIG_FILE}`))).digest('hex'):'system-fonts';
  const value = { fontEnvironment, version: 2, runtimeVersion, catalogVersion: catalog.DEVICE_CATALOG.version, adapterVersion: adapterVersion(readAdapter) };
  return { ...value, key: createHash('sha256').update(JSON.stringify(value)).digest('hex') };
}
export function controlTemplates() { return catalog.DEVICE_CATALOG.templates.map(t => ({ id: t.id, revision: t.revision })); }
