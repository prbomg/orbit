import test from 'node:test';
import assert from 'node:assert/strict';
import {poolFixture} from './helpers/pool-fixture.mjs';
import {reserveSearchQuery} from '../worker/search-query-balance.mjs';
import visits from '../utils/projectVisits.js';

test('random tie selection, parallel reservations, success deduplication and failure release',async()=>{
 const f=await poolFixture();try{
  const task=await f.task();const queries=['a','b','c'];
  const make=async()=>{const profile=await f.ready();const execution=await f.db.taskExecution.create({data:{taskId:task.id,profileId:profile.id,status:'running'}});return {...task,executionId:execution.id};};
  const first=await make(),second=await make(),third=await make();
  const selected=await Promise.all([first,second,third].map(t=>reserveSearchQuery(f.db,t,queries,n=>n-1)));
  assert.deepEqual(selected,['c','b','a']); // Not array order, each gets a distinct least-used query.
  assert.equal(await reserveSearchQuery(f.db,first,queries,()=>0),'c'); // Idempotent reservation.
  await visits.recordProjectVisit(f.db,{projectId:f.project.id,taskId:task.id,executionId:first.executionId,query:'c',actualQuery:'c brand',engine:'yandex'});
  const fourth=await make();
  assert.equal(await reserveSearchQuery(f.db,fourth,queries,n=>n-1),'c'); // The still-running successful first execution counts only once.
  await f.db.taskExecution.update({where:{id:second.executionId},data:{status:'failed'}});
  const fifth=await make();assert.equal(await reserveSearchQuery(f.db,fifth,queries,()=>0),'b');
  await assert.rejects(reserveSearchQuery(f.db,second,queries),{name:'TaskStoppedError'});
  const other=await f.task();assert.equal(await reserveSearchQuery(f.db,other,queries,n=>n-1),'c'); // Separate task history.
 }finally{await f.cleanup();}
});

test('corrects historical skew and keeps successful sequential visits balanced',async()=>{
 const f=await poolFixture();try{
  const task=await f.task(),queries=['a','b','c'];
  for(let i=0;i<8;i++)await visits.recordProjectVisit(f.db,{projectId:f.project.id,taskId:task.id,query:'a',actualQuery:'a',engine:'yandex'});
  const counts={a:8,b:0,c:0};
  for(let i=0;i<40;i++){
   const query=await reserveSearchQuery(f.db,task,queries);
   assert.equal(counts[query],Math.min(...Object.values(counts)));
   counts[query]++;
   await visits.recordProjectVisit(f.db,{projectId:f.project.id,taskId:task.id,query,actualQuery:query,engine:'yandex'});
  }
  assert.deepEqual(counts,{a:16,b:16,c:16});
  assert.equal(await reserveSearchQuery(f.db,task,['new']), 'new');
 }finally{await f.cleanup();}
});
