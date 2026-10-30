import test from 'node:test';
import assert from 'node:assert/strict';
import {PrismaClient} from '@prisma/client';
import {chromium} from 'playwright';
import {mkdtemp,readFile,rm,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {authHeaders} from './helpers/auth.mjs';
import fp from '../utils/fingerprint.js';
import {stageMobileProfile} from '../worker/profiles.mjs';
import {attestedSession} from './helpers/attestation.mjs';
import {preparePersistentProfile} from '../worker/persistent-profile.mjs';
import publication from '../utils/profilePublication.js';
import {recoverProfileSaves} from '../worker/profile-publication.mjs';
import plans from '../utils/warmupPlan.js';

test('profile diagnostics and restore protect busy profiles and require verification after restoring', {timeout:60000}, async()=>{
 const base=process.env.API_TEST_BASE_URL;assert.ok(base&&new URL(base).hostname==='127.0.0.1');
 const directory=process.env.WORKER_PROFILES_DIR;assert.ok(directory?.startsWith('/tmp/'));
 const db=new PrismaClient(),headers=await authHeaders();let row,browser;
 try{
  const passport=fp.localPassport({fingerprintMode:'local'});row=await db.profile.create({data:{name:'Restore fixture',fingerprint:passport,fingerprintState:'verified',status:'ready',warmedAt:new Date(),readinessVerifiedAt:new Date(),readinessValidUntil:new Date(Date.now()+3600000)}});
  await db.profile.update({where:{id:row.id},data:{fingerprintHash:fp.identityHash(row.id,passport)}});
  await db.warmupJob.create({data:{profileId:row.id,status:'completed',currentStage:6,totalStages:6}});
  const profile=fp.profileFromPassport(row.id,passport),save=async value=>{const staged=await stageMobileProfile(directory,profile,{storageState:async()=>({cookies:[],origins:[{origin:'https://example.test',localStorage:[{name:'state',value}]}]})});await staged.publish();return staged;};
  const first=await save('previous'),second=await save('current');
  await db.profile.update({where:{id:row.id},data:{snapshotId:second.snapshot.snapshot.id,readinessVersion:1,sessionCheck:attestedSession(second.summary).sessionCheck}});
  const endpoint=`${base}/api/profiles/${row.id}/session/restore/`;
  assert.equal((await fetch(endpoint,{method:'POST'})).status,401);
  await db.workflowLease.create({data:{key:`profile:${row.id}`,owner:'fixture',expiresAt:new Date(Date.now()+60000)}});
  assert.equal((await fetch(endpoint,{method:'POST',headers})).status,409);
  assert.equal((await fetch(`${base}/api/profiles/${row.id}/`,{method:'PATCH',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({storageMode:'persistent'})})).status,409);
  await db.workflowLease.delete({where:{key:`profile:${row.id}`}});
  browser=await chromium.launch({headless:true,executablePath:process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH});
  const context=await browser.newContext({viewport:{width:1400,height:1000}});await context.addCookies([{name:'orbit_session',value:headers.Cookie.split('=')[1],url:base}]);const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`${base}/profiles/?profile=${row.id}`);
  await page.getByRole('button',{name:'Сессия',exact:true}).click();
  await page.getByText('Восстановление проверено после полного перезапуска браузера.',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Восстановить из резервной копии',exact:true}).click();
  const response=page.waitForResponse(r=>r.url()===endpoint&&r.request().method()==='POST');
  await page.getByRole('button',{name:'Восстановить предыдущую сессию',exact:true}).click();const restoredResponse=await response;assert.equal(restoredResponse.status(),200,await restoredResponse.text());
  const restored=await db.profile.findUnique({where:{id:row.id}});assert.equal(restored.status,'needs_check');assert.equal(restored.readinessValidUntil,null);assert.equal(restored.readinessVersion,0);assert.notEqual(restored.snapshotId,first.snapshot.snapshot.id);assert.notEqual(restored.snapshotId,second.snapshot.snapshot.id);assert.equal(restored.storageResetRequested,true);
  assert.equal(JSON.parse(await readFile(join(directory,`${row.id}.json`),'utf8')).origins[0].localStorage[0].value,'previous');
  assert.equal((await fetch(`${base}/api/profiles/${row.id}/`,{method:'PATCH',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({storageMode:'persistent'})})).status,200);
  const switched=await db.profile.findUnique({where:{id:row.id}});assert.equal(switched.storageMode,'persistent');assert.equal(switched.storageResetRequested,true);assert.equal(switched.readinessValidUntil,null);
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);
 }finally{
  await browser?.close();
  if(row){await db.profileWarmupEvent.deleteMany({where:{profileId:row.id}});await db.warmupJob.deleteMany({where:{profileId:row.id}});await db.workflowLease.deleteMany({where:{key:`profile:${row.id}`}});await db.profile.delete({where:{id:row.id}});for(const suffix of ['.json','.json.previous'])await rm(join(directory,`${row.id}${suffix}`),{force:true});}
  await db.$disconnect();
 }
});

test('restoring an unfinished profile respects its saved one-, two- or six-stage plan', async()=>{
 const base=process.env.API_TEST_BASE_URL,directory=process.env.WORKER_PROFILES_DIR;
 assert.ok(base&&new URL(base).hostname==='127.0.0.1'&&directory?.startsWith('/tmp/'));
 const db=new PrismaClient(),headers=await authHeaders();
 try{
  for(const preset of ['storage','revisit','standard']){
   let row;
   try{
    const plan=plans.createPlan({warmupPlanPreset:preset}),totalStages=plan.offsetsHours.length;
    const passport=fp.localPassport({fingerprintMode:'local'});
    row=await db.profile.create({data:{name:'Unfinished restore',storageMode:'snapshot',fingerprint:passport,status:'queued'}});
    await db.warmupJob.create({data:{profileId:row.id,status:'waiting_stage',currentStage:totalStages,totalStages,plan}});
    const profile=fp.profileFromPassport(row.id,passport);
    let latest;
    for(const value of ['previous','current']){
     const staged=await stageMobileProfile(directory,profile,{storageState:async()=>({cookies:[],origins:[{origin:'https://short-plan.test',localStorage:[{name:'state',value}]}]})},{warmupStage:totalStages});
     await staged.publish();latest=staged.snapshot;
    }
    await db.profile.update({where:{id:row.id},data:{snapshotId:latest.snapshot.id}});
    const response=await fetch(`${base}/api/profiles/${row.id}/session/restore/`,{method:'POST',headers});
    assert.equal(response.status,200,await response.text());
    const job=await db.warmupJob.findUniqueOrThrow({where:{profileId:row.id}});
    assert.equal(job.currentStage,totalStages,preset);assert.equal(job.totalStages,totalStages);assert.equal(job.status,'paused');
    assert.equal((await db.profile.findUniqueOrThrow({where:{id:row.id}})).warmedAt,null);
   }finally{
    if(row){await db.profileWarmupEvent.deleteMany({where:{profileId:row.id}});await db.warmupJob.deleteMany({where:{profileId:row.id}});await db.profile.delete({where:{id:row.id}});for(const suffix of ['.json','.json.previous'])await rm(join(directory,`${row.id}${suffix}`),{force:true});}
   }
  }
 }finally{await db.$disconnect();}
});

test('persistent restore publishes the matching native backup, rejects mismatches and protects live leases', {timeout:60000}, async()=>{
 const base=process.env.API_TEST_BASE_URL,directory=process.env.WORKER_PROFILES_DIR;
 assert.ok(base&&new URL(base).hostname==='127.0.0.1'&&directory?.startsWith('/tmp/'));
 const db=new PrismaClient(),headers=await authHeaders();let row;
 try{
  const passport=fp.localPassport({fingerprintMode:'local'});
  row=await db.profile.create({data:{name:'Native restore fixture',storageMode:'persistent',fingerprint:passport,status:'ready',warmedAt:new Date()}});
  const identity=fp.identityHash(row.id,passport);await db.profile.update({where:{id:row.id},data:{fingerprintHash:identity}});
  const profile=fp.profileFromPassport(row.id,passport),saved=[];
  let previousSnapshotId=null;
  for(const value of ['previous','current']){
   const staged=await stageMobileProfile(directory,profile,{storageState:async()=>({cookies:[],origins:[{origin:'https://native.test',localStorage:[{name:'state',value}]}]})},{storageMode:'persistent'});
   const native=await preparePersistentProfile(directory,row.id);
   for(const file of ['Default/Network/Cookies','Default/Code Cache/script','Default/Cache/asset','Default/Service Worker/CacheStorage/record']){await mkdir(join(native.path,file,'..'),{recursive:true});await writeFile(join(native.path,file),value);}
   await native.seal(staged.snapshot.savedAt,staged.snapshot.snapshot.id);
   await db.$transaction(async tx=>{
    await tx.$executeRaw`UPDATE "Settings" SET "id"="id" WHERE "id"=1`;
    await publication.publishProfileFiles({directory,profileId:row.id,stagedPath:staged.temporary,persistentPath:native.path,previousSnapshotId,nextSnapshotId:staged.snapshot.snapshot.id});
    await tx.profile.update({where:{id:row.id},data:{snapshotId:staged.snapshot.snapshot.id}});
   });
   await recoverProfileSaves(db,directory,{profileId:row.id});
   previousSnapshotId=staged.snapshot.snapshot.id;saved.push(staged.snapshot);
  }
  const endpoint=`${base}/api/profiles/${row.id}/session/restore/`;
  await db.workflowLease.create({data:{key:`profile:${row.id}`,owner:'fixture',expiresAt:new Date(Date.now()+60000)}});
  assert.equal((await fetch(endpoint,{method:'POST',headers})).status,409);
  await db.workflowLease.delete({where:{key:`profile:${row.id}`}});
  const response=await fetch(endpoint,{method:'POST',headers});assert.equal(response.status,200,await response.text());
  const restored=await db.profile.findUniqueOrThrow({where:{id:row.id}}),json=JSON.parse(await readFile(join(directory,`${row.id}.json`),'utf8'));
  assert.equal(restored.storageMode,'persistent');assert.equal(restored.storageResetRequested,false);assert.equal(restored.status,'needs_check');assert.equal(restored.readinessVersion,0);assert.equal(restored.fingerprintHash,identity);
  assert.equal(json.origins[0].localStorage[0].value,'previous');assert.equal(json.snapshot.id,restored.snapshotId);assert.notEqual(restored.snapshotId,saved[0].snapshot.id);
  const current=join(directory,'browser-data',row.id,'current'),backup=join(directory,'browser-data',row.id,'previous');
  assert.equal(await readFile(join(current,'.orbit-snapshot-id'),'utf8'),restored.snapshotId);
  for(const file of ['Default/Network/Cookies','Default/Code Cache/script','Default/Cache/asset','Default/Service Worker/CacheStorage/record']){assert.equal(await readFile(join(current,file),'utf8'),'previous');assert.equal(await readFile(join(backup,file),'utf8'),'current');}
  await writeFile(join(backup,'.orbit-snapshot-id'),'wrong-backup');
  assert.equal((await fetch(endpoint,{method:'POST',headers})).status,409);
  assert.equal((await db.profile.findUniqueOrThrow({where:{id:row.id}})).snapshotId,restored.snapshotId);
  assert.equal(await readFile(join(current,'Default/Network/Cookies'),'utf8'),'previous');
  assert.equal(await publication.hasPendingPublication(directory,row.id),false);
 }finally{
  if(row){await db.profileWarmupEvent.deleteMany({where:{profileId:row.id}});await db.workflowLease.deleteMany({where:{key:`profile:${row.id}`}});await db.profile.delete({where:{id:row.id}});for(const suffix of ['.json','.json.previous'])await rm(join(directory,`${row.id}${suffix}`),{force:true});await rm(join(directory,'browser-data',row.id),{recursive:true,force:true});}
  await db.$disconnect();
 }
});

test('profile API reads metadata for a snapshot above the former 10 MB limit without exposing storage', async () => {
 const base=process.env.API_TEST_BASE_URL,directory=process.env.WORKER_PROFILES_DIR;
 assert.ok(base&&new URL(base).hostname==='127.0.0.1'&&directory?.startsWith('/tmp/'));
 const db=new PrismaClient(),headers=await authHeaders();let row;
 try {
  const passport=fp.localPassport({fingerprintMode:'local'});
  row=await db.profile.create({data:{name:'Large session fixture',fingerprint:passport}});
  const profile=fp.profileFromPassport(row.id,passport);
  const staged=await stageMobileProfile(directory,profile,{storageState:async()=>({cookies:[],origins:[{origin:'https://example.test',localStorage:[{name:'private-storage',value:'x'.repeat(10_100_000)}]}]})});
  await staged.publish();await staged.discard();
  const response=await fetch(`${base}/api/profiles/${row.id}/`,{headers});
  assert.equal(response.status,200);const result=await response.json();
  assert.equal(result.session.state,'saved');assert.ok(result.session.sizeBytes>10_000_000);
  assert.ok(JSON.stringify(result.session).length<5000);
  assert.ok(!JSON.stringify(result.session).includes('private-storage'));
 } finally {
  if(row){await db.profile.delete({where:{id:row.id}});await rm(join(directory,`${row.id}.json`),{force:true});}
  await db.$disconnect();
 }
});
