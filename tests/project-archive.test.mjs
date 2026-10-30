import test from 'node:test';
import assert from 'node:assert/strict';
import archive from '../utils/projectArchive.js';
import {poolFixture} from './helpers/pool-fixture.mjs';
test('archive retains linked history and progress, pauses queued work and restores without starting it',async()=>{
 const f=await poolFixture();try{
  const task=await f.task(f.project.id,10),profile=await f.ready();
  await f.db.task.update({where:{id:task.id},data:{currentExecutions:3}});
  await f.db.profileProjectHistory.create({data:{profileId:profile.id,projectId:f.project.id}});
  await f.db.projectProfileUse.create({data:{profileId:profile.id,projectId:f.project.id}});
  const saved=await f.db.$transaction(tx=>archive.changeArchive(tx,f.project.id,'archive'));
  assert.ok(saved.archivedAt);assert.equal(await f.db.project.count({where:{archivedAt:null}}),0);
  const paused=await f.db.task.findUnique({where:{id:task.id}});assert.equal(paused.status,'paused');assert.equal(paused.currentExecutions,3);
  assert.equal(await f.db.profileProjectHistory.count({where:{projectId:f.project.id}}),1);assert.equal(await f.db.projectProfileUse.count({where:{projectId:f.project.id}}),1);
  const again=await f.db.$transaction(tx=>archive.changeArchive(tx,f.project.id,'archive'));assert.equal(again.archivedAt.getTime(),saved.archivedAt.getTime());
  const restored=await f.db.$transaction(tx=>archive.changeArchive(tx,f.project.id,'restore'));assert.equal(restored.archivedAt,null);assert.equal((await f.db.task.findUnique({where:{id:task.id}})).status,'paused');
 }finally{await f.cleanup();}
});
test('active execution prevents archiving with no partial changes',async()=>{
 const f=await poolFixture();try{
  const task=await f.task(),profile=await f.ready();
  const exec=await f.db.taskExecution.create({data:{taskId:task.id,profileId:profile.id,status:'running'}});
  await assert.rejects(f.db.$transaction(tx=>archive.changeArchive(tx,f.project.id,'archive')),/project_active/);
  assert.equal((await f.db.project.findUnique({where:{id:f.project.id}})).archivedAt,null);assert.equal((await f.db.task.findUnique({where:{id:task.id}})).status,'running');
  await f.db.taskExecution.update({where:{id:exec.id},data:{status:'failed'}});
  assert.ok((await f.db.$transaction(tx=>archive.changeArchive(tx,f.project.id,'archive'))).archivedAt);
  await assert.rejects(f.db.$transaction(tx=>archive.changeArchive(tx,'missing','archive')),/project_missing/);
 }finally{await f.cleanup();}
});
