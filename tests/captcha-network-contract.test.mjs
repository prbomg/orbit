import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { performSearchAndClick } from '../worker/search.mjs';
import { installSearchFixture } from './fixtures/search-pages.mjs';
import { poolFixture } from './helpers/pool-fixture.mjs';
import { claimTarget, finishClaim } from '../worker/pool-scheduler.mjs';

for(const status of [200,429])test(`mock captcha completion verifies the resulting document (${status})`,async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH});
 try {
  const context=await browser.newContext(),page=await context.newPage(),events=[];
  if(status===200)await installSearchFixture(context,{targetPage:null,noNext:true});
  else await context.route('**/*',route=>route.fulfill({status,headers:{'Retry-After':'1800'},body:'Limited'}));
  let clock=0;
  const work=performSearchAndClick(page,{id:'mock-captcha',searchEngine:'yandex',searchQueries:['qa'],vitalPhrases:[],targetDomain:'target.test'}, {
   engines:{yandex:{home:'http://search.test/',domains:['search.test']}},navigationTimeoutMs:3000,
   createCheckCaptcha:()=>async()=>true,waitFor:async ms=>{clock+=ms;},now:()=>clock,
   log:(event,details)=>events.push({event,...details}),
  });
  if(status===429)await assert.rejects(work,error=>error.code==='search_rate_limited'&&error.retryDelayMs===1800000);
  else assert.equal((await work).found,false);
  assert.ok(events.some(e=>e.event===(status===200?'captcha_document_verified':'captcha_document_failed')&&e.status===status));
 }finally{await browser.close();}
});
test('rate-limit recovery retains the original saved profile while assigning a replacement',async()=>{
 const f=await poolFixture();try{
  const original=await f.ready();await f.ready();
  await f.db.proxy.create({data:{host:'127.0.0.2',port:8000,username:'fixture',password:'fixture'}});
  const task=await f.task();const claim=await claimTarget(f.db,task.id,'fixture');assert.ok(claim);
  const before=await f.db.profile.findUnique({where:{id:claim.task.profileId}});
  await finishClaim(f.db,claim,{errorCode:'search_rate_limited',errorType:'SearchError',retryDelayMs:1000});
  const paused=await f.db.task.findUnique({where:{id:task.id}});
  await f.db.task.update({where:{id:task.id},data:{retryState:{...paused.retryState,retryAfter:new Date(0).toISOString()}}});
  const next=await claimTarget(f.db,task.id,'fixture');assert.ok(next);
  const after=await f.db.profile.findUnique({where:{id:claim.task.profileId}});
  assert.equal(after.snapshotId,before.snapshotId);assert.deepEqual(after.sessionCheck,before.sessionCheck);
  assert.notEqual(next.task.profileId,claim.task.profileId);
  assert.ok(await f.db.profile.findUnique({where:{id:original.id}}));
 }finally{await f.cleanup();}
});
