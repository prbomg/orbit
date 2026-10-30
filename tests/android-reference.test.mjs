import test from 'node:test';
import assert from 'node:assert/strict';
import fp from '../utils/fingerprint.js';
import {passportValidation} from '../worker/passport-validation.mjs';
import {clientHintHeaders} from '../worker/client-hints.mjs';

test('S23 preset separates reduced UA from full browser version and coherent dimensions',()=>{
 const p=fp.localPassport({fingerprintMode:'local',fingerprintDevicePreset:'s23_android14'});
 fp.chromeMetadata(p.fingerprint,p.headers,'134.0.6998.45','SM-S911B','14.0.0');
 const {navigator:n,screen:s}=p.fingerprint,h=clientHintHeaders(n.userAgentData);
 assert.match(n.userAgent,/Android 10; K.*Chrome\/134\.0\.0\.0 Mobile/);
 assert.equal(n.userAgentData.uaFullVersion,'134.0.6998.45');assert.equal(n.userAgentData.platformVersion,'14.0.0');
 assert.equal(n.platform,'Linux armv81');assert.equal(h['sec-ch-ua-arch'],'""');assert.equal(h['sec-ch-ua-bitness'],'"64"');
 assert.equal(h['sec-ch-ua-model'],'"SM-S911B"');assert.equal(s.width*s.devicePixelRatio,1080);assert.equal(s.height*s.devicePixelRatio,2340);
 assert.equal(passportValidation(p,'134.0.6998.45').status,'passed');
});
test('new incompatible metadata is rejected; saved generations receive explicit warnings without identity mutation',()=>{
 const p=fp.localPassport();p.fingerprint.navigator.userAgentData.architecture='arm';p.fingerprint.navigator.userAgentData.bitness='64';
 assert.ok(passportValidation(p).errors.includes('android_client_hint_architecture'));
 p.generation.version='2';const before=JSON.stringify(p),hash=fp.identityHash('saved',p);
 const report=passportValidation(p);assert.equal(report.status,'passed');assert.ok(report.warnings.includes('android_client_hint_architecture'));assert.equal(JSON.stringify(p),before);assert.equal(fp.identityHash('saved',p),hash);
 assert.throws(()=>fp.localPassport({fingerprintDevicePreset:'unknown'}),/invalid_device_preset/);
});

test('Android metadata rejects inconsistent versions and missing brands',()=>{
 for(const mutate of [h=>{h.brands=[];},h=>{h.brands={};},h=>{h.fullVersionList[0].version='1.0.0.0';},h=>{h.uaFullVersion='1.0.0.0';}]){
  const p=fp.localPassport();mutate(p.fingerprint.navigator.userAgentData);
  assert.ok(passportValidation(p).errors.includes('android_browser_version'));
 }
});

test('S23 preset is selected from saved settings and reaches every browser document',async()=>{
 const {poolFixture}=await import('./helpers/pool-fixture.mjs');
 const {ensurePassport}=await import('../worker/fingerprint-service.mjs');
 const {chromium}=await import('playwright');
 const {createMobileContext,createMobilePage}=await import('../worker/profiles.mjs');
 const {inspectFirstDocuments}=await import('../worker/first-document.mjs');
 const {inspectFingerprint}=await import('../worker/fingerprint-check.mjs');
 const f=await poolFixture();let browser;
 try{
  assert.equal((await f.db.settings.findUniqueOrThrow({where:{id:1}})).fingerprintDevicePreset,'mixed');
  await f.db.settings.update({where:{id:1},data:{fingerprintMode:'local',fingerprintDevicePreset:'s23_android14'}});
  const row=await f.db.profile.create({data:{name:'Reference fixture'}});
  const p=await ensurePassport({prisma:f.db,profileId:row.id,proxy:f.proxy});
  assert.equal(p.fingerprint.navigator.userAgentData.platformVersion,'14.0.0');
  assert.equal(p.fingerprint.navigator.userAgentData.model,'SM-S911B');
  browser=await chromium.launch({headless:true,executablePath:process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH});
  fp.chromeMetadata(p.fingerprint,p.headers,browser.version(),'SM-S911B','14.0.0');
  const profile=fp.profileFromPassport(row.id,p),context=await createMobileContext(browser,profile);
  try{
   const page=await createMobilePage(context,profile),documents=await inspectFirstDocuments(page,profile);
   assert.equal(documents.status,'passed',JSON.stringify(documents));assert.equal(documents.records.length,5);
   const measured=await inspectFingerprint(page,profile,undefined,browser.version());
   assert.equal(measured.status,'passed',JSON.stringify(measured));
   assert.deepEqual(measured.observed.mediaQueries,{pointerCoarse:true,hoverNone:true,anyPointerCoarse:true});
  }finally{await context.close();}
 }finally{await browser?.close();await f.cleanup();}
});
