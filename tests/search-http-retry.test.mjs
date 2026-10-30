import test from 'node:test';
import assert from 'node:assert/strict';
import {retryAfterMs,rateLimitDelay} from '../worker/http-retry.mjs';
import {poolFixture} from './helpers/pool-fixture.mjs';
import {claimTarget,finishClaim,prepareTargetProxy,recoverAbandoned,renewLease,leaseActive} from '../worker/pool-scheduler.mjs';
import {pollDatabase} from '../worker/runner.mjs';
import lifecycle from '../utils/taskLifecycle.js';
const expireRetry = async (db, taskId) => {
 const row = await db.task.findUnique({ where: { id: taskId } });
 await db.task.update({ where: { id: taskId }, data: { retryState: { ...row.retryState, retryAfter: new Date(Date.now() - 1).toISOString() } } });
};
import {createServer} from 'node:http';
import {chromium} from 'playwright';
import {performSearchAndClick} from '../worker/search.mjs';

test('Retry-After seconds and dates are honored; repeated limits increase the pause',()=>{
 const now=Date.parse('2026-10-12T10:00:00Z');
 assert.equal(retryAfterMs('120'),120000);
 assert.equal(retryAfterMs('Mon, 12 Oct 2026 11:00:00 GMT',now),3600000);
 for(const value of [undefined,'','bad','-1'])assert.equal(retryAfterMs(value,now),0);
 assert.equal(rateLimitDelay(1),900000);assert.equal(rateLimitDelay(3),3600000);
 assert.equal(rateLimitDelay(1,7200000),7200000);
});
test('429 without a rotation URL quarantines only its channel and retries another proxy/profile after reconnecting',async()=>{
 const f=await poolFixture();try{
  for(let i=0;i<3;i++)await f.ready();
  const task=await f.task(),other=await f.task();
  await f.db.task.updateMany({data:{searchEngine:'yandex',searchQueries:['query']}});
  const healthy=await f.db.proxy.create({data:{host:'127.0.0.2',port:8000,username:'fixture',password:'fixture'}});
  const claim=await claimTarget(f.db,task.id,'test');assert.ok(claim);
  const result=await finishClaim(f.db,claim,{errorCode:'search_rate_limited',errorType:'SearchError',retryDelayMs:7200000});
  assert.equal(result.taskStopped,false);assert.equal(result.retryState.recovery,'replace_proxy');
  const pause=await f.db.workflowLease.findUnique({where:{key:'cooldown:proxy:endpoint:127.0.0.1:8000'}});
  assert.ok(pause.expiresAt.getTime()>=Date.now()+7199000);
  await f.db.$disconnect();
  assert.equal(await claimTarget(f.db,task.id,'test'),null);
  await expireRetry(f.db,task.id);
  const next=await claimTarget(f.db,task.id,'test');assert.ok(next);
  assert.equal(next.proxy.id,healthy.id);assert.notEqual(next.task.profileId,claim.task.profileId);
  await f.db.proxy.create({data:{host:f.proxy.host,port:8002,username:'fixture',password:'fixture'}});
  assert.ok(await claimTarget(f.db,other.id,'test'));
  assert.equal((await f.db.task.findUnique({where:{id:task.id}})).status,'running');
  assert.equal(await f.db.workflowLease.count({where:{key:{startsWith:'search-rate-limit:'}}}),0);
 }finally{await f.cleanup();}
});

test('429 preserves Retry-After for a rotatable proxy while unrelated tasks remain runnable',async()=>{
 const f=await poolFixture();try{
  for(let i=0;i<3;i++)await f.ready();
  await f.db.proxy.update({where:{id:f.proxy.id},data:{rotationUrl:'https://rotation.test/affected'}});
  const proxy=await f.db.proxy.create({data:{host:f.proxy.host,port:8001,username:'fixture',password:'fixture',rotationUrl:'https://rotation.test/replacement'}});
  const task=await f.task(),other=await f.task();
  await f.db.task.updateMany({data:{searchEngine:'yandex',searchQueries:['query']}});
  const first=await claimTarget(f.db,task.id,'test');assert.ok(first);
  await prepareTargetProxy(f.db,first,{shouldContinue:async()=>true},async()=>{});
  const result=await finishClaim(f.db,first,{errorCode:'search_rate_limited',errorType:'SearchError',retryDelayMs:7200000});
  assert.equal(result.retryState.recovery,'replace_proxy');assert.ok(Date.parse(result.retryState.retryAfter)>=Date.now()+7199000);
  await f.db.$disconnect();
  assert.equal(await claimTarget(f.db,task.id,'test'),null);
  await expireRetry(f.db,task.id);
  const next=await claimTarget(f.db,task.id,'test');assert.ok(next);
  assert.notEqual(next.proxy.id,first.proxy.id);assert.notEqual(next.task.profileId,first.task.profileId);
  let rotations=0;
  await prepareTargetProxy(f.db,next,{proxy:next.proxy,shouldContinue:async()=>true},async options=>{
   rotations++;assert.equal(options.proxy.rotationUrl,proxy.rotationUrl);
  });
  assert.equal(rotations,1);
  assert.ok(await claimTarget(f.db,other.id,'test'));
  assert.equal((await f.db.task.findUnique({where:{id:task.id}})).currentExecutions,0);
 }finally{await f.cleanup();}
});

test('429 drains shared sessions before rotation, blocks late joiners and keeps the drain on renewal',async()=>{
 const f=await poolFixture();try{
  for(let i=0;i<5;i++)await f.ready();
  await f.db.proxy.update({where:{id:f.proxy.id},data:{rotationUrl:'https://rotation.test/affected'}});
  const task=await f.task(f.project.id,4);await f.db.task.update({where:{id:task.id},data:{concurrency:3}});
  const a=await claimTarget(f.db,task.id,'test'),b=await claimTarget(f.db,task.id,'test');
  let rotations=0;const prepare=claim=>prepareTargetProxy(f.db,claim,{shouldContinue:async()=>true},async()=>{rotations++});
  await prepare(a);await prepare(b);assert.equal(rotations,1);
  await finishClaim(f.db,a,{errorCode:'search_rate_limited',errorType:'SearchError'});
  assert.equal(await claimTarget(f.db,task.id,'test'),null);
  assert.equal(await leaseActive(f.db,b),true);assert.equal(await renewLease(f.db,b),true);
  assert.ok((await f.db.workflowLease.findMany({where:{key:{in:b.sharedProxy.gateKeys}}})).every(gate=>gate.owner.startsWith('draining:')));
  await assert.rejects(prepare(b),error=>error.name==='TaskStoppedError');
  assert.equal(rotations,1);
  await finishClaim(f.db,b,{errorCode:'search_rate_limited',errorType:'SearchError'});
  await f.db.proxy.create({data:{host:f.proxy.host,port:8001,username:'fixture',password:'fixture',rotationUrl:'https://rotation.test/replacement'}});
  assert.equal(await claimTarget(f.db,task.id,'test'),null);
  await expireRetry(f.db,task.id);
  const next=await claimTarget(f.db,task.id,'test');assert.ok(next);
  assert.ok(![a.task.profileId,b.task.profileId].includes(next.task.profileId));
  assert.equal(next.task.retryState.count,2);
  assert.notEqual(next.sharedProxy.groupId,a.sharedProxy.groupId);
  await prepare(next);assert.equal(rotations,2);
 }finally{await f.cleanup();}
});

test('legacy persisted 429 pause upgrades without losing its deadline or counters',async()=>{
 const f=await poolFixture();try{
  const profile=await f.ready();await f.ready();
  await f.db.proxy.update({where:{id:f.proxy.id},data:{rotationUrl:'https://rotation.test/affected'}});
  const task=await f.task(f.project.id,10);
  await f.db.task.update({where:{id:task.id},data:{currentExecutions:3,searchEngine:'yandex',retryState:{key:'SearchError:search_rate_limited:',code:'search_rate_limited',type:'SearchError',count:2,lastProfileId:profile.id,lastProxyId:f.proxy.id,retryAfter:new Date(Date.now()+7200000).toISOString()}}});
  await f.db.workflowLease.create({data:{key:'search-rate-limit:yandex',owner:'search-rate-limit',expiresAt:new Date(Date.now()+7200000)}});
  await recoverAbandoned(f.db);
  await f.db.proxy.create({data:{host:f.proxy.host,port:8001,username:'fixture',password:'fixture'}});
  assert.equal(await claimTarget(f.db,task.id,'test'),null);
  const paused=await f.db.task.findUnique({where:{id:task.id}});
  assert.ok(Date.parse(paused.retryState.retryAfter)>=Date.now()+7199000);
  await expireRetry(f.db,task.id);
  const claim=await claimTarget(f.db,task.id,'test');assert.ok(claim);assert.notEqual(claim.task.profileId,profile.id);
  const row=await f.db.task.findUnique({where:{id:task.id}});
  assert.equal(row.retryState.recovery,'replace_proxy');assert.equal(row.retryState.count,2);assert.equal(row.currentExecutions,3);
  assert.equal(await f.db.workflowLease.count({where:{key:'search-rate-limit:yandex'}}),0);
 }finally{await f.cleanup();}
});

test('adding a rotation URL does not allow reuse of the failed proxy',async()=>{
 const f=await poolFixture();try{
  await f.ready();await f.ready();const task=await f.task();
  const first=await claimTarget(f.db,task.id,'test');
  await finishClaim(f.db,first,{errorCode:'search_rate_limited',errorType:'SearchError'});
  assert.equal(await claimTarget(f.db,task.id,'test'),null);
  await f.db.proxy.update({where:{id:f.proxy.id},data:{rotationUrl:'https://rotation.test/affected'}});
  assert.equal(await claimTarget(f.db,task.id,'test'),null);
  await f.db.proxy.create({data:{host:f.proxy.host,port:8001,username:'fixture',password:'fixture'}});
  assert.equal(await claimTarget(f.db,task.id,'test'),null);
  await expireRetry(f.db,task.id);
  const next=await claimTarget(f.db,task.id,'test');assert.ok(next);assert.notEqual(next.proxy.id,first.proxy.id);
 }finally{await f.cleanup();}
});

test('a paused task or missing fresh profile cannot trigger recovery rotation',async()=>{
 const f=await poolFixture();try{
  await f.ready();await f.db.proxy.update({where:{id:f.proxy.id},data:{rotationUrl:'https://rotation.test/affected'}});
  const task=await f.task(),first=await claimTarget(f.db,task.id,'test');
  await finishClaim(f.db,first,{errorCode:'search_rate_limited',errorType:'SearchError'});
  assert.equal(await claimTarget(f.db,task.id,'test'),null);
  await f.ready();await f.db.task.update({where:{id:task.id},data:{status:'paused'}});
  assert.equal(await claimTarget(f.db,task.id,'test'),null);
 }finally{await f.cleanup();}
});

test('rejected rotation leaves the cohort unprepared and prevents the retry search',async()=>{
 const f=await poolFixture();const server=createServer((req,res)=>{res.writeHead(503);res.end();});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  await f.ready();await f.ready();
  await f.db.proxy.update({where:{id:f.proxy.id},data:{rotationUrl:`http://127.0.0.1:${server.address().port}/affected`}});
  const task=await f.task(),first=await claimTarget(f.db,task.id,'test');
  await finishClaim(f.db,first,{errorCode:'search_rate_limited',errorType:'SearchError'});
  await f.db.proxy.create({data:{host:f.proxy.host,port:8001,username:'fixture',password:'fixture',rotationUrl:`http://127.0.0.1:${server.address().port}/replacement`}});
  await expireRetry(f.db,task.id);
  const next=await claimTarget(f.db,task.id,'test');
  await assert.rejects(prepareTargetProxy(f.db,next,{proxy:next.proxy,config:{rotationTimeoutMs:1000},shouldContinue:async()=>true,log:()=>{}}),error=>error.code==='http_503');
  assert.ok((await f.db.workflowLease.findMany({where:{key:{in:next.sharedProxy.gateKeys}}})).every(gate=>gate.owner.startsWith('preparing:')));
  assert.equal((await f.db.task.findUnique({where:{id:task.id}})).currentExecutions,0);
 }finally{await new Promise(resolve=>server.close(resolve));await f.cleanup();}
});

test('five repeated 429s stop only the failing task without counting a visit',async()=>{
 const f=await poolFixture();try{
  for(let i=0;i<6;i++)await f.ready();
  await f.db.proxy.update({where:{id:f.proxy.id},data:{rotationUrl:'https://rotation.test/affected'}});
  await f.db.proxy.create({data:{host:f.proxy.host,port:8001,username:'fixture',password:'fixture',rotationUrl:'https://rotation.test/replacement'}});
  const task=await f.task();
  for(let count=1;count<=5;count++){
   await expireRetry(f.db,task.id);
   const claim=await claimTarget(f.db,task.id,'test');assert.ok(claim);
   const result=await finishClaim(f.db,claim,{errorCode:'search_rate_limited',errorType:'SearchError'});
   assert.equal(result.retryState.count,count);assert.equal(result.taskStopped,count===5);
  }
  const row=await f.db.task.findUnique({where:{id:task.id}});assert.equal(row.status,'failed');assert.equal(row.currentExecutions,0);
  assert.ok(await claimTarget(f.db,(await f.task()).id,'test'));
 }finally{await f.cleanup();}
});

test('runner prepares the replacement proxy before retrying with a new profile', {timeout:30000}, async()=>{
 const f=await poolFixture();let requests=0;const paths=[];
 const server=createServer((req,res)=>{requests++;paths.push(req.url);res.end('OK');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  await f.ready();await f.ready();
  await f.db.proxy.update({where:{id:f.proxy.id},data:{rotationUrl:`http://127.0.0.1:${server.address().port}/affected`}});
  await f.db.proxy.create({data:{host:f.proxy.host,port:8001,username:'fixture',password:'fixture',rotationUrl:`http://127.0.0.1:${server.address().port}/replacement`}});
  const task=await f.task(), attempts=[], events=[];
  const controller=new AbortController();
  const runnerOptions={prisma:f.db,config:{projectId:f.project.id,cooldownMs:60000,pollMs:1,rotationTimeoutMs:1000},signal:controller.signal,
   log:(event,data)=>{events.push({event,...data});if(event==='search_rate_limit_replace')controller.abort();},runTaskRunner:async({task,proxy,prepareProxy,beforeTargetVisit,signal,config,checkActive,log})=>{
    attempts.push({profileId:task.profileId,proxyId:proxy.id});
    if(attempts.length===1){const error=new Error('Limited');error.name='SearchError';error.code='search_rate_limited';error.retryDelayMs=7200000;throw error;}
    await prepareProxy({proxy,config,signal,shouldContinue:checkActive,log});
    assert.equal(requests,1);await beforeTargetVisit();
    return (await f.db.$transaction(tx=>lifecycle.commitTaskExecution(tx,{taskId:task.id,profileId:task.profileId,executionId:task.executionId}))).count===1;
   }};
  await pollDatabase(runnerOptions);
  assert.equal(attempts.length,1);assert.equal(requests,0);
  assert.ok(events.some(e=>e.event==='search_rate_limit_replace'&&e.durationMs>=7199000));
  assert.equal(await claimTarget(f.db,task.id,'test'),null);
  await expireRetry(f.db,task.id);
  const result=await pollDatabase({...runnerOptions,signal:new AbortController().signal});
  assert.equal(result,0);assert.deepEqual(paths,['/replacement']);assert.equal(attempts.length,2);
  assert.notEqual(attempts[0].profileId,attempts[1].profileId);assert.notEqual(attempts[0].proxyId,attempts[1].proxyId);
  assert.ok(events.some(e=>e.event==='search_rate_limit_replace'));
  const row=await f.db.task.findUnique({where:{id:task.id}});assert.equal(row.status,'completed');assert.equal(row.currentExecutions,1);
 }finally{await new Promise(resolve=>server.close(resolve));await f.cleanup();}
});
for (const status of [429, 403]) test(`browser surfaces HTTP ${status} even when a preceding check handled a challenge`,async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});try{
  const page=await browser.newPage(),events=[];
  await page.route('http://search.test/**',route=>route.fulfill({status,headers:{'Retry-After':'1800'},body:'Request rejected'}));
  await assert.rejects(performSearchAndClick(page,{id:'test',searchEngine:'yandex',searchQueries:['test'],vitalPhrases:[],targetDomain:'target.test'},
   {engines:{yandex:{home:'http://search.test/',domains:['search.test']}},createCheckCaptcha:()=>async()=>true,log:(event,data)=>events.push({event,...data})}),e=>e.code===(status===429?'search_rate_limited':'search_http_error')&&e.httpStatus===status&&e.retryDelayMs===(status===429?1800000:0));
  assert.ok(events.some(e=>e.event==='search_http_failed'&&e.status===status));
 }finally{await browser.close();}
});


test('a parallel 429 cannot shorten the previous Retry-After deadline', async () => {
 const f = await poolFixture(); try {
  await f.ready(); await f.ready();
  const task = await f.task(f.project.id, 3);
  await f.db.task.update({ where: { id: task.id }, data: { concurrency: 2 } });
  await f.db.proxy.update({ where: { id: f.proxy.id }, data: { rotationUrl: 'https://rotation.test/fixture' } });
  const a = await claimTarget(f.db, task.id, 'test'), b = await claimTarget(f.db, task.id, 'test');
  assert.ok(a); assert.ok(b);
  const first = await finishClaim(f.db, a, { errorCode: 'search_rate_limited', errorType: 'SearchError', retryDelayMs: 7200000 });
  const second = await finishClaim(f.db, b, { errorCode: 'search_rate_limited', errorType: 'SearchError', retryDelayMs: 60000 });
  assert.ok(Date.parse(second.retryState.retryAfter) >= Date.parse(first.retryState.retryAfter));
 } finally { await f.cleanup(); }
});
