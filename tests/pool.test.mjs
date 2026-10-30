import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PrismaClient } from '@prisma/client';
import pool from '../utils/profilePool.js';
import { claimWarmup, claimTarget, finishClaim, markTargetUsed, recoverAbandoned, leaseActive, renewLease, prepareTargetProxy } from '../worker/pool-scheduler.mjs';
import { executeWarmup } from '../worker/warmup-service.mjs';
import { pollDatabase } from '../worker/runner.mjs';
import lifecycle from '../utils/taskLifecycle.js';
import { sqliteWrite } from '../worker/sqlite-write.mjs';
import { poolFixture as fixture, migrations } from './helpers/pool-fixture.mjs';
import { attestedSession } from './helpers/attestation.mjs';
test('batch creation queues every profile without creating main tasks, and queue requests are idempotent', async () => {
 const f=await fixture();try{
  const result=await f.db.$transaction(tx=>pool.createProfileBatch(tx,{count:100}));
  assert.equal(result.queued,100);assert.equal(await f.db.profile.count(),100);assert.equal(await f.db.warmupJob.count(),100);assert.equal(await f.db.task.count(),0);
  assert.ok(result.profiles.every(profile=>profile.storageMode==='persistent'));
  assert.equal(await f.db.profile.count({where:{storageMode:'persistent'}}),100);
  const again=await f.db.$transaction(tx=>pool.queueWarmups(tx,{profileIds:result.profiles.map(p=>p.id)}));assert.equal(again.queued,0);assert.equal(again.skipped,100);
 }finally{await f.cleanup();}
});
test('only warmed profiles qualify; a consumed profile cannot return to any task in that project, including after failure or deletion',async()=>{
 const f=await fixture();try{
  const task=await f.task();await f.db.profile.create({data:{name:'Forged',status:'ready'}});assert.equal(await claimTarget(f.db,task.id,'demand'),null);
  const p=await f.ready();const claim=await claimTarget(f.db,task.id,'demand');assert.equal(claim.task.profileId,p.id);
  await markTargetUsed(f.db,claim);await finishClaim(f.db,claim,{errorCode:'after_navigation'});
  assert.equal(await claimTarget(f.db,task.id,'demand'),null);
  await f.db.task.delete({where:{id:task.id}});const replacement=await f.task();assert.equal(await claimTarget(f.db,replacement.id,'demand'),null);
  const other=await f.db.project.create({data:{name:'Other',targetUrl:'https://other.test',yandexRegionId:'2',regionName:''}});const t2=await f.task(other.id);assert.equal((await claimTarget(f.db,t2.id,'other')).task.profileId,p.id);
 }finally{await f.cleanup();}
});
test('profiles and proxy channels are exclusive, while independent channels permit warmup and target concurrently',async()=>{
 const f=await fixture();try{
  await f.db.proxy.update({where:{id:f.proxy.id},data:{channel:'shared-modem'}});
  await f.ready();const task=await f.task();await f.db.$transaction(tx=>pool.createProfileBatch(tx,{count:2}));
  const warm=await claimWarmup(f.db);assert.ok(warm);assert.equal(await claimTarget(f.db,task.id,'demand'),null);
  await f.db.proxy.create({data:{host:'127.0.0.1',port:8001,username:'fixture',password:'fixture',channel:'shared-modem'}});assert.equal(await claimTarget(f.db,task.id,'demand'),null,'explicit aliases share rotation channel');
  await f.db.proxy.create({data:{host:'127.0.0.2',port:8000,username:'fixture',password:'fixture'}});const target=await claimTarget(f.db,task.id,'demand');assert.ok(target);assert.notEqual(target.task.profileId,warm.job.profileId);
  assert.equal(await claimWarmup(f.db),null,'both independent channels occupied');
  await finishClaim(f.db,warm,{stopped:true});await finishClaim(f.db,target,{stopped:true});assert.equal(await f.db.workflowLease.count({where:{key:{startsWith:'profile:'}}}),0);
 }finally{await f.cleanup();}
});
test('identical rotation URLs lock different proxy aliases; declared dedicated channels respect purpose',async()=>{
 const f=await fixture();try{
  await f.db.proxy.update({where:{id:f.proxy.id},data:{purpose:'warmup',rotationUrl:'https://rotation.test/same'}});
  await f.db.proxy.create({data:{host:'127.0.0.2',port:8000,username:'fixture',password:'fixture',purpose:'target',rotationUrl:'https://rotation.test/same'}});
  await f.db.$transaction(tx=>pool.createProfileBatch(tx,{count:1}));const warm=await claimWarmup(f.db);assert.ok(warm);
  await f.ready();const task=await f.task();assert.equal(await claimTarget(f.db,task.id,'demand'),null);
 }finally{await f.cleanup();}
});
test('pre-navigation failures release reservation; stale owners cannot release a later lease',async()=>{
 const f=await fixture();try{
  await f.ready();await f.ready();await f.db.proxy.create({data:{host:'127.0.0.2',port:8000,username:'fixture',password:'fixture'}});const task=await f.task();const first=await claimTarget(f.db,task.id,'demand');await finishClaim(f.db,first,{errorCode:'proxy_failed'});
  assert.equal(await f.db.projectProfileUse.count(),0);const second=await claimTarget(f.db,task.id,'demand');assert.notEqual(second.task.profileId,first.task.profileId);assert.notEqual(second.proxy.id,first.proxy.id);
  await finishClaim(f.db,first,{success:true});assert.ok(await leaseActive(f.db,second));assert.ok(await renewLease(f.db,second));
 }finally{await f.cleanup();}
});
test('successful target commit is counted once, and each next execution gets another profile',async()=>{
 const f=await fixture();try{
  await f.ready();await f.ready();const task=await f.task(f.project.id,2);const claim=await claimTarget(f.db,task.id,'demand');await markTargetUsed(f.db,claim);
  const args={taskId:task.id,profileId:claim.task.profileId,executionId:claim.task.executionId};
  await f.db.$transaction(tx=>lifecycle.commitTaskExecution(tx,args));
  assert.equal((await f.db.$transaction(tx=>lifecycle.commitTaskExecution(tx,args))).count,0);
  assert.equal((await f.db.task.findUnique({where:{id:task.id}})).currentExecutions,1);
  await finishClaim(f.db,claim,{success:true});const next=await claimTarget(f.db,task.id,'demand');assert.notEqual(next.task.profileId,claim.task.profileId);
 }finally{await f.cleanup();}
});
test('a 300-run task starts with fewer ready profiles, shares one proxy safely, and resumes when profiles arrive',async()=>{
 const f=await fixture();try{
  const task=await f.db.task.create({data:{projectId:f.project.id,url:'https://example.test/',targetExecutions:300,concurrency:2}});
  assert.equal(await claimTarget(f.db,task.id,'demand'),null);
  const first=await f.ready(),second=await f.ready();
  const a=await claimTarget(f.db,task.id,'demand');const b=await claimTarget(f.db,task.id,'demand');
  assert(a&&b);assert.deepEqual(new Set([a.task.profileId,b.task.profileId]),new Set([first.id,second.id]));
  assert.equal(a.sharedProxy.groupId,b.sharedProxy.groupId);assert.equal(await claimTarget(f.db,task.id,'demand'),null);
  let preparations=0;
  const prepare=(claim)=>prepareTargetProxy(f.db,claim,{signal:new AbortController().signal,shouldContinue:async()=>true,log:()=>{}},async()=>{preparations++});
  await Promise.all([prepare(a),prepare(b)]);assert.equal(preparations,1,'one IP rotation/TCP preparation per concurrent cohort');
  for(const claim of [a,b]){await markTargetUsed(f.db,claim);assert.equal((await f.db.$transaction(tx=>lifecycle.commitTaskExecution(tx,{taskId:task.id,profileId:claim.task.profileId,executionId:claim.task.executionId}))).count,1);await finishClaim(f.db,claim,{success:true});}
  assert.equal((await f.db.task.findUnique({where:{id:task.id}})).currentExecutions,2);
  assert.equal(await claimTarget(f.db,task.id,'demand'),null,'shortage does not complete the task or reuse a profile');
  const third=await f.ready();const c=await claimTarget(f.db,task.id,'demand');assert.equal(c.task.profileId,third.id);await finishClaim(f.db,c,{stopped:true});
  assert.equal((await f.db.task.findUnique({where:{id:task.id}})).status,'running');
 }finally{await f.cleanup();}
});
test('project worker runs available profiles concurrently while a larger plan remains unfinished',async()=>{
 const f=await fixture();const controller=new AbortController();let worker,release;try{
  await f.ready();await f.ready();const task=await f.db.task.create({data:{projectId:f.project.id,url:'https://example.test/',targetExecutions:300,concurrency:2}});
  let started=0;const gate=new Promise(resolve=>{release=resolve});let bothReady;const both=new Promise(resolve=>{bothReady=resolve});
  worker=pollDatabase({prisma:f.db,config:{projectId:f.project.id,pollMs:20,cooldownMs:20},signal:controller.signal,runTaskRunner:async({checkActive,beforeTargetVisit,commitRun})=>{
   assert.equal(await checkActive(),true);started++;if(started===2)bothReady();await gate;await beforeTargetVisit();
   const evidence=attestedSession();const result=await sqliteWrite(f.db,tx=>commitRun(tx,async()=>{},evidence));return result.count===1;
  }});
  await Promise.race([both,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Parallel sessions did not start')),5000))]);
  assert.equal(started,2);assert.equal((await f.db.task.findUnique({where:{id:task.id}})).currentExecutions,0);
  release();for(let attempt=0;attempt<100;attempt++){if((await f.db.task.findUnique({where:{id:task.id}})).currentExecutions===2)break;await new Promise(resolve=>setTimeout(resolve,20));}
  assert.equal((await f.db.task.findUnique({where:{id:task.id}})).currentExecutions,2);assert.equal((await f.db.task.findUnique({where:{id:task.id}})).status,'running');
  controller.abort();assert.equal(await worker,0);
 }finally{controller.abort();release?.();await worker?.catch(()=>{});await f.cleanup();}
});
test('six-session warmup schedules each next run and only the final stage makes a profile ready',async()=>{
 const f=await fixture();try{
  await f.db.$transaction(tx=>pool.createProfileBatch(tx,{count:1}));let saved=0;let profileId;
  for(let stage=1;stage<=6;stage++){
    const claim=await claimWarmup(f.db);assert.ok(claim);profileId??=claim.job.profileId;assert.equal(claim.job.profileId,profileId);assert.equal(claim.job.currentStage,stage);
    await executeWarmup({prisma:f.db,claim,config:{},signal:new AbortController().signal,runner:async({commitRun,checkActive,requireSavedProfile,task})=>{assert.ok(await checkActive());assert.equal(requireSavedProfile,stage>1);assert.equal(task.warmupStage,stage);await f.db.profile.update({where:{id:claim.job.profileId},data:{fingerprintState:'verified'}});const evidence=attestedSession();const result=await f.db.$transaction(tx=>commitRun(tx,async()=>{saved++;await tx.profile.update({where:{id:claim.job.profileId},data:{snapshotId:evidence.snapshotId}});},evidence));return result.count===1;}});
    const row=await f.db.profile.findUnique({where:{id:profileId},include:{warmupJob:true}});
    if(stage<6){assert.equal(row.status,'queued');assert.equal(row.warmedAt,null);assert.equal(row.warmupJob.status,'waiting_stage');assert.equal(row.warmupJob.currentStage,stage+1);assert.ok(row.warmupJob.nextStageAt);assert.equal((await pool.projectAvailability(f.db,f.project.id)).available,0);assert.equal(await claimWarmup(f.db),null);await f.db.warmupJob.update({where:{id:row.warmupJob.id},data:{nextStageAt:new Date(0),firstSessionAt:new Date(Date.now()-80*3600000),minReadyAt:new Date(0)}});}
    else{assert.equal(row.status,'ready');assert.ok(row.warmedAt);assert.equal(row.warmupScore,1);assert.equal(row.warmupJob.status,'completed');}
  }
  assert.equal(saved,6);assert.equal((await pool.projectAvailability(f.db,f.project.id)).available,1);
  await f.db.$transaction(tx=>pool.createProfileBatch(tx,{count:1}));const failure=await claimWarmup(f.db);await executeWarmup({prisma:f.db,claim:failure,config:{},signal:new AbortController().signal,runner:async()=>{throw new Error('synthetic');}});
  assert.equal((await f.db.warmupJob.findUnique({where:{id:failure.job.id}})).status,'retry_wait');assert.equal((await f.db.profile.findUnique({where:{id:failure.job.profileId}})).warmedAt,null);
 }finally{await f.cleanup();}
});
test('abandoned jobs preserve profile failure budget, reservations survive only if navigation started',async()=>{
 const f=await fixture();try{
  await f.db.$transaction(tx=>pool.createProfileBatch(tx,{count:1}));const warm=await claimWarmup(f.db);await f.db.warmupJob.update({where:{id:warm.job.id},data:{attempts:3}});await f.db.workflowLease.updateMany({data:{expiresAt:new Date(0)}});await recoverAbandoned(f.db);
  const recovered=await f.db.warmupJob.findUnique({where:{id:warm.job.id}});assert.equal(recovered.status,'retry_wait');assert.equal(recovered.attempts,2);assert.equal(recovered.dependencyRetries,1);
  await f.ready();const task=await f.task();const claim=await claimTarget(f.db,task.id,'demand');await markTargetUsed(f.db,claim);await f.db.workflowLease.updateMany({data:{expiresAt:new Date(0)}});await recoverAbandoned(f.db);
  assert.equal(await claimTarget(f.db,task.id,'demand'),null);assert.equal(await f.db.projectProfileUse.count({where:{usedAt:{not:null}}}),1);
 }finally{await f.cleanup();}
});
test('replenishment accounts for project-specific availability and pending jobs without summing overlapping deficits',async()=>{
 const f=await fixture();try{
  await f.db.settings.update({where:{id:1},data:{autoReplenishEnabled:true,minReadyProfiles:2,replenishBatchSize:100,maxPendingProfiles:100}});
  const ready=await f.ready();await f.ready();await f.task(f.project.id,5);await f.db.projectProfileUse.create({data:{projectId:f.project.id,profileId:ready.id,usedAt:new Date()}});
  const second=await f.db.project.create({data:{name:'Other',targetUrl:'https://other.test',regionName:'',yandexRegionId:'2'}});await f.task(second.id,5);
  assert.equal((await pool.replenishPool(f.db)).created,4);assert.equal((await pool.replenishPool(f.db)).created,0);
  await f.db.warmupJob.updateMany({data:{status:'failed'}});await f.db.settings.update({where:{id:1},data:{maxPendingProfiles:4}});assert.equal((await pool.replenishPool(f.db)).created,4,'failed profiles do not stop replenishment of useful stock');
 }finally{await f.cleanup();}
});
test('migration keeps counters and auth, converts legacy warmups and remembers previously used profiles',async()=>{
 const sql=new DatabaseSync(':memory:');try{
  const scripts=await migrations();const index=scripts.findIndex(s=>s.includes('CREATE TABLE "WarmupJob"'));for(const script of scripts.slice(0,index))sql.exec(script);
  sql.exec(`INSERT INTO Profile(id,name,status,warmedAt) VALUES ('old','Old','ready',CURRENT_TIMESTAMP),('cold','Cold','new',NULL);
    INSERT INTO Project(id,name,websiteUrl,yandexRegionId,regionName) VALUES ('project','Project','https://example.test','213','');
    INSERT INTO Task(id,projectId,profileId,currentExecutions,targetExecutions) VALUES ('target','project','old',2,5);
    INSERT INTO Task(id,profileId,taskType,status) VALUES ('warm','cold','warmup','paused');
    INSERT INTO AuthUser(id,email,passwordHash) VALUES ('user','seo@example.test','preserved');`);
  sql.exec(scripts[index]);assert.equal(sql.prepare('SELECT currentExecutions FROM Task WHERE id=?').get('target').currentExecutions,2);
  assert.equal(sql.prepare('SELECT count(*) n FROM Task WHERE taskType=?').get('warmup').n,0);
  assert.equal(sql.prepare('SELECT status FROM WarmupJob WHERE profileId=?').get('cold').status,'paused');
  assert.ok(sql.prepare('SELECT usedAt FROM ProjectProfileUse WHERE profileId=?').get('old').usedAt);
  assert.equal(sql.prepare('SELECT passwordHash FROM AuthUser').get().passwordHash,'preserved');assert.deepEqual(sql.prepare('PRAGMA foreign_key_check').all(),[]);
 }finally{sql.close();}
});

test('two database clients share a target proxy channel but never the same profile', async () => {
 const f=await fixture(); const other=new PrismaClient({datasources:{db:{url:`file:${f.dir}/test.db`}}});
 try {
  await f.ready(); await f.ready(); const a=await f.task(), b=await f.task();
  const claims=await Promise.all([claimTarget(f.db,a.id,'first'),claimTarget(other,b.id,'second')]);
  assert.equal(claims.filter(Boolean).length,2);
  assert.notEqual(claims[0].task.profileId,claims[1].task.profileId);
  assert.equal(claims[0].sharedProxy.groupId,claims[1].sharedProxy.groupId);
  assert.equal(await f.db.taskExecution.count({where:{status:'running'}}),2);
  assert.equal(await f.db.projectProfileUse.count(),2);
 } finally { await other.$disconnect();await f.cleanup(); }
});

test('a failed proxy channel cools down so the next warmup uses another channel',async()=>{
 const f=await fixture();try{
  await f.db.proxy.create({data:{host:'127.0.0.2',port:8000,username:'fixture',password:'fixture'}});
  await f.db.$transaction(tx=>pool.createProfileBatch(tx,{count:2}));const first=await claimWarmup(f.db);
  await finishClaim(f.db,first,{errorCode:'proxy_check_failed',proxyFailed:true});
  const next=await claimWarmup(f.db);assert.ok(next);assert.notEqual(next.proxy.host,first.proxy.host);
 }finally{await f.cleanup();}
});

test('proxy outages preserve the profile attempt budget and completed warmup stages', async () => {
 const f=await fixture();try{
  await f.db.$transaction(tx=>pool.createProfileBatch(tx,{count:1}));
  const job=await f.db.warmupJob.findFirstOrThrow();
  await f.db.warmupJob.update({where:{id:job.id},data:{currentStage:2,attempts:2}});
  for(let outage=0;outage<4;outage++){
   const claim=await claimWarmup(f.db);assert.ok(claim);assert.equal(claim.job.attempts,3);
   await finishClaim(f.db,claim,{errorCode:'network',proxyFailed:true});
   const latest=await f.db.warmupJob.findUniqueOrThrow({where:{id:job.id}});
   assert.equal(latest.status,'retry_wait');assert.equal(latest.stage,'stage_2_proxy_wait');
   assert.equal(latest.currentStage,2);assert.equal(latest.attempts,2);
   assert.equal((await f.db.profile.findUniqueOrThrow({where:{id:job.profileId}})).status,'queued');
   await f.db.workflowLease.deleteMany({where:{key:{startsWith:'cooldown:'}}});
   await f.db.warmupJob.update({where:{id:job.id},data:{retryAfter:new Date(0)}});
  }
  const claim=await claimWarmup(f.db);await finishClaim(f.db,claim,{errorCode:'fingerprint_verification_failed'});
  assert.equal((await f.db.warmupJob.findUniqueOrThrow({where:{id:job.id}})).status,'failed','Real profile failure still exhausts the budget');
 }finally{await f.cleanup();}
});

test('unavailable donors schedule a delayed retry without exhausting profile attempts or advancing stages', async () => {
 const f=await fixture();try{
  await f.db.$transaction(tx=>pool.createProfileBatch(tx,{count:1}));
  const job=await f.db.warmupJob.findFirstOrThrow();
  await f.db.warmupJob.update({where:{id:job.id},data:{currentStage:2,attempts:2}});
  await f.db.profileWarmupEvent.create({data:{profileId:job.profileId,event:'warmup_site_completed',proxyLabel:`${f.proxy.host}:${f.proxy.port}`,details:{domain:'available.example.org'}}});
  await f.db.profileWarmupEvent.create({data:{profileId:job.profileId,event:'warmup_site_skipped',proxyLabel:'other:9000',details:{domain:'other.example.org'}}});
  for(let outage=0;outage<4;outage++){
   const claim=await claimWarmup(f.db);assert.ok(claim);assert.equal(claim.job.attempts,3);
   const started=Date.now();
   await executeWarmup({prisma:f.db,claim,config:{},signal:new AbortController().signal,runner:async({config})=>{
    assert.equal(config.warmupSiteHistory.length,1);assert.equal(config.warmupSiteHistory[0].details.domain,'available.example.org');
    const error=new Error('Synthetic unavailable donors');error.code='warmup_sites_unavailable';throw error;
   }});
   const latest=await f.db.warmupJob.findUniqueOrThrow({where:{id:job.id}});
   assert.equal(latest.status,'retry_wait');assert.equal(latest.stage,'stage_2_sites_wait');
   assert.equal(latest.currentStage,2);assert.equal(latest.attempts,2);
   assert(latest.retryAfter.getTime()>=started+15*60_000);assert.equal(latest.nextStageAt,null);
   assert.equal((await f.db.profile.findUniqueOrThrow({where:{id:job.profileId}})).status,'queued');
   assert.equal(await claimWarmup(f.db),null,'the scheduled retry delay is respected');
   await f.db.warmupJob.update({where:{id:job.id},data:{retryAfter:new Date(0)}});
  }
  const claim=await claimWarmup(f.db);await finishClaim(f.db,claim,{errorCode:'fingerprint_verification_failed'});
  assert.equal((await f.db.warmupJob.findUniqueOrThrow({where:{id:job.id}})).status,'failed');
 }finally{await f.cleanup();}
});
