import test from 'node:test';
import assert from 'node:assert/strict';
import { poolFixture } from './helpers/pool-fixture.mjs';
import { proxyKey, claimTarget, finishClaim } from '../worker/pool-scheduler.mjs';
import { managedEventRecord } from '../worker/managed-state.mjs';

test('allocation diagnostics distinguish missing profiles, disabled proxies, busy profiles and replacement restrictions', async () => {
 const f=await poolFixture();
 try {
  const task=await f.task();let detail;
  const claim=()=>claimTarget(f.db,task.id,'diagnostic',undefined,d=>{detail=d;});
  assert.equal(await claim(),null);assert.equal(detail.reason,'no_ready_profiles');
  const profile=await f.ready();
  await f.db.proxy.update({where:{id:f.proxy.id},data:{isActive:false}});
  assert.equal(await claim(),null);assert.equal(detail.reason,'no_active_proxies');
  await f.db.proxy.update({where:{id:f.proxy.id},data:{isActive:true}});
  await f.db.workflowLease.create({data:{key:`profile:${profile.id}`,owner:'fixture',expiresAt:new Date(Date.now()+60000)}});
  assert.equal(await claim(),null);assert.equal(detail.reason,'profiles_busy');
  await f.db.workflowLease.deleteMany({where:{owner:'fixture'}});
  await f.db.workflowLease.create({data:{key:proxyKey(f.proxy),owner:'fixture',expiresAt:new Date(Date.now()+60000)}});
  assert.equal(await claim(),null);assert.equal(detail.reason,'proxies_busy');
  await f.db.workflowLease.deleteMany({where:{owner:'fixture'}});
  await f.db.proxyTcpChannel.create({data:{id:'ios-only',providerProxyId:'fixture',profileId:1,profileName:'iOS',parameters:{},family:'ios',status:'applied'}});
  await f.db.proxy.update({where:{id:f.proxy.id},data:{tcpChannelId:'ios-only'}});
  assert.equal(await claim(),null);assert.equal(detail.reason,'pair_incompatible');
  await f.db.proxy.update({where:{id:f.proxy.id},data:{tcpChannelId:null}});
  const first=await claim();assert.ok(first);await finishClaim(f.db,first,{errorCode:'search_overlay_blocked',errorType:'SearchError'});
  await f.ready();
  await f.db.task.update({where:{id:task.id},data:{retryState:{lastProfileId:profile.id,lastProxyId:f.proxy.id}}});
  assert.equal(await claim(),null);assert.equal(detail.reason,'proxy_replacement_unavailable');
  await f.db.task.update({where:{id:task.id},data:{retryState:{retryAfter:new Date(Date.now()+60000).toISOString()}}});
  assert.equal(await claim(),null);assert.equal(detail.reason,'retry_pause');assert.ok(detail.nextAt);
 }finally{await f.cleanup();}
});

test('wait timestamps are sanitized and cleared once execution resumes',()=>{
 const waiting=managedEventRecord({},'waiting',{reason:'profiles_busy',nextAt:'invalid',nextCheckAt:'2026-10-13T20:00:00Z'});
 assert.equal(waiting.waitReason,'profiles_busy');assert.equal(waiting.nextAt,null);assert.equal(waiting.nextCheckAt,'2026-10-13T20:00:00.000Z');
 const started=managedEventRecord(waiting,'session_started');assert.equal(started.waitReason,null);assert.equal(started.nextCheckAt,null);
});
