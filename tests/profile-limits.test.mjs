import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { maxProfileBytes, DEFAULT_MAX_PROFILE_BYTES } from '../worker/profile-limits.mjs';
import { stageMobileProfile, loadMobileProfile } from '../worker/profiles.mjs';
import publication from '../utils/profilePublication.js';
import { mobileProfileFixture } from './helpers/mobile-profile-fixture.mjs';

test('profile limit defaults to 50 MB and validates explicit configuration', () => {
 assert.equal(DEFAULT_MAX_PROFILE_BYTES,50_000_000);assert.equal(maxProfileBytes('2000000'),2_000_000);
 for(const value of [0,-1,1.5,NaN,Infinity,true,{},'bad',1_000_000_001])assert.throws(()=>maxProfileBytes(value),{code:'invalid_max_profile_bytes'});
});
test('profile size is checked before atomic publication and configured reads agree', async () => {
 const dir=await mkdtemp(join(tmpdir(),'orbit-profile-limit-'));
 try {
  const profile=mobileProfileFixture('size-fixture');
  const context={storageState:async()=>({cookies:[],origins:[]})};
  await assert.rejects(stageMobileProfile(dir,profile,context,{maxProfileBytes:100}),{code:'profile_too_large'});
  assert.deepEqual(await readdir(dir),[]);
  const staged=await stageMobileProfile(dir,profile,context,{maxProfileBytes:1000000});
  await staged.publish();await staged.discard();
  assert.equal((await loadMobileProfile(dir,'size-fixture',undefined,undefined,{maxProfileBytes:1000000})).reused,true);
  await assert.rejects(loadMobileProfile(dir,'size-fixture',undefined,undefined,{maxProfileBytes:100}),{code:'profile_too_large'});
 } finally { await rm(dir,{recursive:true,force:true}); }
});


test('default limit accepts and reloads a snapshot larger than the former 10 MB cap',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'orbit-profile-large-'));
 try {
  const profile=mobileProfileFixture('large-fixture');
  const payload='x'.repeat(10_100_000);
  const context={storageState:async()=>({cookies:[],origins:[{origin:'https://example.test',localStorage:[{name:'fixture',value:payload}]}]})};
  const staged=await stageMobileProfile(dir,profile,context);await staged.publish();await staged.discard();
  const loaded=await loadMobileProfile(dir,'large-fixture');
  assert.equal(loaded.profile.origins[0].localStorage[0].value.length,payload.length);
 }finally{await rm(dir,{recursive:true,force:true});}
});


test('large snapshots pass journal publication and recovery with the shared configurable limit', async () => {
 const dir=await mkdtemp(join(tmpdir(),'orbit-publication-limit-'));
 try {
  const profile=mobileProfileFixture('large-publication');
  const context={storageState:async()=>({cookies:[],origins:[{origin:'https://example.test',localStorage:[{name:'fixture',value:'x'.repeat(10_100_000)}]}]})};
  const staged=await stageMobileProfile(dir,profile,context);
  const options={directory:dir,profileId:profile.profileId,stagedPath:staged.temporary,nextSnapshotId:staged.summary.snapshotId};
  await assert.rejects(publication.publishProfileFiles({...options,maxProfileBytes:100}),{code:'profile_too_large'});
  assert.equal(await publication.hasPendingPublication(dir,profile.profileId),false);
  await publication.publishProfileFiles(options);
  const tx={profile:{findUnique:async()=>({snapshotId:staged.summary.snapshotId,deletedAt:null})}};
  assert.equal(await publication.recoverProfilePublication(tx,options),'committed');
  assert.equal(await publication.hasPendingPublication(dir,profile.profileId),false);
  assert.equal((await loadMobileProfile(dir,profile.profileId)).profile.snapshot.id,staged.summary.snapshotId);
  await staged.discard();
 }finally{await rm(dir,{recursive:true,force:true});}
});
