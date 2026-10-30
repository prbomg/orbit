import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { attestedSession } from './helpers/attestation.mjs';

const require = createRequire(import.meta.url);
const code = ts.transpileModule(readFileSync(new URL('../lib/profile-quality.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const module = { exports: {} };
new Function('require', 'exports', 'module', code)(name => require(name === '@/utils/profileReadiness' ? '../utils/profileReadiness.js' : name), module.exports, module);
const { profileQuality } = module.exports;
const present = fingerprintCheck => profileQuality({ fingerprintCheck, sessionCheck: null }, { savedAt: null, hasData: false }, [], null);

test('current reports show completed browser checks rather than pending legacy UI', () => {
  for (const version of [3, 4, 5]) {
    const quality = present({ version, status: 'passed' });
    assert.equal(quality.parts.find(p => p.label === 'Браузер').status, 'passed');
  }
  assert.equal(present({ version: 2, status: 'passed' }).parts.find(p => p.label === 'Браузер').status, 'pending');
});

test('behavior findings and incomplete reports cannot appear as native API approval', () => {
  const differences = [{ field: 'properties.navigator.platform.functions.getter.source', actual: 'JS getter', baseline: 'native getter' }];
  for (const [status, expected] of [['differences', 'warning'], ['incomplete', 'pending'], ['matched', 'passed']]) {
    const quality = present({ version: 5, status: 'passed', contextMatrix: {
      apiBehavior: { status, baselineScope: 'same-browser-without-orbit-profile-scripts', differences: status === 'differences' ? 1 : 0, errors: status === 'incomplete' ? 1 : 0 },
      records: [{ scene: 'dedicatedWorker', apiBehavior: { status, differences } }],
    } });
    assert.equal(quality.parts.find(p => p.label === 'Браузер').status, 'passed');
    assert.equal(quality.parts.find(p => p.label === 'Поведение API').status, expected);
    assert.deepEqual(quality.apiBehavior.contexts[0].differences, differences);
  }
  assert.equal(present(null).apiBehavior, null);
  assert.equal(present({ version: 5, status: 'passed' }).parts.find(p => p.label === 'Поведение API').status, 'pending');
});

test('a measured network with no Android reference remains a warning even when TCP preset passed',()=>{
 const transport={status:'measured',tls:{status:'measured',ja4:'fixture'},http2:{status:'measured'},http3:{status:'not_observed'},comparison:{status:'reference_missing'},androidDeviceConfirmed:false};
 const quality=present({version:5,status:'passed',network:{status:'passed',preset:'Android',transport}});
 assert.equal(quality.parts.find(p=>p.label==='Сеть').status,'passed');
 assert.equal(quality.parts.find(p=>p.label==='TLS и HTTP').status,'warning');
 assert.equal(quality.transport.androidDeviceConfirmed,false);
 assert.equal(present({version:5,status:'passed'}).parts.find(p=>p.label==='TLS и HTTP').status,'pending');
});

test('incomplete device reports and a session bound to another passport cannot appear verified', () => {
  const device = checks => present({ version: 5, status: 'passed', checks }).parts.find(p => p.label === 'Устройство').status;
  assert.equal(device(undefined), 'pending');
  assert.equal(device({ cpu: true }), 'pending');
  assert.equal(device({ cpu: true, screen: true, touch: true, webgl: true }), 'passed');
  assert.equal(device({ cpu: true, screen: true, touch: true, webgl: true, memory: false }), 'failed');
  const evidence = attestedSession();
  const profile = { fingerprintCheck: null, sessionCheck: evidence.sessionCheck, snapshotId: evidence.snapshotId };
  const session = { ...evidence, savedAt: evidence.savedAt };
  const status = value => profileQuality(profile, value, [], null).parts.find(p => p.label === 'Сессия').status;
  assert.equal(status(session), 'passed');
  assert.equal(status({ ...session, passportHash: 'b'.repeat(64) }), 'pending');
  assert.equal(status({ ...session, passportHash: null }), 'pending');
});
