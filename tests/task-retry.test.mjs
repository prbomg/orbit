import test from 'node:test';
import assert from 'node:assert/strict';
import { poolFixture } from './helpers/pool-fixture.mjs';
import { claimTarget, finishClaim } from '../worker/pool-scheduler.mjs';
import { pollDatabase } from '../worker/runner.mjs';
import lifecycle from '../utils/taskLifecycle.js';

async function prepared(run) {
  const f = await poolFixture();
  try {
    for (let i=0;i<8;i++) await f.ready();
    await f.db.proxy.create({data:{host:'127.0.0.2',port:8000,username:'fixture',password:'fixture'}});
    const task=await f.task();
    await run(f,task);
  } finally { await f.cleanup(); }
}

test('five identical failures persist their series, rotate both resources and stop only that task',async()=>{
  await prepared(async(f,task)=>{
    let previous;
    for(let i=1;i<=5;i++){
      const claim=await claimTarget(f.db,task.id,'fixture');assert.ok(claim);
      if(previous){assert.notEqual(claim.task.profileId,previous.task.profileId);assert.notEqual(claim.proxy.id,previous.proxy.id);}
      const result=await finishClaim(f.db,claim,{errorCode:'search_home_timeout',errorType:'SearchError'});
      assert.equal(result.retryState.count,i);assert.equal(result.taskStopped,i===5);
      previous=claim;
    }
    const saved=await f.db.task.findUnique({where:{id:task.id}});assert.equal(saved.status,'failed');assert.equal(saved.retryState.count,5);
    assert.equal(await claimTarget(f.db,task.id,'fixture'),null);
    const other=await f.task();assert.ok(await claimTarget(f.db,other.id,'other'));
  });
});

test('different errors and successful completions reset a series; manual stop does not count as failure',async()=>{
  await prepared(async(f,task)=>{
    const finish=async options=>{const claim=await claimTarget(f.db,task.id,'fixture');assert.ok(claim);await finishClaim(f.db,claim,options);return (await f.db.task.findUnique({where:{id:task.id}})).retryState;};
    assert.equal((await finish({errorCode:'timeout',errorType:'SearchError'})).count,1);
    assert.equal((await finish({errorCode:'timeout',errorType:'SearchError'})).count,2);
    assert.equal((await finish({errorCode:'missing_api_key',errorType:'CaptchaError'})).count,1);
    assert.equal((await finish({stopped:true,errorCode:'stopped'})).count,1);
    assert.deepEqual(await finish({success:true}),{});
    assert.equal((await finish({errorCode:'missing_api_key',errorType:'CaptchaError'})).count,1);
  });
});

test('retry delay and exclusions survive reconnecting; shortage waits instead of reusing the failed pair',async()=>{
  await prepared(async(f,task)=>{
    const claim=await claimTarget(f.db,task.id,'fixture');await finishClaim(f.db,claim,{errorCode:'timeout',retryDelayMs:60_000});
    await f.db.$disconnect();
    assert.equal(await claimTarget(f.db,task.id,'fixture'),null);
    const next=await claimTarget(f.db,task.id,'fixture',new Date(Date.now()+61_000));assert.ok(next);
    assert.notEqual(next.task.profileId,claim.task.profileId);assert.notEqual(next.proxy.id,claim.proxy.id);
    await finishClaim(f.db,next,{stopped:true});
    await f.db.proxy.update({where:{id:next.proxy.id},data:{isActive:false}});
    await f.db.task.update({where:{id:task.id},data:{retryState:{count:1,lastProxyId:claim.proxy.id,lastProfileId:claim.task.profileId}}});
    assert.equal(await claimTarget(f.db,task.id,'fixture'),null);
  });
});

test('parallel failures cannot overrun the five-error stop or release stale leases twice',async()=>{
  await prepared(async(f,task)=>{
    await f.db.task.update({where:{id:task.id},data:{targetExecutions:3,concurrency:3,retryState:{key:'SearchError:timeout:',code:'timeout',type:'SearchError',count:4}}});
    const claims=[];for(let i=0;i<3;i++)claims.push(await claimTarget(f.db,task.id,'fixture'));
    assert.ok(claims.every(Boolean));
    await Promise.all(claims.map(claim=>finishClaim(f.db,claim,{errorCode:'timeout',errorType:'SearchError'})));
    const saved=await f.db.task.findUnique({where:{id:task.id}});assert.equal(saved.status,'failed');assert.equal(saved.retryState.count,5);
    await finishClaim(f.db,claims[0],{success:true});
    assert.equal((await f.db.task.findUnique({where:{id:task.id}})).retryState.count,5);
    assert.equal(await f.db.workflowLease.count({where:{key:{startsWith:'profile:'}}}),0);
  });
});

test('runner continues a healthy project task while another task reaches its retry limit',async()=>{
  await prepared(async(f,bad)=>{
    const good=await f.task();const events=[];const pairs=[];
    const result=await pollDatabase({prisma:f.db,config:{projectId:f.project.id,cooldownMs:1,pollMs:1},signal:new AbortController().signal,
      log:(event,data)=>events.push({event,...data}),runTaskRunner:async({task,proxy,beforeTargetVisit})=>{
        if(task.id===bad.id){pairs.push([task.profileId,proxy.id]);const error=new Error('Fixture failure');error.name='SearchError';error.code='search_home_timeout';throw error;}
        await beforeTargetVisit();return (await f.db.$transaction(tx=>lifecycle.commitTaskExecution(tx,{taskId:task.id,profileId:task.profileId,executionId:task.executionId}))).count===1;
      }});
    assert.equal(result,0);assert.equal(pairs.length,5);
    for(let i=1;i<pairs.length;i++){assert.notEqual(pairs[i][0],pairs[i-1][0]);assert.notEqual(pairs[i][1],pairs[i-1][1]);}
    assert.equal((await f.db.task.findUnique({where:{id:good.id}})).status,'completed');
    assert.equal((await f.db.task.findUnique({where:{id:bad.id}})).status,'failed');
    assert.ok(events.some(row=>row.event==='task_retry_exhausted'&&row.taskId===bad.id));
    assert.ok(!events.some(row=>row.event==='project_blocked'));
  });
});
