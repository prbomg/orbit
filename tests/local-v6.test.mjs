import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import fp from '../utils/fingerprint.js';
import {passportValidation} from '../worker/passport-validation.mjs';
import {mobileContextOptions,createMobileContext,createMobilePage} from '../worker/profiles.mjs';
import {inspectFingerprint} from '../worker/fingerprint-check.mjs';
import {canvasProfileOptions} from '../worker/canvas-profile.mjs';
const seed=i=>createHash('sha256').update(`theme-fixture:${i}`).digest('hex').slice(0,32);
const saved=JSON.parse(readFileSync(new URL('./fixtures/local-v5-passport.json',import.meta.url)));

test('local-v7 stores reproducible preferences, locales and complete catalog metadata',()=>{
 const options={seed:seed(1),templateId:'s23_android14',runtimeVersion:'153.0.8010.12'};
 const a=fp.localPassport({fingerprintMode:'local'},options),b=fp.localPassport({fingerprintMode:'local'},options);
 assert.equal(a.generation.version,'6');assert.equal(a.generation.adapter,'local-v7');
 assert.deepEqual(a.fingerprint.canvas,{version:1,mode:'native'});
 assert.deepEqual(a.fingerprint,b.fingerprint);assert.deepEqual(a.headers,b.headers);
 assert.equal(a.runtimeVersion,options.runtimeVersion);
 assert.equal(a.fingerprint.navigator.platform,'Linux armv81');
 assert.equal(a.fingerprint.navigator.userAgentData.bitness,'64');
 assert.equal(a.fingerprint.navigator.appVersion,a.headers['user-agent'].replace(/^Mozilla\//,''));
 assert.deepEqual(a.fingerprint.navigator.languages,['ru-RU','ru','en-US','en']);
 assert.equal(a.headers['accept-language'],'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7');
 assert.equal(passportValidation(a).status,'passed');
 assert.equal(mobileContextOptions(fp.profileFromPassport('new',a)).colorScheme,a.fingerprint.preferences.colorScheme);
 const en=fp.localPassport({fingerprintLocale:'en'},options);assert.deepEqual(en.fingerprint.navigator.languages,['en']);assert.equal(en.headers['accept-language'],'en');
 for(const change of [p=>delete p.fingerprint.canvas,p=>p.fingerprint.canvas.mode='unknown',p=>p.fingerprint.canvas.version=2,p=>p.fingerprint.preferences.colorScheme='invalid',p=>p.fingerprint.preferences.colorScheme=p.fingerprint.preferences.colorScheme==='dark'?'light':'dark',p=>p.headers['accept-language']='ru',p=>p.fingerprint.navigator.userAgentData.wow64=true,p=>p.deviceTemplate.revision=999]){
  const bad=structuredClone(a);change(bad);assert.equal(passportValidation(bad).status,'failed');
 }
});

test('saved generation 5 keeps its identity and legacy Canvas policy',()=>{
 const fixture=JSON.parse(readFileSync(new URL('./fixtures/local-v6-pre-audit-passport.json',import.meta.url)));
 const before=JSON.stringify(fixture.passport);
 assert.equal(passportValidation(fixture.passport).status,'passed');
 assert.equal(fp.legacyIdentityHash(fixture.profileId,fixture.passport),fixture.identityHash);assert.equal(fp.matchesIdentityHash(fixture.profileId,fixture.passport,fixture.identityHash),true);
 assert.equal(canvasProfileOptions(fp.profileFromPassport(fixture.profileId,fixture.passport)).mode,'legacy-seeded-v1');
 assert.equal(JSON.stringify(fixture.passport),before);
 const changed=structuredClone(fixture.passport);changed.fingerprint.canvas={version:1,mode:'native'};
 assert.notEqual(fp.identityHash(fixture.profileId,changed),fp.identityHash(fixture.profileId,fixture.passport));
});

test('seeded themes approach 65/35 without changing across calls',()=>{
 let light=0;
 for(let i=0;i<10000;i++){const value=fp.deriveColorSchemeFromSeed(seed(i));assert.equal(value,fp.deriveColorSchemeFromSeed(seed(i)));if(value==='light')light++;}
 assert.ok(light>6200&&light<6800,String(light));
 assert.throws(()=>fp.deriveColorSchemeFromSeed('invalid'));
});

test('GREASE values and permutations match Chromium reference vectors and native metadata is preserved',()=>{
 assert.deepEqual(fp.getChromiumGreaseBrand('84'),{brand:'Not;A=Brand',version:'8'});
 assert.deepEqual(fp.getChromiumGreaseBrand('86'),{brand:'Not?A_Brand',version:'24'});
 assert.deepEqual(fp.getChromiumGreaseBrand('153'),{brand:'Not_A Brand',version:'8'});
 const options={fullVersion:'154.0.8037.57',osVersion:'14.0.0',modelCode:'SM-S911B'};
 const meta=fp.chromeMetadata(options);
 assert.deepEqual(meta.userAgentData.brands,[{brand:'Chromium',version:'154'},{brand:'Google Chrome',version:'154'},{brand:'Not A(Brand',version:'99'}]);
 const nativeBrands=[{brand:'Not A(Brand',version:'99'},{brand:'Chromium',version:'154'}];
 const native=fp.chromeMetadata({...options,nativeBrands});
 assert.deepEqual(native.userAgentData.brands,nativeBrands);assert.equal(native.userAgentData.fullVersionList[1].version,options.fullVersion);
 nativeBrands[0].brand='Changed';assert.notEqual(native.userAgentData.brands[0].brand,'Changed');
 assert.throws(()=>fp.chromeMetadata({...options,nativeBrands:[{brand:'Chromium',version:'100'}]}),/invalid_native_brands/);
 assert.throws(()=>fp.chromeMetadata({...options,fullVersion:'bad'}),/invalid_chrome_version/);
});

test('existing generation 4 identity and implicit dark theme remain unchanged',()=>{
 const before=JSON.stringify(saved.passport);
 assert.equal(passportValidation(saved.passport).status,'passed');
 assert.equal(fp.legacyIdentityHash('saved-v5',saved.passport),saved.identityHash);assert.equal(fp.matchesIdentityHash('saved-v5',saved.passport,saved.identityHash),true);
 const profile=fp.profileFromPassport('saved-v5',saved.passport);
 assert.equal(mobileContextOptions(profile).colorScheme,'dark');
 assert.equal(JSON.stringify(saved.passport),before);
});

test('both themes and headers match from first script through frames, popups and redirects',async()=>{
 const {chromium}=await import('playwright');
 const browser=await chromium.launch({headless:true,executablePath:process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH});
 try{
  for(const theme of ['light','dark']){
   let i=0;while(fp.deriveColorSchemeFromSeed(seed(i))!==theme)i++;
   const passport=fp.localPassport({fingerprintMode:'local'},{seed:seed(i),runtimeVersion:browser.version()}),profile=fp.profileFromPassport(theme,passport);
   for(let repeat=0;repeat<2;repeat++){
    const context=await createMobileContext(browser,profile);
    try{const report=await inspectFingerprint(await createMobilePage(context,profile),profile,undefined,browser.version());
     assert.equal(report.status,'passed',JSON.stringify(report));assert.equal(report.observed.preferences.colorScheme,theme);
     assert.ok(report.firstDocuments.records.every(r=>r.checks.colorScheme&&r.checks.languages&&r.checks.languageHeader&&r.checks.wow64));
    }finally{await context.close();}
   }
  }
 }finally{await browser.close();}
});

test('qualification persists native binary brands for runtime binding and reuses successful evidence',async()=>{
 const {chromium}=await import('playwright'),{poolFixture}=await import('./helpers/pool-fixture.mjs');
 const {qualifyBrowser}=await import('../worker/browser-qualification.mjs');
 const {readRuntimeBrands}=await import('../worker/runtime-metadata.mjs');
 const f=await poolFixture();let browser;
 try{
  browser=await chromium.launch({headless:true,executablePath:process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH});
  const native=await readRuntimeBrands(browser),result=await qualifyBrowser({prisma:f.db,browser});
  assert.equal(result.status,'passed');assert.deepEqual(result.report.nativeBrands,native.nativeBrands);
  assert.equal(result.report.contextMatrix.enforcement,'diagnostic');
  assert.equal(result.report.contextMatrix.status,'passed');
  assert.equal(result.report.contextMatrix.mismatches,0);
  assert.equal(result.report.contextMatrix.errors,0);
  assert.ok(result.report.pilots.every(p=>p.report.contextMatrix.records.length===6));
  for(const pilot of result.report.pilots)assert.deepEqual(pilot.passport.fingerprint.navigator.userAgentData.brands,native.nativeBrands);
  const cached=await qualifyBrowser({prisma:f.db,browser:{version:()=>browser.version(),newContext:()=>{throw Error('must_use_cache');}}});
  assert.equal(cached.status,'passed');assert.deepEqual(cached.report,JSON.parse(JSON.stringify(result.report)));
 }finally{await browser?.close();await f.cleanup();}
});
