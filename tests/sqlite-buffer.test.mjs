import test from 'node:test';
import assert from 'node:assert/strict';
import {sqliteTelemetryBuffer} from '../worker/sqlite-write.mjs';
import {asyncFileQueue} from '../worker/async-live-files.mjs';
import {poolFixture} from './helpers/pool-fixture.mjs';

test('rolled back journal batch is retained, newer progress wins and subsequent flushes recover',async()=>{
 const f=await poolFixture();try{
 const profile=await f.db.profile.create({data:{name:'buffer-test'}});
 const job=await f.db.warmupJob.create({data:{profileId:profile.id,status:'running',owner:'fixture'}});
 let fail=true,started,release;
 const began=new Promise(r=>started=r),gate=new Promise(r=>release=r);
 const buffer=sqliteTelemetryBuffer(f.db,async(tx,entries,data)=>{
  await tx.profileWarmupEvent.createMany({data:entries});
  if(fail){started();await gate;fail=false;throw Error('simulated_busy');}
  await tx.warmupJob.update({where:{id:job.id},data});
 });
 buffer.push({profileId:profile.id,event:'first'});buffer.update({progress:10});
 const write=buffer.flush();await began;
 buffer.push({profileId:profile.id,event:'second'});buffer.update({progress:20});release();
 await assert.rejects(write,/simulated_busy/);
 assert.equal(await f.db.profileWarmupEvent.count(),0,'Failed transaction must not partially publish');
 await Promise.all([buffer.flush(),buffer.flush()]);
 assert.deepEqual((await f.db.profileWarmupEvent.findMany({orderBy:{id:'asc'}})).map(x=>x.event),['first','second']);
 assert.equal((await f.db.warmupJob.findUnique({where:{id:job.id}})).progress,20);
 buffer.push({profileId:profile.id,event:'third'});await buffer.flush();assert.equal(await f.db.profileWarmupEvent.count(),3);
 }finally{await f.cleanup();}
});

test('slow observation does not block timers or other files; latest frame wins and I/O failure does not poison queue',async()=>{
 const q=asyncFileQueue({maxPending:3}),seen=[];let release;
 const gate=new Promise(r=>release=r);
 const first=q.enqueue('/fixture/a',async()=>{await gate;seen.push('first');});
 await new Promise(setImmediate);
 const frame=q.enqueue('/fixture/a',async()=>seen.push('old'),{replace:true});
 assert.equal(q.enqueue('/fixture/a',async()=>seen.push('latest'),{replace:true}),frame);
 await q.enqueue('/fixture/b',async()=>seen.push('other'));
 await new Promise(r=>setTimeout(r,5));assert.deepEqual(seen,['other']);release();
 await first;await q.flush('/fixture');assert.deepEqual(seen,['other','first','latest']);
 await assert.rejects(q.enqueue('/fixture/a',async()=>{throw Error('io_error');}),/io_error/);
 await q.enqueue('/fixture/a',async()=>seen.push('recovered'));assert.equal(seen.at(-1),'recovered');
});

test('observational queue rejects overflow while a stalled file stays bounded',async()=>{
 const q=asyncFileQueue({maxPending:2});let release;
 const gate=new Promise(r=>release=r),first=q.enqueue('/bounded/log',()=>gate);
 await new Promise(setImmediate);
 const a=q.enqueue('/bounded/log',async()=>{}),b=q.enqueue('/bounded/log',async()=>{});
 await assert.rejects(q.enqueue('/bounded/log',async()=>{}),/live_io_queue_full/);
 release();await Promise.all([first,a,b]);await q.flush('/bounded');
 await q.enqueue('/bounded/log',async()=>{});
});
