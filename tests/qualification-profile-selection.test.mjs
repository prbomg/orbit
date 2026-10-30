import test from 'node:test';
import assert from 'node:assert/strict';
import { invalidateOutdatedBrowserProfiles } from '../worker/browser-qualification.mjs';
import { poolFixture } from './helpers/pool-fixture.mjs';

test('qualification reads only stale profile IDs, preserves matching/unknown/deleted profiles and batches invalidation', async()=>{
 const f=await poolFixture();
 try{
  const version='153.0.8010.12',verified=new Date(),validUntil=new Date(Date.now()+86400000);
  const old=Array.from({length:1105},(_,i)=>({id:'outdated-'+i,name:'Outdated '+i,status:'ready',fingerprintCheck:{runtimeVersion:'152.0.0.0'},readinessVerifiedAt:verified,readinessValidUntil:validUntil}));
  await f.db.profile.createMany({data:[...old,
   {id:'matching',name:'Matching large report',status:'ready',fingerprintCheck:{runtimeVersion:version,details:'x'.repeat(600000)},readinessVerifiedAt:verified,readinessValidUntil:validUntil},
   {id:'unmeasured',name:'Unmeasured',status:'ready'},
   ...[{}, {runtimeVersion:null},{runtimeVersion:''},{runtimeVersion:0},{runtimeVersion:false}].map((fingerprintCheck,i)=>({id:'unknown-'+i,name:'Unknown',status:'ready',fingerprintCheck})),
   {id:'deleted',name:'Deleted',status:'ready',deletedAt:new Date(),fingerprintCheck:{runtimeVersion:'old'}},
   {id:'not-ready',name:'Not ready',status:'new',fingerprintCheck:{runtimeVersion:'old'}},
   {id:'disabled',name:'Disabled old',status:'ready',isEnabled:false,fingerprintCheck:{runtimeVersion:'old'}},
  ]});
  const batches=[];
  const guarded=f.db.$extends({query:{profile:{findMany:()=>{throw Error('Do not load full fingerprintCheck reports');},updateMany:async({args,query})=>{batches.push(args.where.id.in.length);return query(args);}}}});
  const count=await guarded.$transaction(tx=>invalidateOutdatedBrowserProfiles(tx,version),{timeout:15000});
  assert.equal(count,1106);assert.deepEqual(batches,[500,500,106]);
  assert.equal(await f.db.profile.count({where:{status:'needs_check'}}),1106);
  const stale=await f.db.profile.findUnique({where:{id:'outdated-0'}});assert.equal(stale.readinessVerifiedAt,null);assert.equal(stale.readinessValidUntil,null);assert.equal(stale.fingerprintCheck.runtimeVersion,'152.0.0.0');
  const matching=await f.db.profile.findUnique({where:{id:'matching'}});assert.equal(matching.status,'ready');assert.equal(matching.readinessValidUntil.getTime(),validUntil.getTime());assert.equal(matching.fingerprintCheck.details.length,600000);
  for(const id of ['unmeasured','unknown-0','unknown-1','unknown-2','unknown-3','unknown-4','deleted'])assert.equal((await f.db.profile.findUnique({where:{id}})).status,'ready');
  assert.equal((await f.db.profile.findUnique({where:{id:'not-ready'}})).status,'new');
  assert.equal(await invalidateOutdatedBrowserProfiles(guarded,version),0);
  await f.db.profile.create({data:{id:'rollback',name:'Rollback',status:'ready',fingerprintCheck:{runtimeVersion:'old'}}});
  const aborted=new Error('rollback fixture');
  await assert.rejects(f.db.$transaction(async tx=>{assert.equal(await invalidateOutdatedBrowserProfiles(tx,version),1);throw aborted;}),e=>e===aborted);
  assert.equal((await f.db.profile.findUnique({where:{id:'rollback'}})).status,'ready');
 }finally{await f.cleanup();}
});
