import test from 'node:test';
import assert from 'node:assert/strict';
import {poolFixture} from './helpers/pool-fixture.mjs';
import pool from '../utils/profilePool.js';
import {claimWarmup} from '../worker/pool-scheduler.mjs';
import {executeWarmup} from '../worker/warmup-service.mjs';
import {isDatabaseUnavailable} from '../worker/sqlite-write.mjs';
test('only temporary database failures are infrastructure interruptions',()=>{
 for(const code of ['P1008','P2024','P2034'])assert(isDatabaseUnavailable({code}));
 assert(isDatabaseUnavailable({code:'P2028',message:'Transaction already closed: timeout expired'}));
 assert(isDatabaseUnavailable({message:'SQLite error: database is locked'}));
 for(const code of ['P2002','P2003','profile_session_verification_failed'])assert(!isDatabaseUnavailable({code}));
 assert(!isDatabaseUnavailable({code:'P2028',message:'Transaction API error: malformed operation'}));
});
test('repeated database timeouts keep stage and session age without exhausting attempts',async()=>{
 const f=await poolFixture();try{
  await f.db.$transaction(tx=>pool.createProfileBatch(tx,{count:1}));const job=await f.db.warmupJob.findFirst();
  const firstSessionAt=new Date(Date.now()-86400000),minReadyAt=new Date(Date.now()+86400000);
  await f.db.warmupJob.update({where:{id:job.id},data:{currentStage:2,firstSessionAt,minReadyAt}});
  for(let i=0;i<4;i++){
   await f.db.warmupJob.update({where:{id:job.id},data:{retryAfter:new Date(0)}});
   const claim=await claimWarmup(f.db);assert(claim);
   await executeWarmup({prisma:f.db,claim,config:{},signal:new AbortController().signal,runner:async()=>{const e=new Error('database operation timed out');e.code='P1008';throw e;}});
   const row=await f.db.warmupJob.findUniqueOrThrow({where:{id:job.id}});
   assert.equal(row.status,'retry_wait');assert.equal(row.attempts,0);assert.equal(row.errorCode,'database_busy');assert.equal(row.stage,'stage_2_database_wait');assert.equal(row.currentStage,2);
   assert.equal(row.firstSessionAt.getTime(),firstSessionAt.getTime());assert.equal(row.minReadyAt.getTime(),minReadyAt.getTime());assert.equal(row.dependencyRetries,i+1);
   assert.equal((await f.db.profile.findUniqueOrThrow({where:{id:job.profileId}})).status,'queued');
  }
 }finally{await f.cleanup();}
});
