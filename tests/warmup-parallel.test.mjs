import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import pool from '../utils/profilePool.js';
import journal from '../utils/warmupJournal.js';
import { poolFixture } from './helpers/pool-fixture.mjs';
import { claimWarmup, claimTarget, prepareWarmupProxy, finishClaim, leaseActive, renewLease, proxyKey } from '../worker/pool-scheduler.mjs';
import { executeWarmup } from '../worker/warmup-service.mjs';
import { TaskStoppedError } from '../worker/behavior.mjs';
import { ProxyRotationError } from '../worker/proxy-rotation.mjs';
// Scheduler-only fixtures have no browser files. Keep production .env paths
// out of these isolated database tests.
process.env.WORKER_PROFILES_DIR = '';
const options = claim => ({ proxy:claim.proxy,config:{},signal:new AbortController().signal,shouldContinue:async()=>true,log:()=>{} });

test('twelve distinct profiles share one proxy; rotation happens once and targets wait until every member finishes', async () => {
  const f=await poolFixture();const other=new PrismaClient({datasources:{db:{url:`file:${f.dir}/test.db`}}});
  try {
    await f.db.settings.update({where:{id:1},data:{warmupConcurrency:12,warmupSharedProxy:true}});
    await f.db.proxy.update({where:{id:f.proxy.id},data:{rotationUrl:'https://rotation.invalid/fixture'}});
    await f.db.$transaction(tx=>pool.createProfileBatch(tx,{count:13}));
    const claims=await Promise.all(Array.from({length:12},(_,i)=>claimWarmup(i%2?other:f.db)));
    assert.equal(claims.filter(Boolean).length,12);assert.equal(new Set(claims.map(c=>c.job.profileId)).size,12);
    assert.equal(new Set(claims.map(c=>c.sharedProxy.groupId)).size,1);assert.equal(await claimWarmup(f.db),null);
    const leader=claims.find(c=>c.owner===c.sharedProxy.groupId);let rotations=0,release,started;
    const rotating=new Promise(resolve=>{started=resolve;}),gate=new Promise(resolve=>{release=resolve;});
    const rotate=async()=>{rotations++;started();await gate;};
    let prepared=0;
    const preparation=claims.map(c=>prepareWarmupProxy(f.db,c,options(c),rotate).then(()=>prepared++));
    await rotating;assert.equal(prepared,0);release();await Promise.all(preparation);
    assert.equal(rotations,1);assert.equal(prepared,12);
    for(const claim of claims){assert.ok(await leaseActive(f.db,claim));assert.ok(await renewLease(f.db,claim));}
    await f.ready();const task=await f.task();assert.equal(await claimTarget(f.db,task.id,'target'),null);
    await finishClaim(f.db,leader,{stopped:true});assert.equal(await claimTarget(f.db,task.id,'target'),null,'leader completion must not release other members');
    assert.equal(await claimWarmup(f.db),null,'new shared-channel warmups must yield to a waiting target');
    for(const claim of claims.filter(c=>c!==leader))await finishClaim(f.db,claim,{stopped:true});
    const target=await claimTarget(f.db,task.id,'target');assert.ok(target);assert.equal(await claimWarmup(f.db),null,'target remains exclusive');
    await finishClaim(f.db,target,{stopped:true});
    assert.equal(await f.db.workflowLease.count({where:{key:{startsWith:'warmup-share:'}}}),0);
    assert.equal(await f.db.workflowLease.count({where:{key:{startsWith:'warmup-gate:'}}}),0);
  }finally{await other.$disconnect();await f.cleanup();}
});

test('aliases with identical rotation URLs share preparation, while distinct channels prepare independently',async()=>{
  const f=await poolFixture();try{
    await f.db.settings.update({where:{id:1},data:{warmupConcurrency:5,warmupSharedProxy:true}});
    await f.db.proxy.update({where:{id:f.proxy.id},data:{rotationUrl:'https://rotation.invalid/same'}});
    await f.db.proxy.create({data:{host:'127.0.0.2',port:8000,username:'fixture',password:'private',rotationUrl:'https://rotation.invalid/same'}});
    await f.db.$transaction(tx=>pool.createProfileBatch(tx,{count:5}));
    const first=await claimWarmup(f.db),second=await claimWarmup(f.db);
    assert.notEqual(first.proxy.host,second.proxy.host);assert.equal(first.sharedProxy.groupId,second.sharedProxy.groupId);
    let rotations=0;const rotate=async()=>{rotations++;};
    await Promise.all([prepareWarmupProxy(f.db,first,options(first),rotate),prepareWarmupProxy(f.db,second,options(second),rotate)]);
    assert.equal(rotations,1);
    await f.db.proxy.create({data:{host:'127.0.0.3',port:8000,username:'fixture',password:'private',rotationUrl:'https://rotation.invalid/another'}});
    const third=await claimWarmup(f.db);assert.notEqual(third.sharedProxy.groupId,first.sharedProxy.groupId);
    await prepareWarmupProxy(f.db,third,options(third),rotate);assert.equal(rotations,2);
    for(const claim of [first,second,third])await finishClaim(f.db,claim,{stopped:true});
  }finally{await f.cleanup();}
});

test('failed cohort preparation wakes followers and preserves every profile attempt budget',async()=>{
  const f=await poolFixture();try{
    await f.db.settings.update({where:{id:1},data:{warmupConcurrency:2,warmupSharedProxy:true}});
    await f.db.$transaction(tx=>pool.createProfileBatch(tx,{count:2}));
    const leader=await claimWarmup(f.db),follower=await claimWarmup(f.db);
    await assert.rejects(prepareWarmupProxy(f.db,leader,options(leader),async()=>{throw new ProxyRotationError('network');}));
    await finishClaim(f.db,leader,{proxyFailed:true,errorCode:'network'});
    await assert.rejects(prepareWarmupProxy(f.db,follower,options(follower)),error=>error.code==='proxy_shared_preparation_failed');
    await finishClaim(f.db,follower,{proxyFailed:true,errorCode:'proxy_shared_preparation_failed'});
    const jobs=await f.db.warmupJob.findMany();assert.ok(jobs.every(job=>job.attempts===0&&job.status==='retry_wait'));
    assert.equal(await claimWarmup(f.db),null,'failed channel remains on cooldown');
  }finally{await f.cleanup();}
});

test('three due continuations precede one fresh profile, without bypassing future intervals or starving new profiles',async()=>{
  const f=await poolFixture();try{
    await f.db.$transaction(tx=>pool.createProfileBatch(tx,{count:120}));
    const jobs=await f.db.warmupJob.findMany({orderBy:{createdAt:'asc'}});
    await f.db.warmupJob.updateMany({where:{id:{in:jobs.slice(100,119).map(j=>j.id)}},data:{currentStage:2,status:'waiting_stage',nextStageAt:new Date(0)}});
    await f.db.warmupJob.update({where:{id:jobs[119].id},data:{currentStage:4,status:'waiting_stage',nextStageAt:new Date(Date.now()+3600000)}});
    const sequence=[];
    for(let i=0;i<8;i++){const claim=await claimWarmup(f.db);assert.ok(claim);sequence.push(claim.job.currentStage);await finishClaim(f.db,claim,{stopped:true});}
    assert.deepEqual(sequence,[2,2,2,1,2,2,2,1]);
    assert.equal((await f.db.warmupJob.findUnique({where:{id:jobs[119].id}})).status,'waiting_stage');
  }finally{await f.cleanup();}
});

test('journal records ordered sites, saved state and next run without proxy secrets or storage values',async()=>{
  const f=await poolFixture();try{
    await f.db.$transaction(tx=>pool.createProfileBatch(tx,{count:1}));const claim=await claimWarmup(f.db);
    await executeWarmup({prisma:f.db,claim,config:{},signal:new AbortController().signal,runner:async({log,beforeCommit,commitRun})=>{
      log('warmup_site_started',{domain:'fixture.invalid',step:1,total:3,password:'private',rotationUrl:'https://rotation.invalid/?token=private'});
      log('warmup_site_completed',{domain:'fixture.invalid',step:1,total:3,cookies:[{value:'private'}]});
      await beforeCommit();return (await f.db.$transaction(tx=>commitRun(tx,async()=>{}, {cookiesCount:5,originsCount:2,indexedDBRecordsCount:3}))).count===1;
    }});
    const events=await f.db.profileWarmupEvent.findMany({where:{profileId:claim.job.profileId},orderBy:{id:'asc'}});
    assert.deepEqual(events.map(e=>e.event),['queued','attempt_started','warmup_run_context','warmup_history_read','warmup_site_started','warmup_site_completed','session_saved','stage_completed','next_stage_scheduled','warmup_database_metrics','warmup_run_finished']);
    assert.equal(events.find(e=>e.event==='session_saved').details.cookiesCount,5);
    assert.ok(events.find(e=>e.event==='next_stage_scheduled').details.nextStageAt);assert.equal(events.find(e=>e.event==='warmup_site_started').proxyId,claim.proxy.id);
    assert.ok(!JSON.stringify(events).includes('private'));assert.ok(events.every(e=>!('password' in e)&&!('password' in e.details)));
    const safe=journal.journalEntry({profileId:claim.job.profileId},'fixture',{domain:'host.invalid/?secret=private',reason:'raw message private',password:'private'});
    assert.deepEqual(safe.details,{});
  }finally{await f.cleanup();}
});

test('repeated worker interruptions keep the current stage and never exhaust the profile failure budget',async()=>{
 const {recoverAbandoned}=await import('../worker/pool-scheduler.mjs');
 const f=await poolFixture();try{
  await f.db.$transaction(tx=>pool.createProfileBatch(tx,{count:1}));
  const job=await f.db.warmupJob.findFirst(), firstSessionAt=new Date(Date.now()-3600000),minReadyAt=new Date(Date.now()+86400000);
  await f.db.warmupJob.update({where:{id:job.id},data:{currentStage:2,firstSessionAt,minReadyAt}});
  for(let i=0;i<4;i++){
   await f.db.warmupJob.update({where:{id:job.id},data:{retryAfter:new Date(0)}});
   const claim=await claimWarmup(f.db);assert.ok(claim);
   await f.db.workflowLease.updateMany({where:{owner:claim.owner},data:{expiresAt:new Date(0)}});
   await recoverAbandoned(f.db);
   const row=await f.db.warmupJob.findUniqueOrThrow({where:{id:job.id}});
   assert.equal(row.status,'retry_wait');assert.equal(row.attempts,0);assert.equal(row.currentStage,2);
   assert.equal(row.minReadyAt.getTime(),minReadyAt.getTime());assert.equal(row.firstSessionAt.getTime(),firstSessionAt.getTime());assert.equal(row.dependencyRetries,i+1);
  }
 }finally{await f.cleanup();}
});


test('saving a rotation URL during a shared session makes new aliases join its existing cohort without rotating again',async()=>{
 const f=await poolFixture();try{
  await f.db.settings.update({where:{id:1},data:{warmupConcurrency:2,warmupSharedProxy:true}});
  await f.db.$transaction(tx=>pool.createProfileBatch(tx,{count:3}));
  const first=await claimWarmup(f.db),urls=[];const prepare=async({proxy})=>urls.push(proxy.rotationUrl);
  await prepareWarmupProxy(f.db,first,options(first),prepare);
  const url='https://rotation.invalid/new';await f.db.proxy.update({where:{id:f.proxy.id},data:{rotationUrl:url}});
  const alias=await f.db.proxy.create({data:{host:'127.0.0.2',port:8000,username:'alias',password:'fixture',rotationUrl:url}});
  const second=await claimWarmup(f.db);assert.equal(second.proxy.id,alias.id);assert.equal(second.sharedProxy.groupId,first.sharedProxy.groupId);
  await prepareWarmupProxy(f.db,second,options(second),prepare);assert.deepEqual(urls,[null]);assert.equal(first.proxy.rotationUrl,null);
  assert(await leaseActive(f.db,first));assert(await renewLease(f.db,first));
  for(const claim of [first,second])await finishClaim(f.db,claim,{stopped:true});
  const next=await claimWarmup(f.db);assert(next);await prepareWarmupProxy(f.db,next,options(next),prepare);assert.deepEqual(urls,[null,url]);await finishClaim(f.db,next,{stopped:true});
 }finally{await f.cleanup();}
});

test('changed rotation links cannot let an alias bypass an old exclusive claim, including through an inactive alias',async()=>{
 const f=await poolFixture();try{
  await f.db.proxy.update({where:{id:f.proxy.id},data:{rotationUrl:'https://rotation.invalid/old'}});
  await f.db.$transaction(tx=>pool.createProfileBatch(tx,{count:2}));const active=await claimWarmup(f.db);assert(active);
  const url='https://rotation.invalid/new';await f.db.proxy.update({where:{id:f.proxy.id},data:{rotationUrl:url,isActive:false}});
  const alias=await f.db.proxy.create({data:{host:'127.0.0.2',port:8000,username:'alias',password:'fixture',rotationUrl:url}});
  assert.equal(await claimWarmup(f.db),null);await f.ready();const task=await f.task();assert.equal(await claimTarget(f.db,task.id,'fixture'),null);
  assert(await leaseActive(f.db,active));assert.equal(active.proxy.rotationUrl,'https://rotation.invalid/old');await finishClaim(f.db,active,{stopped:true});
  const next=await claimTarget(f.db,task.id,'fixture');assert(next);assert.equal(next.proxy.id,alias.id);assert(next.keys.includes(`target-share:${proxyKey(f.proxy)}:${next.owner}`));assert.equal(next.proxy.rotationUrl,url);await finishClaim(f.db,next,{stopped:true});
 }finally{await f.cleanup();}
});


test('global pause stops an active warmup without errors or attempt loss, preserves schedules and individual pauses, and resumes its stage',async()=>{
 const f=await poolFixture();try{
  await f.db.$transaction(tx=>pool.createProfileBatch(tx,{count:3}));const jobs=await f.db.warmupJob.findMany({orderBy:{id:'asc'}});
  const firstSessionAt=new Date(Date.now()-86400000),minReadyAt=new Date(Date.now()+86400000),nextStageAt=new Date(Date.now()+3600000);
  await f.db.warmupJob.update({where:{id:jobs[0].id},data:{currentStage:2,firstSessionAt,minReadyAt}});
  await f.db.warmupJob.update({where:{id:jobs[1].id},data:{status:'waiting_stage',currentStage:3,nextStageAt,firstSessionAt,minReadyAt}});
  await f.db.warmupJob.update({where:{id:jobs[2].id},data:{status:'paused'}});
  const unchanged=await f.db.warmupJob.findMany({where:{id:{in:[jobs[1].id,jobs[2].id]}},orderBy:{id:'asc'}});
  const claim=await claimWarmup(f.db);assert.equal(claim.job.id,jobs[0].id);
  await executeWarmup({prisma:f.db,claim,config:{},signal:new AbortController().signal,runner:async({checkActive})=>{
   assert.equal(await checkActive(),true);await f.db.settings.update({where:{id:1},data:{warmupEnabled:false}});assert.equal(await checkActive(),false);throw new TaskStoppedError();
  }});
  const paused=await f.db.warmupJob.findUnique({where:{id:jobs[0].id}});assert.equal(paused.currentStage,2);assert.equal(paused.status,'queued');assert.equal(paused.attempts,0);assert.equal(paused.errorCode,null);assert.deepEqual(paused.plan,jobs[0].plan);assert.deepEqual(paused.firstSessionAt,firstSessionAt);assert.deepEqual(paused.minReadyAt,minReadyAt);
  assert.deepEqual(await f.db.warmupJob.findMany({where:{id:{in:[jobs[1].id,jobs[2].id]}},orderBy:{id:'asc'}}),unchanged);assert.equal(await claimWarmup(f.db),null);
  await f.db.settings.update({where:{id:1},data:{warmupEnabled:true}});await f.db.warmupJob.update({where:{id:jobs[0].id},data:{retryAfter:new Date(0)}});
  const resumed=await claimWarmup(f.db);assert(resumed);assert.equal(resumed.job.currentStage,2);assert.equal(resumed.job.id,jobs[0].id);await finishClaim(f.db,resumed,{stopped:true});
  assert.deepEqual(await f.db.warmupJob.findMany({where:{id:{in:[jobs[1].id,jobs[2].id]}},orderBy:{id:'asc'}}),unchanged);
 }finally{await f.cleanup();}
});
