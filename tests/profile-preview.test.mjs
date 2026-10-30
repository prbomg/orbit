import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import catalog from '../utils/deviceCatalog.js';
import fp from '../utils/fingerprint.js';
import preview from '../utils/profilePreview.js';
const config={count:100,fingerprintMode:'local',fingerprintDevicePreset:'mixed',fingerprintDeviceWeights:{...catalog.DEFAULT_WEIGHTS},fingerprintLocale:'ru-RU',fingerprintTimezone:'Europe/Moscow'};
test('saved catalog survives revision changes and added models without changing identity',()=>{
 const old=fp.localPassport(),before=JSON.stringify(old),hash=fp.identityHash('existing',old);
 const next=structuredClone(catalog.DEVICE_CATALOG);next.version='future-test';
 next.templates[0].revision++;next.templates[0].browser.cpu=6;
 next.templates.push({...structuredClone(next.templates[1]),id:'new_model'});
 const registry=catalog.createCatalogRegistry(next,[catalog.DEVICE_CATALOG]);
 assert.deepEqual(catalog.templateIssues(old,registry),[]);
 assert.equal(JSON.stringify(old),before);assert.equal(fp.identityHash('existing',old),hash);
 const bad=structuredClone(old);bad.deviceTemplate.catalogVersion='missing';assert.deepEqual(catalog.templateIssues(bad,registry),['device_template_version']);
 bad.deviceTemplate.catalogVersion=old.deviceTemplate.catalogVersion;bad.deviceTemplate.revision=999;assert.ok(catalog.templateIssues(bad,registry).includes('device_template_version'));
 assert.throws(()=>catalog.createCatalogRegistry({...next,version:catalog.DEVICE_CATALOG.version},[catalog.DEVICE_CATALOG]),/catalog_version_reused/);
});
test('CPU and touch values come from selected template',()=>{
 const require=createRequire(import.meta.url),module={exports:{}};
 const template=structuredClone(catalog.DEVICE_CATALOG.templates[0]);template.browser.cpu=6;template.browser.touch=10;
 const localRequire=createRequire(new URL('../utils/fingerprint.js',import.meta.url));
 vm.runInNewContext(readFileSync(new URL('../utils/fingerprint.js',import.meta.url),'utf8'),{module,structuredClone,Intl,require:name=>name==='./deviceCatalog.js'?{...catalog,findTemplate:()=>template}:localRequire(name)});
 const p=module.exports.localPassport({}, {templateId:template.id});
 assert.equal(p.fingerprint.navigator.hardwareConcurrency,6);assert.equal(p.fingerprint.navigator.maxTouchPoints,10);
});
test('preview is reproducible, validates every sample and reports the saved plan',async()=>{
 const before=JSON.stringify(config),a=await preview.previewProfiles(config,{warmupPlanPreset:'storage'}),b=await preview.previewProfiles(config,{warmupPlanPreset:'storage'});
 assert.deepEqual(a,b);assert.equal(JSON.stringify(config),before);assert.equal(a.passed,100);assert.equal(a.models.reduce((sum,m)=>sum+m.count,0),100);assert.equal(a.plan.sitesPerSession,1);assert.deepEqual(a.errors,[]);
 const fixed=await preview.previewProfiles({...config,fingerprintDevicePreset:'s23_android14'});assert.equal(fixed.models.find(m=>m.id==='s23_android14').count,100);
});
test('provider and fallback scopes never claim provider validation',async()=>{
 const provider=await preview.previewProfiles({...config,fingerprintMode:'mobileproxy'});assert.equal(provider.checked,0);assert.equal(provider.scope,'provider_unavailable');
 assert.equal((await preview.previewProfiles({...config,fingerprintMode:'auto'})).scope,'local_fallback');
});
test('preview rejects excessive count, invalid locale, timezone and distributions',async()=>{
 for(const patch of [{count:0},{count:1001},{count:1.5},{fingerprintLocale:'bad_!'},{fingerprintTimezone:'not/a-zone'},{fingerprintDeviceWeights:{bad:1}}])await assert.rejects(preview.previewProfiles({...config,...patch}));
});
