import {mobileProfileFixture} from './helpers/mobile-profile-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,mkdir,open} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {poolFixture} from './helpers/pool-fixture.mjs';
import {reserveDonor,finishDonor,availableDonors} from '../worker/donor-health.mjs';
import {ensurePassport} from '../worker/fingerprint-service.mjs';
import {passportValidation} from '../worker/passport-validation.mjs';
import fp from '../utils/fingerprint.js';
import {stageMobileProfile,loadMobileProfile,createMobileContext} from '../worker/profiles.mjs';
import {preparePersistentProfile} from '../worker/persistent-profile.mjs';
import {verifySessionAfterRestart} from '../worker/session-restart-check.mjs';
import {chromium} from 'playwright-extra';
const launchOptions={headless:true,executablePath:process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH};

test('donor reservations limit site/channel concurrency; 429 survives reconnect and respects Retry-After',async()=>{
 const f=await poolFixture();try{
  const p2={...f.proxy,host:'second.test'},p3={...f.proxy,host:'third.test'},url='https://donor.example/';
  const [a,b]=await Promise.all([reserveDonor(f.db,f.proxy,url),reserveDonor(f.db,p2,url)]);assert(a&&b);
  assert.equal(await reserveDonor(f.db,p3,url),null);assert.equal(await reserveDonor(f.db,{...f.proxy,id:'alias'},url),null);
  const health=await finishDonor(f.db,a,{reason:'site_rate_limited',status:429,retryAfter:'7200'});
  assert(+health.cooldownUntil>=Date.now()+7199000);
  await finishDonor(f.db,b,{success:true,status:200});
  await f.db.$disconnect();assert.deepEqual(await availableDonors(f.db,p3,[url]),[]);assert.equal(await reserveDonor(f.db,p3,url),null);
  const later=new Date(Date.now()+7201000),c=await reserveDonor(f.db,f.proxy,url,later);assert(c);
  const second=await finishDonor(f.db,c,{reason:'navigation_timeout'},later);assert.equal(+second.cooldownUntil-+later,1800000);
  const after=new Date(+second.cooldownUntil+1),d=await reserveDonor(f.db,f.proxy,url,after);assert(d);
  await finishDonor(f.db,d,{success:true,status:200},after);
  const saved=await f.db.warmupSiteHealth.findFirst({where:{domain:'donor.example',channelLabel:f.proxy.host}});assert.equal(saved.consecutiveFailures,0);assert.equal(saved.cooldownUntil,null);assert.equal(saved.failure,2);
 }finally{await f.cleanup();}
});
test('passport preflight rejects contradictions and caches missing provider bindings across profiles',async()=>{
 const f=await poolFixture();try{
  const valid=fp.localPassport();assert.equal(valid.generation.version,'6');assert.equal(passportValidation(valid).status,'passed');
  const invalid=structuredClone(valid);invalid.headers['user-agent']='wrong';assert(passportValidation(invalid).errors.includes('passport_user_agent'));
  let calls=0;const provider=async()=>{calls++;const e=new Error();e.code='mobileproxy_proxy_not_found';throw e;};
  for(let i=0;i<2;i++){
   const row=await f.db.profile.create({data:{name:'Binding'}});
   const passport=await ensurePassport({prisma:f.db,profileId:row.id,proxy:f.proxy,provider});assert.equal(passport.fallbackReason,'mobileproxy_proxy_not_found');assert.equal(passport.validation.status,'passed');
  }
  assert.equal(calls,1);
  const row=await f.db.profile.create({data:{name:'Edited channel'}});
  await ensurePassport({prisma:f.db,profileId:row.id,proxy:{...f.proxy,host:'changed.test'},provider});assert.equal(calls,2);
 }finally{await f.cleanup();}
});
test('snapshot checksum catches data loss; publication keeps the preceding good version',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'orbit-snapshots-'));try{
  const profile=mobileProfileFixture('backup-profile');
  const save=async value=>{const s=await stageMobileProfile(dir,profile,{storageState:async()=>({cookies:[],origins:[{origin:'https://example.test',localStorage:[{name:'state',value}]}]})});await s.publish();return s.snapshot;};
  const first=await save('first'),second=await save('second');assert.notEqual(first.snapshot.id,second.snapshot.id);
  assert.equal(JSON.parse(await readFile(join(dir,'backup-profile.json.previous'),'utf8')).snapshot.id,first.snapshot.id);
  const altered=structuredClone(second);altered.origins[0].localStorage[0].value='lost';await writeFile(join(dir,'backup-profile.json'),JSON.stringify(altered));
  await assert.rejects(loadMobileProfile(dir,'backup-profile'),e=>e.code==='profile_snapshot_mismatch');
  assert.equal(JSON.parse(await readFile(join(dir,'backup-profile.json.previous'),'utf8')).origins[0].localStorage[0].value,'first');
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('fresh Chromium process verifies snapshot storage, including IndexedDB, without external requests',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'orbit-process-check-'));let browser;try{
  browser=await chromium.launch(launchOptions);const profile=mobileProfileFixture('restarted-profile'),context=await createMobileContext(browser,profile),page=await context.newPage();
  await page.route('https://storage.test/**',r=>r.fulfill({body:'<html>Storage fixture</html>',contentType:'text/html'}));await page.goto('https://storage.test/');
  await page.evaluate(async()=>{localStorage.setItem('saved','yes');await new Promise((resolve,reject)=>{const request=indexedDB.open('fixture',1);request.onupgradeneeded=()=>request.result.createObjectStore('records');request.onerror=reject;request.onsuccess=()=>{const tx=request.result.transaction('records','readwrite');tx.objectStore('records').put({id:1},'record');tx.oncomplete=()=>{request.result.close();resolve();};};});});
  const staged=await stageMobileProfile(dir,profile,context);await context.close();await browser.close();browser=null;
  const report=await verifySessionAfterRestart(staged,{launchOptions});assert.equal(report.status,'passed');assert.equal(report.processRestartVerified,true);assert.equal(report.sourceSnapshotId,staged.snapshot.snapshot.id);assert.equal(report.indexedDBRecordsCount,1);await staged.discard();
 }finally{await browser?.close();await rm(dir,{recursive:true,force:true});}
});
test('persistent cleanup retains current HTTP/code caches and a cacheless previous native directory',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'orbit-persistent-backup-'));try{
  const first=await preparePersistentProfile(dir,'persistent');await mkdir(join(first.path,'Default','Cache'),{recursive:true});const cache=await open(join(first.path,'Default','Cache','large'),'w');await cache.truncate(101000000);await cache.close();
  await mkdir(join(first.path,'Default','Code Cache'),{recursive:true});await writeFile(join(first.path,'Default','Code Cache','compiled-script'),'retained');
  await mkdir(join(first.path,'ShaderCache'),{recursive:true});await writeFile(join(first.path,'ShaderCache','junk'),'disposable');
  await writeFile(join(first.path,'Default','Cookies'),'kept');await first.publish('first','first-id');
  const second=await preparePersistentProfile(dir,'persistent');const retainedCache=await open(join(second.path,'Default','Cache','large'),'r');try{assert.equal((await retainedCache.stat()).size,101000000);}finally{await retainedCache.close();}assert.equal(await readFile(join(second.path,'Default','Code Cache','compiled-script'),'utf8'),'retained');await assert.rejects(readFile(join(second.path,'ShaderCache','junk')),e=>e.code==='ENOENT');assert.equal(second.snapshotId,'first-id');assert.equal(await readFile(join(second.path,'Default','Cookies'),'utf8'),'kept');await writeFile(join(second.path,'Default','Cookies'),'next');await second.publish('second','second-id');
  assert.equal(await readFile(join(dir,'browser-data','persistent','previous','Default','Cookies'),'utf8'),'kept');
  for(const name of ['Cache','Code Cache']){await assert.rejects(readFile(join(dir,'browser-data','persistent','previous','Default',name,name==='Cache'?'large':'compiled-script')),e=>e.code==='ENOENT');}
  assert.equal(await readFile(join(dir,'browser-data','persistent','current','Default','Code Cache','compiled-script'),'utf8'),'retained');
  const oversized=await preparePersistentProfile(dir,'persistent'),large=await open(join(oversized.path,'useful-data'),'w');await large.truncate(101000000);await large.close();await assert.rejects(oversized.publish('bad','bad-id'),e=>e.code==='profile_browser_storage_limit');await oversized.discard();
  assert.equal(await readFile(join(dir,'browser-data','persistent','current','.orbit-snapshot-id'),'utf8'),'second-id');
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('persistent restart detects missing durable cookies instead of masking them with the snapshot',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'orbit-persistent-verify-'));let browser,context;try{
  const persistent=await preparePersistentProfile(dir,'persistent-check'),profile=mobileProfileFixture('persistent-check');
  context=await chromium.launchPersistentContext(persistent.path,{...launchOptions});browser=context.browser();await createMobileContext(browser,profile,undefined,context,true);
  await context.addCookies([{name:'durable',value:'kept',domain:'example.test',path:'/',expires:Date.now()/1000+3600,secure:true,httpOnly:true,sameSite:'Lax'},{name:'session',value:'kept',domain:'example.test',path:'/',expires:-1,secure:true,httpOnly:true,sameSite:'Lax'}]);
  const staged=await stageMobileProfile(dir,profile,context,{storageMode:'persistent'});
  await context.close();await browser.close();context=null;browser=null;
  const valid=await verifySessionAfterRestart(staged,{launchOptions,persistentPath:persistent.path});assert.equal(valid.status,'passed');assert.equal(valid.sessionCookiesRestored,1);
  context=await chromium.launchPersistentContext(persistent.path,launchOptions);await context.clearCookies();await context.close();context=null;
  await assert.rejects(verifySessionAfterRestart(staged,{launchOptions,persistentPath:persistent.path}),e=>e.code==='profile_session_verification_failed'&&e.diagnostics.missingCookies===1);
  await staged.discard();await persistent.discard();
 }finally{await context?.close();await browser?.close();await rm(dir,{recursive:true,force:true});}
});

test('passport identity is independent of JSON key ordering and validation timestamps',()=>{
 const p=fp.localPassport();const original=fp.identityHash('same',p);
 const reverse=value=>Array.isArray(value)?value.map(reverse):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).reverse().map(key=>[key,reverse(value[key])])):value;
 assert.equal(fp.identityHash('same',reverse(p)),original);
 assert.equal(fp.identityHash('same',{...p,validation:{checkedAt:new Date().toISOString()}}),original);
 assert.notEqual(fp.identityHash('other',p),original);
});
