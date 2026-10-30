import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {poolFixture} from './helpers/pool-fixture.mjs';
import pool from '../utils/profilePool.js';
import {claimWarmup,finishClaim} from '../worker/pool-scheduler.mjs';
import {executeWarmup} from '../worker/warmup-service.mjs';

for(const code of ['ENOSPC','EDQUOT','SQLITE_FULL','profile_disk_full'])test(`${code} preserves saved stage and attempt budget, backs off and remains retryable`,async()=>{
 const f=await poolFixture();try{
  await f.db.$transaction(tx=>pool.createProfileBatch(tx,{count:1}));const job=await f.db.warmupJob.findFirstOrThrow();
  const firstSessionAt=new Date(Date.now()-86400000),minReadyAt=new Date(Date.now()+86400000);
  await f.db.warmupJob.update({where:{id:job.id},data:{currentStage:3,attempts:2,firstSessionAt,minReadyAt}});
  await f.db.profile.update({where:{id:job.profileId},data:{snapshotId:'durable-snapshot'}});
  for(let i=0;i<4;i++){
   await f.db.warmupJob.update({where:{id:job.id},data:{retryAfter:new Date(0)}});
   const claim=await claimWarmup(f.db);assert.ok(claim);assert.equal(claim.job.attempts,3);const start=Date.now();
   const logs=[];
   await executeWarmup({prisma:f.db,claim,config:{},signal:new AbortController().signal,log:(event,data)=>logs.push({event,...data}),runner:async()=>{throw Object.assign(new Error('private filesystem path and token must not be logged'),{code});}});
   const row=await f.db.warmupJob.findUniqueOrThrow({where:{id:job.id}});
   assert.equal(row.status,'retry_wait');assert.equal(row.errorCode,'profile_disk_full');assert.equal(row.stage,'stage_3_disk_wait');assert.equal(row.currentStage,3);assert.equal(row.attempts,2);
   assert.equal(row.firstSessionAt.getTime(),firstSessionAt.getTime());assert.equal(row.minReadyAt.getTime(),minReadyAt.getTime());assert.equal(row.dependencyRetries,i+1);
   const delay=5*60000*2**Math.min(2,i);assert.ok(row.retryAfter.getTime()>=start+delay);assert.ok(row.retryAfter.getTime()<=Date.now()+delay);
   const profile=await f.db.profile.findUniqueOrThrow({where:{id:job.profileId}});assert.equal(profile.status,'queued');assert.equal(profile.snapshotId,'durable-snapshot');
   assert.equal(await claimWarmup(f.db),null);assert.doesNotMatch(JSON.stringify(logs),/private filesystem path|token must/);
  }
  await f.db.warmupJob.update({where:{id:job.id},data:{retryAfter:new Date(0)}});const claim=await claimWarmup(f.db);await finishClaim(f.db,claim,{errorCode:'fingerprint_verification_failed'});
  assert.equal((await f.db.warmupJob.findUniqueOrThrow({where:{id:job.id}})).status,'failed','a real fingerprint failure still exhausts the existing budget');
 }finally{await f.cleanup();}
});

test('disk waits and historical disk failures have meaningful UI descriptions',()=>{
 const require=createRequire(import.meta.url),module={exports:{}};
 const code=ts.transpileModule(readFileSync(new URL('../lib/profile-readiness.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
 new Function('require','exports','module',code)(name=>require(name.startsWith('@/utils/')?'../utils/'+name.slice('@/utils/'.length)+'.js':name),module.exports,module);
 const {sessionErrorMessage,profileReadiness}=module.exports;
 assert.match(sessionErrorMessage('ENOSPC'),/места на диске/);assert.match(sessionErrorMessage('profile_disk_full'),/лимит ошибок.*не расходуется/);
 const readiness=profileReadiness({status:'queued',isEnabled:true,fingerprintState:'verified',warmedAt:null,warmupJob:{status:'retry_wait',stage:'stage_3_disk_wait',errorCode:'profile_disk_full',currentStage:3,totalStages:6}},{state:'missing',savedAt:null,hasData:false});
 assert.equal(readiness.state,'waiting');assert.equal(readiness.label,'Ожидает свободного места');
});
