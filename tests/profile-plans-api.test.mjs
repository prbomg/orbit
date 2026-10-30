import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { authHeaders } from './helpers/auth.mjs';
const base=process.env.API_TEST_BASE_URL;if(!base||new URL(base).hostname!=='127.0.0.1')throw new Error('Isolated local API required');
const call=async(path,body)=>{const response=await fetch(`${base}${path}`,{method:body?'POST':'GET',headers:{...await authHeaders(),'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return{status:response.status,data:await response.json()};};
test('preview has no side effects, pause keeps dates, hidden and busy selections have explicit reasons',async()=>{
 const db=new PrismaClient();let ids=[];try{
  const batch=await call('/api/profiles/batch/',{count:2,namePrefix:'Actions fixture',warmup:true});ids=batch.data.profiles.map(p=>p.id);
  await db.profile.updateMany({where:{id:{in:ids}},data:{storageMode:'snapshot'}});
  const scheduled=new Date(Date.now()+86400000);await db.warmupJob.update({where:{profileId:ids[0]},data:{status:'waiting_stage',currentStage:2,nextStageAt:scheduled}});
  const preview=await call('/api/profiles/actions/',{action:'pause',profileIds:ids,preview:true});assert.equal(preview.data.eligible,2);assert.equal((await db.warmupJob.findUnique({where:{profileId:ids[0]}})).status,'waiting_stage');
  assert.equal((await call('/api/profiles/actions/',{action:'pause',profileIds:ids})).status,200);assert.equal((await db.warmupJob.findUnique({where:{profileId:ids[0]}})).nextStageAt.getTime(),scheduled.getTime());
  assert.equal((await call('/api/profiles/actions/',{action:'resume',profileIds:ids})).data.queued,2);assert.equal((await db.warmupJob.findUnique({where:{profileId:ids[0]}})).nextStageAt.getTime(),scheduled.getTime());
  await db.workflowLease.create({data:{key:`profile:${ids[0]}`,owner:'fixture',expiresAt:new Date(Date.now()+60000)}});
  const deletion=await call('/api/profiles/actions/',{action:'delete',profileIds:ids,preview:true});assert.equal(deletion.data.eligible,1);assert.equal(deletion.data.items[0].reason,'busy');assert.equal(await db.profile.count({where:{id:{in:ids},deletedAt:null}}),2);
  const response=await fetch(`${base}/api/profiles/${ids[0]}/`,{method:'PATCH',headers:{...await authHeaders(),'Content-Type':'application/json'},body:JSON.stringify({storageMode:'persistent'})});assert.equal(response.status,409);
 }finally{await db.workflowLease.deleteMany({where:{key:{in:ids.map(id=>`profile:${id}`)}}});await db.profile.deleteMany({where:{id:{in:ids}}});await db.$disconnect();}
});
test('settings reject stale writes and update only supplied fields; site health is authenticated',async()=>{
 const config=(await call('/api/settings/')).data;
 const patch=async(body)=>fetch(`${base}/api/settings/`,{method:'PATCH',headers:{...await authHeaders(),'Content-Type':'application/json'},body:JSON.stringify(body)});
 assert.equal((await patch({warmupConcurrency:5,expectedUpdatedAt:config.updatedAt})).status,200);
 assert.equal((await patch({dailyProfileDemand:40,expectedUpdatedAt:config.updatedAt})).status,409);
 const fresh=(await call('/api/settings/')).data;assert.equal(fresh.warmupConcurrency,5);assert.equal(fresh.dailyProfileDemand,config.dailyProfileDemand);
 assert.equal((await fetch(`${base}/api/profiles/sites/`)).status,401);const health=await call('/api/profiles/sites/');assert.equal(health.status,200);assert(health.data.items.length>=3);assert(health.data.items.every(s=>!('password'in s)));
 await patch({warmupConcurrency:config.warmupConcurrency});
});

test('expired readiness is excluded from ready and searchable in needs-check without losing the name filter',async()=>{
 const db=new PrismaClient();let profile;try{
  profile=await db.profile.create({data:{name:'Expired readiness fixture',status:'ready',warmedAt:new Date(),fingerprintState:'verified',readinessVerifiedAt:new Date(Date.now()-86400000),readinessValidUntil:new Date(0),sessionCheck:{status:'passed'}}});
  const ready=await call(`/api/profiles/?page=1&status=ready&search=${profile.id}`);assert.equal(ready.data.total,0);
  const checking=await call(`/api/profiles/?page=1&status=needs_check&search=${profile.id}`);assert.equal(checking.status,200);assert.equal(checking.data.total,1);assert.equal(checking.data.items[0].id,profile.id);
  assert.equal((await call('/api/profiles/?page=1&status=needs_check&search=definitely-missing-fixture')).data.total,0);
 }finally{if(profile)await db.profile.delete({where:{id:profile.id}});await db.$disconnect();}
});
