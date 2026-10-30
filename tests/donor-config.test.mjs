import test from 'node:test';
import assert from 'node:assert/strict';
import donors from '../utils/donorSites.js';
import { selectDonorSites } from '../worker/warmup.mjs';
import { createBehaviorRandom, withBehaviorRandom } from '../worker/behavior-random.mjs';
import { poolFixture } from './helpers/pool-fixture.mjs';
import { reserveDonor, finishDonor, releaseDonor, availableDonors } from '../worker/donor-health.mjs';
import {serializeSqlite} from '../worker/sqlite-write.mjs';
const sites=['https://one.example.com/','https://two.example.com/','https://three.example.com/'];
test('explicit donor configuration wins over ENV; invalid and insufficient pools fail clearly',()=>{
 assert.deepEqual(donors.resolveDonorSites(null,{ORBIT_WARMUP_DONOR_SITES:JSON.stringify(sites)}),sites);
 const configured=['https://a.example.com/','https://b.example.com/','https://c.example.com/'];
 assert.deepEqual(donors.resolveDonorSites({warmupSites:configured},{ORBIT_WARMUP_DONOR_SITES:JSON.stringify(sites)}),configured);
 assert.throws(()=>donors.resolveDonorSites(null,{ORBIT_WARMUP_DONOR_SITES:'bad'}),/invalid_warmup_donor_sites/);
 assert.throws(()=>selectDonorSites(sites,4),{code:'warmup_sites_unavailable'});
 const selected=withBehaviorRandom(createBehaviorRandom('donors'),()=>selectDonorSites([...sites,...sites],3));
 assert.equal(new Set(selected).size,3);
});
test('donor failure/cooldown survives DB reconnect and healthy donors replace it',async()=>{
 const f=await poolFixture();try{
  const now=new Date();const lease=await reserveDonor(f.db,f.proxy,sites[0],now);
  const health=await finishDonor(f.db,lease,{status:429,retryAfter:'7200',reason:'site_rate_limited'},now);
  assert.equal(+health.cooldownUntil-+now,7200000);
  await f.db.$disconnect();
  assert.deepEqual(await availableDonors(f.db,f.proxy,sites,now),sites.slice(1));
  assert.equal(await reserveDonor(f.db,f.proxy,sites[0],now),null);
  assert.deepEqual(await availableDonors(f.db,f.proxy,sites,new Date(+now+7200001)),sites);
 }finally{await f.cleanup();}
});

test('finished donor cleanup does not queue a second write behind a busy database',async()=>{
 const f=await poolFixture();let unblock,blocked;
 try{
  const reservation=await reserveDonor(f.db,f.proxy,sites[0]);assert.ok(reservation);
  await finishDonor(f.db,reservation,{success:true,status:200});
  assert.equal(await f.db.workflowLease.count({where:{owner:reservation.owner}}),0);
  let started;const ready=new Promise(r=>started=r),gate=new Promise(r=>unblock=r);
  blocked=serializeSqlite(f.db,async()=>{started();await gate;});await ready;
  let timer;
  try{await Promise.race([releaseDonor(f.db,reservation),new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('cleanup queued redundant write')),300))]);}
  finally{clearTimeout(timer);}
 }finally{unblock?.();await blocked;await f.cleanup();}
});
test('unfinished reservation still releases and repeated cleanup is idempotent',async()=>{
 const f=await poolFixture();try{
  const reservation=await reserveDonor(f.db,f.proxy,sites[0]);assert.ok(reservation);
  await releaseDonor(f.db,reservation);await releaseDonor(f.db,reservation);
  assert.equal(await f.db.workflowLease.count({where:{owner:reservation.owner}}),0);
  assert.equal(await f.db.warmupSiteHealth.count(),0,'cleanup must not manufacture a visit result');
 }finally{await f.cleanup();}
});
test('failed donor finalization leaves cleanup active until its deletion commits',async()=>{
 const f=await poolFixture();try{
  const reservation=await reserveDonor(f.db,f.proxy,sites[0]);assert.ok(reservation);
  await assert.rejects(finishDonor(f.db,reservation,{success:true,status:'invalid-fixture'}));
  assert.ok(await f.db.workflowLease.count({where:{owner:reservation.owner}}));
  await releaseDonor(f.db,reservation);
  assert.equal(await f.db.workflowLease.count({where:{owner:reservation.owner}}),0);
 }finally{await f.cleanup();}
});
