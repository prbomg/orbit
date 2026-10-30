import test from 'node:test';
import assert from 'node:assert/strict';
import stats from '../utils/dashboardStats.js';
import state from '../utils/dashboardState.js';
import {poolFixture} from './helpers/pool-fixture.mjs';
const now=Date.parse('2026-10-13T12:00:00Z');
test('overview uses completion time in Moscow, excludes stops, future, undated and unfinished attempts',async()=>{
 const f=await poolFixture();
 try{
  const task=await f.task();await f.db.task.update({where:{id:task.id},data:{currentExecutions:999}});
  const entries=[['completed','2026-10-12T21:00:00Z',null],['failed','2026-10-13T00:20:00Z','search_rate_limited'],['failed','2026-10-13T01:00:00Z','stopped'],['running',null,null],['failed',null,'worker_interrupted'],['completed','2026-10-12T20:59:59Z',null],['completed','2026-10-13T12:00:01Z',null],['completed','2026-10-06T20:59:59Z',null]];
  for(const [status,at,errorCode] of entries){const profile=await f.ready();await f.db.taskExecution.create({data:{taskId:task.id,profileId:profile.id,status,startedAt:new Date('2026-10-06T00:00:00Z'),completedAt:at?new Date(at):null,errorCode}});}
  const today=await stats.dashboardStats(f.db,'today',now);assert.deepEqual(today.today,{completed:1,failed:1});assert.deepEqual(today.totals,today.today);assert.equal(today.buckets.length,24);assert.equal(today.buckets[0].completed,1);assert.equal(today.buckets[3].failed,1);
  const week=await stats.dashboardStats(f.db,'week',now);assert.deepEqual(week.today,today.today);assert.deepEqual(week.totals,{completed:2,failed:1});assert.equal(week.buckets.length,7);assert.equal(week.buckets[5].completed,1);assert.equal(week.buckets[6].completed,1);assert.equal(week.buckets.reduce((s,b)=>s+b.failed,0),1);
  await assert.rejects(stats.dashboardStats(f.db,'month',now),/invalid_period/);
 }finally{await f.cleanup();}
});
test('task permission is distinct from running sessions and waits retain their reasons',()=>{
 const task={status:'running',executions:[],retryState:{}};
 assert.equal(state.taskState(task,undefined,now).kind,'waiting');
 const run={state:'running'};
 assert.equal(state.taskState({...task,executions:[{status:'running'},{status:'running'}]},run,now).count,2);
 assert.equal(state.taskState({...task,executions:[{status:'running'}]},{state:'paused'},now).kind,'waiting');
 assert.equal(state.taskState({...task,status:'paused'},run,now).kind,'paused');
 assert.equal(state.taskState({...task,status:'failed',retryState:{code:'ERROR_CAPTCHA_UNSOLVABLE'}},run,now).code,'ERROR_CAPTCHA_UNSOLVABLE');
 assert.equal(state.taskState(task,{state:'waiting',waitReason:'schedule'},now).kind,'schedule');
 assert.equal(state.taskState(task,{state:'waiting',waitReason:'profiles_or_proxies'},now).kind,'resources');
 assert.equal(state.taskState({...task,retryState:{code:'search_rate_limited',retryAfter:new Date(now+600000).toISOString()}},run,now).kind,'retry');
 assert.equal(state.taskState({...task,dailyWaitReason:'daily_limit',nextExecutionAt:new Date(now+86400000).toISOString()},run,now).kind,'schedule');
});
test('next start window respects local hours, closed schedules and half-hour offsets',()=>{
 const hours='0'.repeat(168);assert.equal(state.nextScheduleWindow({scheduleHours:hours,scheduleTimezone:'Europe/Moscow'},now),null);
 assert.equal(state.nextScheduleWindow({scheduleHours:'1'.repeat(168),scheduleTimezone:'Europe/Moscow'},now),new Date(now).toISOString());
 const m=[...hours];m[24+16]='1';assert.equal(state.nextScheduleWindow({scheduleHours:m.join(''),scheduleTimezone:'Europe/Moscow'},now),'2026-10-13T13:00:00.000Z');
 const india=[...hours];india[24+18]='1';assert.equal(state.nextScheduleWindow({scheduleHours:india.join(''),scheduleTimezone:'Asia/Kolkata'},now),'2026-10-13T12:30:00.000Z');
});

test('next task start satisfies both retry delay and project schedule, and paused projects have no automatic start',()=>{
 const hours=[...'0'.repeat(168)];hours[24+18]='1';const project={scheduleHours:hours.join(''),scheduleTimezone:'Europe/Moscow'};
 const task={status:'running',executions:[],retryState:{retryAfter:'2026-10-13T13:00:00Z',code:'search_rate_limited'}};
 assert.equal(state.nextTaskWindow(project,task,{state:'running'},now),'2026-10-13T15:00:00.000Z');
 assert.equal(state.nextTaskWindow(project,task,{state:'paused'},now),null);
 assert.equal(state.nextTaskWindow(project,{...task,retryState:{retryAfter:'2026-10-13T16:00:00Z'}},{state:'waiting',waitReason:'schedule'},now),'2026-10-20T15:00:00.000Z');
 assert.equal(state.nextTaskWindow(project,{...task,retryState:{},dailyWaitReason:'daily_schedule',nextExecutionAt:'2026-10-13T15:30:00Z'},{state:'waiting',waitReason:'schedule'},now),'2026-10-13T15:30:00.000Z');
});
