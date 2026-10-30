import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PrismaClient } from '@prisma/client';
import { acquireLock } from '../worker/lock.mjs';
import runtime from '../utils/workerRuntime.js';
import { poolFixture } from './helpers/pool-fixture.mjs';
import { claimTarget, finishClaim, claimWarmup } from '../worker/pool-scheduler.mjs';

test('different projects acquire independent locks; duplicates and global CLI cannot overlap',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'orbit-locks-')),db=join(dir,'test.db');let a,b,global;
 try{
  [a,b]=await Promise.all([acquireLock(db,{projectId:'a',runId:'a1'}),acquireLock(db,{projectId:'b',runId:'b1'})]);
  await assert.rejects(acquireLock(db,{projectId:'a'}),/already/);
  await assert.rejects(acquireLock(db),/already/);
  await a();a=null;assert.equal(JSON.parse(await readFile(runtime.workerLockPath(db,'b'))).runId,'b1');
  await b();b=null;global=await acquireLock(db);
  await assert.rejects(acquireLock(db,{projectId:'a'}),/already/);
  await assert.rejects(acquireLock(db,{projectId:'../unsafe'}),/Invalid/);
 }finally{await a?.();await b?.();await global?.();await rm(dir,{recursive:true,force:true});}
});

test('runtime records isolate project status and retain legacy history only for its owner',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'orbit-records-'));
 try{
  await writeFile(join(dir,'project-worker.json'),JSON.stringify({projectId:'legacy',runId:'old'}));
  for(const id of ['a','b']){const p=runtime.projectPaths(dir,id);await mkdir(p.directory,{recursive:true});await writeFile(p.record,JSON.stringify({projectId:id,runId:id+'-run'}));}
  assert.equal(runtime.readProjectRecord(dir,'a').runId,'a-run');assert.equal(runtime.readProjectRecord(dir,'b').runId,'b-run');
  assert.equal(runtime.readProjectRecord(dir,'legacy').runId,'old');assert.equal(runtime.readProjectRecord(dir,'missing'),null);
  assert.deepEqual(runtime.projectIds(dir,join(dir,'db')).sort(),['a','b','legacy']);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('independent database clients reserve distinct profiles across projects and enforce task concurrency',async()=>{
 const f=await poolFixture();const otherClient=new PrismaClient({datasources:{db:{url:`file:${f.dir}/test.db`}}});
 try{
  for(let i=0;i<6;i++)await f.ready();
  const project=await f.db.project.create({data:{name:'Other',targetUrl:'https://example.test/',yandexRegionId:'213',regionName:''}});
  const a=await f.task(f.project.id,10),b=await f.task(project.id,10);
  await f.db.task.updateMany({data:{concurrency:2}});
  const claims=await Promise.all([claimTarget(f.db,a.id,'a'),claimTarget(otherClient,b.id,'b')]);
  assert.ok(claims.every(Boolean));assert.notEqual(claims[0].task.profileId,claims[1].task.profileId);
  assert.equal(claims[0].sharedProxy.groupId,claims[1].sharedProxy.groupId);
  const more=await Promise.all([claimTarget(f.db,a.id,'a'),claimTarget(otherClient,b.id,'b')]);assert.ok(more.every(Boolean));
  assert.equal(new Set([...claims,...more].map(c=>c.task.profileId)).size,4);
  assert.equal(await claimTarget(f.db,a.id,'a'),null);assert.equal(await claimTarget(otherClient,b.id,'b'),null);
  await finishClaim(f.db,claims[0],{stopped:true});await finishClaim(f.db,more[0],{stopped:true});
  assert.equal(await otherClient.taskExecution.count({where:{taskId:b.id,status:'running'}}),2);
  await finishClaim(otherClient,claims[1],{stopped:true});await finishClaim(otherClient,more[1],{stopped:true});
 }finally{await otherClient.$disconnect();await f.cleanup();}
});

test('one project clearing demand does not erase another project waiting for shared proxies',async()=>{
 const f=await poolFixture();try{
  await f.ready();const a=await f.task(),b=await f.task();
  await f.db.workflowLease.create({data:{key:'proxy:endpoint:127.0.0.1:8000',owner:'fixture-busy',expiresAt:new Date(Date.now()+60000)}});
  assert.equal(await claimTarget(f.db,a.id,'a'),null);assert.equal(await claimTarget(f.db,b.id,'b'),null);
  assert.equal(await f.db.workflowLease.count({where:{key:{startsWith:'target-demand:'}}}),2);
  await f.db.project.update({where:{id:f.project.id},data:{scheduleHours:'0'.repeat(168)}});
  await claimTarget(f.db,a.id,'a');assert.ok(await f.db.workflowLease.findUnique({where:{key:'target-demand:b'}}));
 }finally{await f.cleanup();}
});
