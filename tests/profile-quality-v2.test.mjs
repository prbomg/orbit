import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import fp from '../utils/fingerprint.js';
import plans from '../utils/warmupPlan.js';
import stats from '../utils/warmupStats.js';
import catalog from '../utils/deviceCatalog.js';
import { assessVisit } from '../worker/warmup-quality.mjs';
import { qualificationContext } from '../worker/qualification-context.mjs';
import { qualifyBrowser } from '../worker/browser-qualification.mjs';
import { performWarmup } from '../worker/warmup.mjs';
import { poolFixture } from './helpers/pool-fixture.mjs';
const launch=()=>chromium.launch({headless:true,executablePath:process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH});

test('full profile identity reproduces across processes, with documented frozen source',()=>{
 const seed='00112233445566778899aabbccddeeff';
 const passport=fp.localPassport({fingerprintMode:'local'},{seed});
 const hash=fp.identityHash('replay',passport);
 for(let i=0;i<5;i++)assert.equal(fp.identityHash('replay',fp.localPassport({fingerprintMode:'local'},{seed})),hash);
 const child=execFileSync(process.execPath,['-e',`const fp=require('./utils/fingerprint.js');process.stdout.write(fp.identityHash('replay',fp.localPassport({fingerprintMode:'local'},{seed:'${seed}'})));`],{encoding:'utf8'});
 assert.equal(child,hash);assert.equal(passport.generation.baseSample.hash.length,64);assert(passport.generation.baseSample.generatorVersion);
 assert.notEqual(fp.identityHash('replay',fp.localPassport({},{seed:'11112233445566778899aabbccddeeff'})),hash);
});
test('quality requires observable content and requested results, short pages are valid',()=>{
 assert.equal(assessVisit({content:true}).quality,'partial');
 assert.equal(assessVisit({content:true,shortPage:true}).quality,'passed');
 assert.equal(assessVisit({content:true,movedPixels:42}).quality,'passed');
 assert.equal(assessVisit({content:false,movedPixels:42,linkResult:'url_changed'}).quality,'partial');
 assert.equal(assessVisit({requirements:'navigation',content:true,shortPage:true}).quality,'partial');
 assert.equal(assessVisit({requirements:'navigation',content:true,linkResult:'content_changed'}).quality,'passed');
 assert.equal(assessVisit({requirements:'return',content:true,returned:false}).quality,'partial');
 assert.equal(assessVisit({requirements:'return',content:true,returned:true}).quality,'passed');
});
test('plans snapshot goals, keep legacy timing and produce appropriate execution requirements',()=>{
 for(const preset of Object.keys(plans.presets)){const p=plans.createPlan({warmupPlanPreset:preset});assert(plans.validPlan(p));assert.equal(plans.executionOptions(p).requiredSites,p.sitesPerSession);assert.deepEqual(plans.planFor({plan:p},{warmupPlanPreset:'storage'}),p);}
 const old={version:1,mode:'preparation',offsetsHours:[0,8,24,36,48,72],minAgeHours:72,sessionMinutes:3,sitesPerSession:3};assert.equal(plans.planFor({plan:old}),old);
 assert.equal(plans.executionOptions(plans.createPlan({warmupPlanPreset:'revisit'}),1).requirements,'content');
 assert.equal(plans.executionOptions(plans.createPlan({warmupPlanPreset:'revisit'}),2).requirements,'return');
 assert.deepEqual(plans.createPlan().offsetsHours,old.offsetsHours);
 assert.equal(plans.validPlan({...plans.createPlan(),sitesPerSession:0}),false);
 assert.throws(()=>plans.createPlan({warmupPlanPreset:'unknown'}));
});
test('statistics respect denominators, unknown legacy metadata and unique run outcomes',()=>{
 const events=[];const add=(runId,event,details={})=>events.push({runId,event,details});
 add('one','warmup_run_context',{release:'v2',model:'s23',storageMode:'snapshot'});
 add('one','warmup_scroll',{movedPixels:0,result:'boundary'});
 add('one','warmup_link_skipped');add('one','warmup_storage_check',{result:'passed'});
 add('one','session_saved',{preparationMs:86400000});add('one','warmup_run_finished',{outcome:'passed',durationMs:1000});
 add('two','warmup_run_finished',{outcome:'failed',durationMs:3000,reason:'network'});
 add('two','warmup_storage_check',{result:'failed'});
 add('three','warmup_run_finished',{outcome:'stopped',durationMs:2000});
 add('four','warmup_run_context');
 add('one','warmup_site_partial',{domain:'fixture.test',durationMs:50});
 add('one','warmup_site_completed',{domain:'fixture.test',durationMs:100});
 const r=stats.aggregate(events),s=r.summary;
 assert.equal(s.runs,4);assert.equal(s.successRate,50);assert.equal(s.restoreRate,50);assert.equal(s.noEffectRate,50);assert.equal(s.stopped,1);assert.equal(s.unknown,1);assert.equal(s.durationSamples,3);assert.equal(s.p50Ms,2000);assert.equal(s.p95Ms,3000);assert.equal(s.preparedSamples,1);assert.equal(s.preparationP50Ms,86400000);
 assert.equal(r.domains[0].partial,1);assert.equal(r.breakdown.release.find(g=>g.value==='unknown').runs,3);
 assert.equal(stats.aggregate([]).summary.successRate,null);
});
test('qualification invalidates old cache, covers each template, and gates matching failures', {timeout:90000},async()=>{
 const f=await poolFixture(),browser=await launch();
 try{
  await f.db.browserQualification.create({data:{runtimeVersion:browser.version(),status:'passed',report:{old:true}}});
  const result=await qualifyBrowser({prisma:f.db,browser});
  assert.equal(result.report.qualification.key,qualificationContext(browser.version()).key);
  assert.deepEqual(result.report.pilots.map(p=>p.templateId).sort(),catalog.DEVICE_CATALOG.templates.map(t=>t.id).sort());
  const cached=await qualifyBrowser({prisma:f.db,browser});assert.equal(cached.report.qualification.key,result.report.qualification.key);
  await f.db.browserQualification.update({where:{runtimeVersion:browser.version()},data:{status:'failed'}});
  await assert.rejects(qualifyBrowser({prisma:f.db,browser}),{code:'browser_qualification_failed'});
  const stale={...result.report,qualification:{...result.report.qualification,key:'old-adapter'}};
  await f.db.browserQualification.update({where:{runtimeVersion:browser.version()},data:{status:'passed',report:stale}});
  const updated=await qualifyBrowser({prisma:f.db,browser});assert.notEqual(updated.report.qualification.key,'old-adapter');
 }finally{await browser.close();await f.cleanup();}
});
test('short content is accepted, empty document is not credited, and single-site plan is honored',{timeout:45000},async()=>{
 const browser=await launch();try{
  for(const populated of [true,false]){
   const context=await browser.newContext({isMobile:true,hasTouch:true,viewport:{width:390,height:844}}),page=await context.newPage(),events=[];
   await context.route('https://fixture.test/**',route=>route.fulfill({contentType:'text/html',body:populated?'<meta name="viewport" content="width=device-width, initial-scale=1"><main>Контрольная страница для проверки сохранения состояния и результата посещения.</main>':'<html><body></body></html>'}));
   const run=performWarmup(page,{sites:['https://fixture.test/'],requiredSites:1,waitFor:async()=>{},log:(event,details)=>events.push({event,...details})});
   if(populated){await run;assert.equal(events.filter(e=>e.event==='warmup_site_completed').length,1);assert(events.some(e=>e.reason==='short_page'));}
   else{await assert.rejects(run,{code:'warmup_sites_unavailable'});assert(!events.some(e=>e.event==='warmup_site_completed'));assert(events.some(e=>e.event==='warmup_site_skipped'&&e.reason==='content_unavailable'));}
   await context.close();
  }
 }finally{await browser.close();}
});
test('storage plan does not request browsing actions and return plan requires the saved domain',{timeout:30000},async()=>{
 const browser=await launch();try{
  const context=await browser.newContext(),page=await context.newPage(),events=[];
  await context.route('https://fixture.test/**',r=>r.fulfill({contentType:'text/html',body:'<main>Storage fixture</main>'}));
  await performWarmup(page,{sites:['https://fixture.test/'],requiredSites:1,requirements:'content',waitFor:async()=>{},log:event=>events.push(event)});
  assert(events.includes('warmup_site_completed'));assert(!events.includes('warmup_scroll'));assert(!events.includes('warmup_link_skipped'));
  await assert.rejects(performWarmup(page,{sites:['https://fixture.test/'],requiredSites:1,requirements:'return',waitFor:async()=>{}}),{code:'warmup_sites_unavailable'});
  await performWarmup(page,{sites:['https://fixture.test/'],requiredSites:1,requirements:'return',preferredDomains:['fixture.test'],waitFor:async()=>{}});
  await context.close();
 }finally{await browser.close();}
});
test('local cache experiment measures the effect of routing without changing production policy',{timeout:30000},async()=>{
 let assetRequests=0;
 const server=createServer((req,res)=>{
  if(req.url==='/asset.js'){assetRequests++;res.writeHead(200,{'Content-Type':'text/javascript','Cache-Control':'public, max-age=3600'});res.end('window.fixtureAssetLoaded=true;');}
  else{res.writeHead(200,{'Content-Type':'text/html'});res.end('<script src="/asset.js"></script><main>Local cache probe</main>');}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const browser=await launch();
 try{for(const routed of [false,true]){
  const context=await browser.newContext({serviceWorkers:'block'});if(routed)await context.route('**/*',r=>r.continue());
  const page=await context.newPage(),start=assetRequests,base=`http://127.0.0.1:${server.address().port}`;
  await page.goto(base+'/first');assert(await page.evaluate(()=>window.fixtureAssetLoaded));await page.goto(base+'/second');assert(await page.evaluate(()=>window.fixtureAssetLoaded));
  assert.equal(assetRequests-start,routed?2:1);await context.close();
 }}finally{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
