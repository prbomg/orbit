import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import fp from '../utils/fingerprint.js';
import { createMobileContext, createMobilePage } from '../worker/profiles.mjs';
import { inspectFingerprint, verifyFingerprint } from '../worker/fingerprint-check.mjs';
import { ensurePassport } from '../worker/fingerprint-service.mjs';
import { mobileProxyFingerprint } from '../worker/fingerprint-provider.mjs';
import { poolFixture } from './helpers/pool-fixture.mjs';
const providerSample = { status:'ok', score:100, profile:{ os:'android',browser:'chrome',browser_version:'153.0.0.0',navigator:{language:'ru-RU',hardwareConcurrency:8,deviceMemory:8,maxTouchPoints:5,userAgentData:{model:'SM-S911B',platformVersion:'13.0.0'}},screen:{width:360,height:780,pixelRatio:3},webgl:{vendor:'Qualcomm',renderer:'Adreno (TM) 740'},fonts:['Roboto','Noto Sans'],timezone:{name:'Europe/Moscow'},audio:{contextHash:'provider-value'},canvas:{noiseSeed:1},_meta:{version:'2.0'}} };
test('local generator creates distinct stable passports with coherent device families',()=>{
 const rows=Array.from({length:100},()=>fp.localPassport({fingerprintMode:'local'}));
 assert.equal(new Set(rows.map(fp.digest)).size,100);assert.equal(new Set(rows.map(p=>p.seed)).size,100);
 for(const p of rows){assert.equal(p.resolved,true);assert.equal(p.headers['user-agent'],p.fingerprint.navigator.userAgent);assert.equal(p.fingerprint.navigator.userAgentData.platform,'Android');assert.ok(p.fingerprint.navigator.deviceMemory<=8);assert.ok(p.fingerprint.screen.width<p.fingerprint.screen.height);assert.equal(fp.digest(p),fp.digest(JSON.parse(JSON.stringify(p))));}
});
test('provider adapter validates response and does not import secrets or spoof supplied audio hash',()=>{
 const base=fp.localPassport();const adapted=fp.mobileProxyPassport(base,providerSample);assert.equal(adapted.source,'mobileproxy');assert.equal(adapted.canvasSeed,base.canvasSeed);assert.equal(adapted.providerAudioHash,'provider-value');assert.equal(adapted.fingerprint.navigator.userAgentData.brands[0].version,'153');
 assert.throws(()=>fp.mobileProxyPassport(base,{...providerSample,profile:{...providerSample.profile,os:'ios'}}));
 assert.throws(()=>fp.mobileProxyPassport(base,{...providerSample,profile:{...providerSample.profile,screen:{width:99999,height:780,pixelRatio:3}}}));
});
test('official API uses Bearer and owned proxy ID; passwords never enter URL; errors are sanitized',async()=>{
 const urls=[];const token='test-secret';const proxy={host:'192.0.2.99',port:8080,username:'fixture',password:'private-password'};
 const fetchImpl=async(url,options)=>{urls.push(String(url));assert.equal(options.headers.Authorization,`Bearer ${token}`);assert.equal(options.redirect,'error');return new Response(JSON.stringify(url.searchParams.get('command')==='get_my_proxy'?[{proxy_id:123,proxy_host_ip:proxy.host,proxy_http_port:8080,proxy_login:'fixture',proxy_pass:'ignored'}]:providerSample));};
 assert.equal((await mobileProxyFingerprint({passport:fp.localPassport(),proxy,token,fetchImpl})).source,'mobileproxy');assert.match(urls[1],/proxy_id=123/);assert.ok(urls.every(u=>!u.includes(token)&&!u.includes(proxy.password)));
 await assert.rejects(mobileProxyFingerprint({passport:fp.localPassport(),proxy,token:'other',fetchImpl:async()=>{throw new Error('private-password');}}),e=>e.code==='mobileproxy_unavailable'&&!e.message.includes('private-password'));
});
test('cancelling one profile does not abort another profile sharing the provider proxy-list request',async()=>{
 const controller=new AbortController(),proxy={host:'192.0.2.101',port:8080,username:'shared-fixture'};
 let releaseList,started,listCalls=0;
 const listStarted=new Promise(resolve=>{started=resolve;});
 const fetchImpl=async(url,{signal})=>{
  if(url.searchParams.get('command')==='get_my_proxy'){
   listCalls++;started();
   await new Promise((resolve,reject)=>{releaseList=resolve;signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});
   return Response.json([{proxy_id:321,proxy_host_ip:proxy.host,proxy_http_port:proxy.port,proxy_login:proxy.username}]);
  }
  return Response.json(providerSample);
 };
 const options={passport:fp.localPassport(),proxy,token:'cancelled-shared-provider-fixture',fetchImpl};
 const first=mobileProxyFingerprint({...options,signal:controller.signal});
 const aborted=assert.rejects(first,{name:'AbortError'});
 await listStarted;
 const second=mobileProxyFingerprint(options).then(value=>({value}),error=>({error}));
 controller.abort();await aborted;releaseList();
 const result=await second;
 assert.equal(result.error,undefined);assert.equal(result.value.source,'mobileproxy');assert.equal(listCalls,1);
});

test('auto fallback persists identity across failures; strict provider does not silently fall back; legacy identity stays intact',async()=>{
 const f=await poolFixture();try{
  const p=await f.db.profile.create({data:{name:'New'}});let calls=0;const provider=async()=>{calls++;const e=new Error();e.code='mobileproxy_unavailable';throw e;};
  const first=await ensurePassport({prisma:f.db,profileId:p.id,proxy:f.proxy,provider});assert.equal(first.source,'local');assert.equal(first.fallbackReason,'mobileproxy_unavailable');
  const second=await ensurePassport({prisma:f.db,profileId:p.id,proxy:f.proxy,provider});assert.equal(fp.identityHash(p.id,second),fp.identityHash(p.id,first));assert.deepEqual(second.fingerprint,first.fingerprint);assert.equal(calls,1);
  await f.db.settings.update({where:{id:1},data:{fingerprintMode:'mobileproxy'}});const strict=await f.db.profile.create({data:{name:'Strict'}});await assert.rejects(ensurePassport({prisma:f.db,profileId:strict.id,proxy:f.proxy,provider}));
  const legacy=await f.db.profile.create({data:{name:'Legacy'}});const file=fp.profileFromPassport(legacy.id,fp.localPassport());const adopted=await ensurePassport({prisma:f.db,profileId:legacy.id,proxy:f.proxy,existing:file,provider});assert.equal(adopted.source,'legacy');assert.deepEqual(adopted.fingerprint,file.fingerprint);
 }finally{await f.cleanup();}
});
test('real browser applies and verifies passport, with stable measured canvas and audio across contexts',async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH});try{
  const passport=fp.localPassport({fingerprintMode:'local'});fp.chromeMetadata(passport.fingerprint,passport.headers,browser.version(),passport.fingerprint.navigator.userAgentData.model,passport.fingerprint.navigator.userAgentData.platformVersion);
  const profile=fp.profileFromPassport('fixture',passport);let previous;
  for(let i=0;i<2;i++){
   const context=await createMobileContext(browser,profile);try{const page=await createMobilePage(context,profile);const result=await inspectFingerprint(page,profile,previous,browser.version());assert.equal(result.status,'passed',JSON.stringify(result));assert.ok(result.audioHash);assert.equal(result.observed.timezone,'Europe/Moscow');previous=result;}finally{await context.close();}
  }
 }finally{await browser.close();}
});
test('fingerprint migration preserves warmup queue, profile history and counters',async()=>{
 const { DatabaseSync }=await import('node:sqlite');const { migrations }=await import('./helpers/pool-fixture.mjs');const scripts=await migrations();const db=new DatabaseSync(':memory:');try{
  const index=scripts.findIndex(s=>s.includes('"fingerprintHash" TEXT'));assert.ok(index>=0);
  for(const s of scripts.slice(0,index))db.exec(s);
  db.exec(`INSERT INTO Profile(id,name,status,warmedAt) VALUES ('p','Original','ready',CURRENT_TIMESTAMP); INSERT INTO WarmupJob(id,profileId,status,updatedAt) VALUES ('w','p','completed',CURRENT_TIMESTAMP); INSERT INTO Project(id,name,websiteUrl,yandexRegionId,regionName) VALUES ('project','Project','https://example.test','213',''); INSERT INTO Task(id,profileId,projectId,currentExecutions,targetExecutions) VALUES ('task','p','project',3,10); INSERT INTO ProjectProfileUse(id,projectId,profileId,usedAt) VALUES ('use','project','p',CURRENT_TIMESTAMP); INSERT INTO Settings(id,warmupEnabled) VALUES (1,0);`);
  db.exec(scripts[index]);assert.equal(db.prepare('SELECT status FROM Profile').get().status,'ready');assert.equal(db.prepare('SELECT status FROM WarmupJob').get().status,'completed');assert.equal(db.prepare('SELECT currentExecutions FROM Task').get().currentExecutions,3);assert.ok(db.prepare('SELECT usedAt FROM ProjectProfileUse').get().usedAt);assert.equal(db.prepare('SELECT warmupEnabled FROM Settings').get().warmupEnabled,0);assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
 }finally{db.close();}
});

test('a browser mismatch blocks verification and is recorded without making the profile ready',async()=>{
 const f=await poolFixture(),b=await chromium.launch({executablePath:process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH});try{
  const row=await f.db.profile.create({data:{name:'Mismatch',status:'queued'}}),p=fp.profileFromPassport(row.id,fp.localPassport());
  const ctx=await createMobileContext(b,p);try{const page=await createMobilePage(ctx,p);const wrong=structuredClone(p);wrong.fingerprint.navigator.hardwareConcurrency=2;
   await assert.rejects(verifyFingerprint({prisma:f.db,page,profile:wrong,runtimeVersion:b.version()}),e=>e.code==='fingerprint_verification_failed');
   const saved=await f.db.profile.findUniqueOrThrow({where:{id:row.id}});assert.equal(saved.fingerprintState,'failed');assert.equal(saved.status,'queued');assert.equal(saved.fingerprintCheck.checks.cpu,false);
  }finally{await ctx.close();}
 }finally{await b.close();await f.cleanup();}
});
