import test from 'node:test';
import assert from 'node:assert/strict';
import { readPlaywrightAdapter, adapterCapabilities, assertAdapterCapability } from '../worker/playwright-adapter.mjs';
import { assertWorkerAdapterInstalled } from '../worker/worker-passport.mjs';
import { enablePersistentCache } from '../worker/persistent-cache.mjs';
const installed = readPlaywrightAdapter();

test('installed adapter and structurally compatible version do not depend on version label', () => {
  assert.match(installed.version, /^\d+\.\d+\.\d+/);
  for (const version of [installed.version, '1.63.0', '1.64.0', 'future-compatible']) {
    const read = () => ({ ...installed, version });
    assertWorkerAdapterInstalled(read);
    assertAdapterCapability('persistentCache', read);
  }
});
test('unsupported dependency and missing passport marker fail lazily with stable code', () => {
  for (const read of [() => ({ version: '2.0', source: '' }), () => { throw Error('module not found'); },
    () => ({ source: installed.source.replaceAll('orbit-worker-passport-v1:', 'missing:') })]) {
    assert.throws(() => assertWorkerAdapterInstalled(read), { code: 'worker_passport_adapter_unavailable' });
  }
});
test('partial passport patch without resume or SW bootstrap call is rejected', () => {
  for (const fragment of ['void orbitResumeWorker(this._crPage._browserContext, session2', 'await this._browser._orbitEnableServiceWorkerBootstrap()', 'orbit-storage-origins-v2:', 'orbitOrigins: options.orbitOrigins', 'orbitOrigins: tOptional(tArray(tString))', 'for (const origin of orbitOrigins)', 'originsToSave.add(origin)', 'orbit-storage-probe-v1']) {
    assert.equal(adapterCapabilities({ source: installed.source.replace(fragment, 'missingHook()') }).passport, false);
  }
});
test('partial cache patch does not opt a context in', async () => {
  let calls = 0;
  const context = { addInitScript: async () => calls++ };
  await assert.rejects(enablePersistentCache(context, () => ({ source: installed.source.replace('enabled && !orbitPersistentCache', 'enabled') })), { code: 'persistent_cache_adapter_unavailable' });
  assert.equal(calls, 0);
  await enablePersistentCache(context, () => ({ ...installed, version: 'future-compatible' }));
  assert.equal(calls, 1);
});


test('qualification fingerprints the effective adapter lazily and rejects incompatible installed code', async () => {
  const {qualificationContext}=await import('../worker/qualification-context.mjs');
  const readAdapter=()=>installed;
  const first=qualificationContext('fixture-runtime',{readAdapter});
  assert.equal(qualificationContext('fixture-runtime',{readAdapter}).key,first.key);
  const changed=qualificationContext('fixture-runtime',{readAdapter:()=>({...installed,source:installed.source+'\n// changed effective adapter'})});
  assert.notEqual(changed.key,first.key);
  assert.throws(()=>qualificationContext('fixture-runtime',{readAdapter:()=>({source:''})}),{code:'worker_passport_adapter_unavailable'});
});
