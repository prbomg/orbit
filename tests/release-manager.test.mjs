import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, stat, rename, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import releases from '../utils/releaseManager.js';
import resources from '../utils/serviceResources.js';

async function fixture(run) {
 const root=await mkdtemp(join(tmpdir(),'orbit-release-test-')),catalog=join(root,'releases'),data=join(root,'data');
 await mkdir(catalog);await mkdir(data);await writeFile(join(data,'keep'),'profile-data');
 for(const id of ['20261001-old','20261002-old','20261003-current']){await mkdir(join(catalog,id));await writeFile(join(catalog,id,'code'),Buffer.alloc(1000000));}
 await symlink(join(catalog,'20261003-current'),join(root,'current'));
 const config={application:root,release:join(catalog,'20261003-current'),data,logs:join(root,'logs')};
 const manager=releases.createReleaseManager(config);
 try{await run({root,catalog,data,config,manager});}finally{await manager.waitForCleanup();await rm(root,{recursive:true,force:true});}
}
async function completed(manager,id){
 for(let i=0;i<200;i++){const job=(await manager.list()).deletions.find(job=>job.id===id);if(job&&job.status!=='deleting')return job;await new Promise(r=>setTimeout(r,10));}
 throw new Error('Deletion did not finish');
}
test('current, live process, symbolic links and staging releases cannot be deleted',async()=>{
 await fixture(async f=>{
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{cwd:join(f.catalog,'20261002-old'),stdio:'ignore'});
  try{
   await symlink(f.data,join(f.catalog,'linked-data'));await writeFile(join(f.catalog,'20261001-old','.orbit-release.json'),JSON.stringify({state:'preparing'}));
   const rows=(await f.manager.list()).releases;
   assert.ok(rows.find(r=>r.id==='20261003-current').reasons.includes('current'));
   assert.ok(rows.find(r=>r.id==='20261002-old').reasons.includes('in_use'));
   assert.ok(rows.find(r=>r.id==='linked-data').reasons.includes('unsafe'));
   assert.ok(rows.find(r=>r.id==='20261001-old').reasons.includes('preparing'));
   for(const row of rows)await assert.rejects(f.manager.deleteSelected([{id:row.id,revision:row.revision}]),e=>e.code==='release_protected');
   assert.ok(rows.every(row=>!Number.isNaN(Date.parse(row.savedAt))));
  }finally{child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));}
 });
});
test('mixed protected selection, invalid paths and changed revisions remove nothing',async()=>{
 await fixture(async f=>{
  const rows=(await f.manager.list()).releases;
  await assert.rejects(f.manager.deleteSelected(rows.filter(r=>r.id!=='20261002-old').map(({id,revision})=>({id,revision}))),e=>e.code==='release_protected');
  await assert.rejects(f.manager.deleteSelected([{id:'../data',revision:'a'.repeat(64)}]),e=>e.code==='invalid_selection');
  const old=rows.find(r=>r.id==='20261001-old');await writeFile(join(f.catalog,old.id,'new-file'),'changed');
  await assert.rejects(f.manager.deleteSelected([{id:old.id,revision:old.revision}]),e=>e.code==='release_changed');
  assert.equal((await readFile(join(f.data,'keep'),'utf8')),'profile-data');await access(join(f.catalog,'20261002-old'));
 });
});
test('confirmed deletion removes only selected versions, leaves symlink targets and invalidates disk cache',async()=>{
 await fixture(async f=>{
  await symlink(f.data,join(f.catalog,'20261001-old','data-link'));
  const monitor=resources.resourceMonitor(f.config);
  const measured=async()=>{let value;const deadline=Date.now()+5000;do{value=await monitor();if(value.disk.scanState==='idle'&&value.disk.complete)return value;await new Promise(r=>setTimeout(r,20));}while(Date.now()<deadline);throw new Error('Disk scan did not complete');};
  const before=await measured();
  const rows=(await f.manager.list()).releases;await f.manager.waitForCleanup();
  const selected=rows.filter(r=>!r.protected).map(({id,revision})=>({id,revision}));
  const job=await f.manager.deleteSelected(selected);assert.equal(job.status,'deleting');
  const done=await completed(f.manager,job.id);await f.manager.waitForCleanup();assert.equal(done.status,'completed');assert.equal(done.done,2);
  await assert.rejects(access(join(f.catalog,'20261001-old')),{code:'ENOENT'});await access(join(f.catalog,'20261003-current'));
  assert.equal(await readFile(join(f.data,'keep'),'utf8'),'profile-data');
  const after=await measured();assert.ok(after.disk.bytes<before.disk.bytes);assert.notEqual(after.disk.measuredAt,before.disk.measuredAt);
 });
});
test('concurrent duplicate requests cannot remove a selected release twice',async()=>{
 await fixture(async f=>{
  const row=(await f.manager.list()).releases.find(r=>!r.protected),selected=[{id:row.id,revision:row.revision}];
  const responses=await Promise.allSettled([f.manager.deleteSelected(selected),f.manager.deleteSelected(selected)]);
  assert.equal(responses.filter(r=>r.status==='fulfilled').length,1);assert.equal(responses.filter(r=>r.status==='rejected').length,1);
  const job=responses.find(r=>r.status==='fulfilled').value;assert.equal((await completed(f.manager,job.id)).status,'completed');
 });
});
test('failed cleanup can be retried by a new manager after process restart',async()=>{
 await fixture(async f=>{
  const failing=releases.createReleaseManager(f.config,{remove:async()=>{throw new Error('Permission denied');}});
  const row=(await failing.list()).releases.find(r=>!r.protected);
  const job=await failing.deleteSelected([{id:row.id,revision:row.revision}]);assert.equal((await completed(failing,job.id)).status,'failed');await failing.waitForCleanup();
  const restarted=releases.createReleaseManager(f.config);await restarted.retry(job.id);assert.equal((await completed(restarted,job.id)).status,'completed');await restarted.waitForCleanup();
 });
});
test('an interrupted uncommitted preparation restores detached directories',async()=>{
 await fixture(async f=>{
  const id=randomUUID(),folder=join(f.root,'.release-deletions',id),files=join(folder,'files');await mkdir(files,{recursive:true});
  const items=[];for(const name of ['20261001-old','20261002-old']){const s=await stat(join(f.catalog,name));items.push({id:name,identity:`${s.dev}:${s.ino}`,done:false});}
  await writeFile(join(folder,'job.json'),JSON.stringify({id,status:'preparing',createdAt:new Date().toISOString(),items}));
  await rename(join(f.catalog,items[0].id),join(files,items[0].id));
  const result=await f.manager.list();assert.equal(result.deletions.length,0);await access(join(f.catalog,items[0].id));await access(join(f.catalog,items[1].id));
 });
});
test('persisted committed cleanup resumes after restart and deployment guard blocks deletion',async()=>{
 await fixture(async f=>{
  const row=(await f.manager.list()).releases.find(r=>!r.protected);
  await releases.withReleaseOperation(f.root,async()=>{await assert.rejects(f.manager.deleteSelected([{id:row.id,revision:row.revision}]),e=>e.code==='release_busy');});
  const id=randomUUID(),folder=join(f.root,'.release-deletions',id),files=join(folder,'files');await mkdir(files,{recursive:true});
  const s=await stat(join(f.catalog,row.id));await writeFile(join(folder,'job.json'),JSON.stringify({id,status:'deleting',createdAt:new Date().toISOString(),items:[{id:row.id,identity:`${s.dev}:${s.ino}`,done:false}]}));
  await rename(join(f.catalog,row.id),join(files,row.id));assert.equal((await completed(f.manager,id)).status,'completed');
 });
});
test('a release containing configured storage is protected even when it is not current',async()=>{
 await fixture(async f=>{
  const storage=releases.createReleaseManager({...f.config,data:join(f.catalog,'20261001-old')});
  const row=(await storage.list()).releases.find(r=>r.id==='20261001-old');assert.ok(row.reasons.includes('storage'));
  await assert.rejects(storage.deleteSelected([{id:row.id,revision:row.revision}]),e=>e.code==='release_protected');await storage.waitForCleanup();
 });
});

test('a previous release holding the current task logs is protected from deletion',async()=>{
 await fixture(async f=>{await mkdir(join(f.catalog,'20261001-old','logs'));await symlink(join(f.catalog,'20261001-old','logs'),join(f.config.release,'logs'));const row=(await f.manager.list()).releases.find(r=>r.id==='20261001-old');assert.ok(row.reasons.includes('storage'));await assert.rejects(f.manager.deleteSelected([{id:row.id,revision:row.revision}]),e=>e.code==='release_protected');});
});
