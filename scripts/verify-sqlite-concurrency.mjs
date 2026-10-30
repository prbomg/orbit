import {PrismaClient} from '@prisma/client';
import {poolFixture} from '../tests/helpers/pool-fixture.mjs';
import {sqliteTelemetryBuffer,measureSqliteWrites} from '../worker/sqlite-write.mjs';
import {monitorEventLoopDelay,performance} from 'node:perf_hooks';
import {writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const f=await poolFixture({wal:true}),other=new PrismaClient({datasources:{db:{url:`file:${f.dir}/test.db`}}});
const delay=monitorEventLoopDelay({resolution:10}),writes=[];const started=performance.now();
try{
 const profiles=await Promise.all(Array.from({length:12},(_,i)=>f.db.profile.create({data:{name:`synthetic-concurrency-${i}`}})));
 delay.enable();
 await measureSqliteWrites(async()=>{
  await Promise.all(profiles.map(async(p,i)=>{
   const buffer=sqliteTelemetryBuffer(i%2?other:f.db,async(tx,entries)=>tx.profileWarmupEvent.createMany({data:entries}));
   for(let j=0;j<100;j++){buffer.push({profileId:p.id,event:'synthetic_diagnostic',details:{sequence:j}});if(buffer.size>=25)await buffer.flush();}
   await buffer.flush();
  }));
 },sample=>writes.push(sample));
 const events=await f.db.profileWarmupEvent.findMany({orderBy:{id:'asc'}});assert.equal(events.length,1200);
 for(const p of profiles)assert.deepEqual(events.filter(e=>e.profileId===p.id).map(e=>e.details.sequence),Array.from({length:100},(_,i)=>i));
 delay.disable();
 const report={scope:'isolated SQLite WAL; two Prisma clients, twelve logical producers; not a browser gesture benchmark',events:events.length,transactions:writes.length,failedWrites:writes.filter(x=>x.failed).length,maxQueueMs:Math.round(Math.max(...writes.map(x=>x.queueMs))),maxTransactionMs:Math.round(Math.max(...writes.map(x=>x.transactionMs))),eventLoopP95Ms:Number((delay.percentile(95)/1e6).toFixed(2)),eventLoopMaxMs:Number((delay.max/1e6).toFixed(2)),durationMs:Math.round(performance.now()-started),passed:true};
 if(process.argv[2])await writeFile(process.argv[2],JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{delay.disable();await other.$disconnect();await f.cleanup();}
