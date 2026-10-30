import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile, readFile, mkdir, access } from 'node:fs/promises';
import { poolFixture } from './helpers/pool-fixture.mjs';
import { attestedSession } from './helpers/attestation.mjs';
import pool from '../utils/profilePool.js';
import plans from '../utils/warmupPlan.js';
import readiness from '../utils/profileReadiness.js';
import actions from '../utils/profileActions.js';
import { claimWarmup, claimTarget, finishClaim } from '../worker/pool-scheduler.mjs';
import { executeWarmup } from '../worker/warmup-service.mjs';
import { maintainReadiness } from '../worker/readiness-service.mjs';
import { preparePersistentProfile } from '../worker/persistent-profile.mjs';

test('72-hour plan survives settings changes and late runs preserve session spacing', async () => {
 const f=await poolFixture();try{
  await f.db.$transaction(tx=>pool.createProfileBatch(tx,{count:1}));
  const job=await f.db.warmupJob.findFirstOrThrow();assert.deepEqual(job.plan.offsetsHours,[0,8,24,36,48,72]);
  await f.db.settings.update({where:{id:1},data:{warmupStageIntervalMinutes:480}});
  assert.equal(plans.planFor(await f.db.warmupJob.findFirstOrThrow()).minAgeHours,72);
  const first=new Date(), late=new Date(first.getTime()+50*plans.HOUR);
  assert.equal(plans.nextRunAt(job.plan,3,first,late).getTime(),late.getTime()+16*plans.HOUR);
 }finally{await f.cleanup();}
});
test('pause and resume preserve future stage time and dependency cooldown', async()=>{
 const f=await poolFixture();try{
  await f.db.$transaction(tx=>pool.createProfileBatch(tx,{count:1}));const job=await f.db.warmupJob.findFirstOrThrow();
  const scheduled=new Date(Date.now()+24*plans.HOUR), retry=new Date(Date.now()+25*plans.HOUR);
  await f.db.warmupJob.update({where:{id:job.id},data:{status:'paused',stage:'paused',currentStage:2,nextStageAt:scheduled,retryAfter:retry,attempts:2}});
  const result=await f.db.$transaction(tx=>pool.queueWarmups(tx,{profileIds:[job.profileId],action:'resume'}));assert.equal(result.queued,1);
  const resumed=await f.db.warmupJob.findFirstOrThrow();assert.equal(resumed.nextStageAt.getTime(),scheduled.getTime());assert.equal(resumed.retryAfter.getTime(),retry.getTime());assert.equal(resumed.attempts,2);assert.equal(await claimWarmup(f.db),null);
 }finally{await f.cleanup();}
});
test('legacy, expired, and failed fingerprint profiles cannot be assigned to projects',async()=>{
 const f=await poolFixture();try{
  const task=await f.task();await f.db.profile.create({data:{name:'Legacy',status:'ready',warmedAt:new Date()}});assert.equal(await claimTarget(f.db,task.id,'fixture'),null);
  const ready=await f.ready();await f.db.profile.update({where:{id:ready.id},data:{readinessValidUntil:new Date(0)}});assert.equal(await claimTarget(f.db,task.id,'fixture'),null);
  await f.db.profile.update({where:{id:ready.id},data:{readinessValidUntil:new Date(Date.now()+plans.HOUR),fingerprintState:'failed'}});assert.equal(await claimTarget(f.db,task.id,'fixture'),null);
 }finally{await f.cleanup();}
});
test('final success requires elapsed preparation age and exact restored snapshot; early commit never publishes',async()=>{
 const f=await poolFixture();try{
  await f.db.$transaction(tx=>pool.createProfileBatch(tx,{count:1}));const job=await f.db.warmupJob.findFirstOrThrow();
  await f.db.warmupJob.update({where:{id:job.id},data:{currentStage:6,firstSessionAt:new Date(),minReadyAt:new Date(Date.now()+72*plans.HOUR)}});
  await f.db.profile.update({where:{id:job.profileId},data:{fingerprintState:'verified'}});
  let published=0;let claim=await claimWarmup(f.db);const stamp=new Date().toISOString();
  const evidence=attestedSession({savedAt:stamp});
  const runner=async({commitRun})=>f.db.$transaction(tx=>commitRun(tx,async()=>{published++;await tx.profile.update({where:{id:job.profileId},data:{snapshotId:evidence.snapshotId}});},evidence));
  await executeWarmup({prisma:f.db,claim,config:{},signal:new AbortController().signal,runner});assert.equal(published,0);assert.equal((await f.db.warmupJob.findFirstOrThrow()).errorCode,'profile_minimum_age');
  await f.db.warmupJob.update({where:{id:job.id},data:{retryAfter:new Date(0),minReadyAt:new Date(0)}});claim=await claimWarmup(f.db);
  await executeWarmup({prisma:f.db,claim,config:{},signal:new AbortController().signal,runner});assert.equal(published,1);assert(readiness.confirmed(await f.db.profile.findUnique({where:{id:job.profileId}})));
 }finally{await f.cleanup();}
});
test('ready checks preserve preparation and cannot bypass unfinished profiles',async()=>{
 const f=await poolFixture();try{
  await f.db.$transaction(tx=>pool.createProfileBatch(tx,{count:1}));const cold=await f.db.profile.findFirstOrThrow();assert.equal((await f.db.$transaction(tx=>pool.queueWarmups(tx,{profileIds:[cold.id],action:'verify'}))).queued,0);
  const ready=await f.ready();await f.db.profile.update({where:{id:ready.id},data:{readinessValidUntil:new Date(0)}});await maintainReadiness(f.db,{});
  const job=await f.db.warmupJob.findUniqueOrThrow({where:{profileId:ready.id}});assert.equal(job.plan.mode,'verification');assert.equal(job.totalStages,1);assert.equal((await f.db.profile.findUnique({where:{id:ready.id}})).warmedAt.getTime(),ready.warmedAt.getTime());
 }finally{await f.cleanup();}
});
test('dependency retries retain progress and record time and count without consuming failure budget',async()=>{
 const f=await poolFixture();try{
  await f.db.$transaction(tx=>pool.createProfileBatch(tx,{count:1}));const claim=await claimWarmup(f.db);await finishClaim(f.db,claim,{errorCode:'warmup_sites_unavailable'});
  const job=await f.db.warmupJob.findFirstOrThrow();assert.equal(job.attempts,0);assert.equal(job.dependencyRetries,1);assert(job.dependencySince);assert.equal(job.currentStage,1);
 }finally{await f.cleanup();}
});
test('pipeline replenishment uses demand horizon and retry reserve; inactive jobs do not count as usable stock',async()=>{
 const f=await poolFixture();try{
  await f.db.settings.update({where:{id:1},data:{autoReplenishEnabled:true,minReadyProfiles:10,dailyProfileDemand:40,replenishBatchSize:1000,maxPendingProfiles:500}});
  assert.equal((await pool.replenishPool(f.db)).created,160);assert.equal((await pool.replenishPool(f.db)).created,0);
  await f.db.warmupJob.updateMany({data:{status:'paused'}});assert.equal((await pool.replenishPool(f.db)).created,160);
 }finally{await f.cleanup();}
});
test('actions expose meaningful reasons and ready profiles need explicit restart',async()=>{
 const profile={status:'ready',isEnabled:true,warmedAt:new Date(),warmupJob:{status:'completed'}};
 assert.equal(actions.actionReason(profile,'pause'),'not_running');assert.equal(actions.actionReason(profile,'resume'),'not_paused');assert.equal(actions.actionReason(profile,'retry'),'not_failed');assert.equal(actions.actionReason(profile,'verify'),null);assert.equal(actions.actionReason(profile,'delete',true),'busy');
});
test('persistent browser pilot stages privately, discards failed runs, and publishes only successful changes',async()=>{
 const f=await poolFixture();try{
  let run=await preparePersistentProfile(f.dir,'fixture');await writeFile(join(run.path,'state'),'first');await run.publish();await run.discard();
  run=await preparePersistentProfile(f.dir,'fixture');assert.equal(await readFile(join(run.path,'state'),'utf8'),'first');await writeFile(join(run.path,'state'),'failed');await run.discard();
  run=await preparePersistentProfile(f.dir,'fixture');assert.equal(await readFile(join(run.path,'state'),'utf8'),'first');await writeFile(join(run.path,'state'),'second');await run.publish();assert.equal(await readFile(join(f.dir,'browser-data','fixture','current','state'),'utf8'),'second');await run.discard();
 }finally{await f.cleanup();}
});

test('legacy upgrade preserves prior browsing, paused dates, project history, and is idempotent',async()=>{
 const { upgradeProfilePlans } = await import('../scripts/upgrade-profile-plans.mjs');
 const f=await poolFixture();try{
  const first=new Date(Date.now()-10*plans.HOUR), scheduled=new Date(Date.now()+plans.HOUR);
  const profile=await f.db.profile.create({data:{name:'Legacy paused',status:'queued',warmupJob:{create:{status:'paused',currentStage:4,totalStages:4,nextStageAt:scheduled}},projectHistory:{create:{projectId:f.project.id}}}});
  await f.db.profileWarmupEvent.create({data:{profileId:profile.id,event:'session_saved',createdAt:first}});
  assert.equal((await upgradeProfilePlans(f.db)).profilesToUpgrade,1);
  assert.equal((await upgradeProfilePlans(f.db,{apply:true,pilotCount:0})).upgraded,1);
  const upgraded=await f.db.warmupJob.findUnique({where:{profileId:profile.id}});assert.equal(upgraded.currentStage,3);assert.equal(upgraded.status,'paused');assert.equal(upgraded.firstSessionAt.getTime(),first.getTime());assert.equal(upgraded.totalStages,6);assert(upgraded.nextStageAt>=scheduled);assert.equal(await f.db.profileProjectHistory.count(),1);
  await f.db.settings.update({where:{id:1},data:{warmupStageIntervalMinutes:480}});assert.equal((await upgradeProfilePlans(f.db,{apply:true})).upgraded,0);assert.equal((await f.db.settings.findUnique({where:{id:1}})).warmupStageIntervalMinutes,480);
 }finally{await f.cleanup();}
});
