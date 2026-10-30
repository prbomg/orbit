import {cp,mkdir,rename,rm,lstat,readdir,readFile,writeFile,open} from 'node:fs/promises';
import {join,relative,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ProfileError,verifyRestoredSession} from './profiles.mjs';
import snapshots from '../utils/profileSnapshots.js';
import sessionState from '../utils/sessionState.js';
import previousCache from '../utils/previousProfileCache.js';
// Chromium evicts current HTTP cache; confirmed previous copies are cacheless.
// V8 bytecode and CacheStorage response bodies are disposable under this policy.
// Keep Service Worker Database AND ScriptCache: installed workers need both.
const caches=['Default/Cache','Default/Code Cache'];
async function syncTree(path) {
 for(const entry of await readdir(path,{withFileTypes:true})) {
  const child=join(path,entry.name);
  if(entry.isSymbolicLink())continue;
  if(entry.isDirectory())await syncTree(child);
  else {const file=await open(child,'r');try{await file.sync();}finally{await file.close();}}
 }
 const dir=await open(path,'r');try{await dir.sync();}finally{await dir.close();}
}
export async function persistentStorageStats(path){
 let totalBytes=0,cacheBytes=0;
 const walk=async(directory,prefix='',cached=false)=>{
  for(const entry of await readdir(directory,{withFileTypes:true})){
   const file=join(directory,entry.name),stat=await lstat(file);
   if(stat.isSymbolicLink())continue;
   const name=prefix?`${prefix}/${entry.name}`:entry.name;
   const disposable=cached||caches.includes(name)||previousCache.isTransientProfilePath(name);
   if(stat.isDirectory())await walk(file,name,disposable);
   else {totalBytes+=stat.size;if(disposable)cacheBytes+=stat.size;}
  }
 };
 await walk(path);
 return {totalBytes,cacheBytes,dataBytes:totalBytes-cacheBytes};
}
/** @param {string} directory @param {string} profileId
 * @param {{source?: 'current'|'previous', expectedSnapshotId?: string, seedProfile?: object}} [options] */
export async function preparePersistentProfile(directory,profileId,{source='current',expectedSnapshotId,seedProfile}={}){
 if(!/^[a-zA-Z0-9_-]{1,128}$/.test(profileId))throw new ProfileError('invalid_profile_id');
 if(!['current','previous'].includes(source))throw new ProfileError('invalid_profile_file');
 let seedSnapshot=null;
 if(seedProfile){
  if(source!=='current'||seedProfile.profileId!==profileId||!seedProfile.savedAt||!Number.isFinite(Date.parse(seedProfile.savedAt))||
   !seedProfile.snapshot?.id||seedProfile.snapshot.storageMode!=='snapshot'||!snapshots.checkSnapshot(seedProfile)||
   expectedSnapshotId&&seedProfile.snapshot.id!==expectedSnapshotId)throw new ProfileError('profile_snapshot_mismatch');
  sessionState.storageStateSchema.parse({cookies:seedProfile.cookies,origins:seedProfile.origins});
  seedSnapshot=structuredClone(seedProfile);
 }
 const root=join(directory,'browser-data',profileId),current=join(root,'current'),previous=join(root,'previous');
 await mkdir(root,{recursive:true,mode:0o700});
 const temporary=join(root,`run-${randomUUID()}`);let initialized=false;
 const origin=source==='previous'?previous:current;
 if(seedSnapshot)await mkdir(temporary,{mode:0o700});
 else try{const stat=await lstat(origin);if(!stat.isDirectory()||stat.isSymbolicLink())throw new ProfileError('invalid_profile_file');
  if(expectedSnapshotId && await readFile(join(origin,'.orbit-snapshot-id'),'utf8')!==expectedSnapshotId)throw new ProfileError('profile_storage_version_mismatch');
  await previousCache.transientProfileArtifacts(origin, { previous: source==='previous' });
  await cp(origin,temporary,{recursive:true,dereference:false,
   filter:path=>!previousCache.isTransientProfilePath(relative(origin,path).split(sep).join('/'), { previous: source==='previous' })});initialized=true;}
 catch(e){if(e.code!=='ENOENT'||source==='previous'||expectedSnapshotId){await rm(temporary,{recursive:true,force:true});throw e;}await mkdir(temporary,{mode:0o700});}
 for(const name of ['SingletonLock','SingletonSocket','SingletonCookie'])await rm(join(temporary,name),{force:true});
 try{await previousCache.pruneTransientProfileArtifacts(temporary);}
 catch(e){await rm(temporary,{recursive:true,force:true});throw e;}
 let savedAt=null,snapshotId=null;
 try{savedAt=await readFile(join(temporary,'.orbit-snapshot-at'),'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
 try{snapshotId=await readFile(join(temporary,'.orbit-snapshot-id'),'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
 let seedReport=null;
 const seed=async context=>{
   if(!seedSnapshot)return null;
   if(seedReport)return seedReport;
   await context.setStorageState({cookies:seedSnapshot.cookies.filter(cookie=>sessionState.cookieActive(cookie,Date.now())),origins:seedSnapshot.origins});
   const report=await verifyRestoredSession(context,seedSnapshot,{discoverOrigins:true});
   await writeFile(join(temporary,'.orbit-seeded-from-snapshot.json'),JSON.stringify({version:1,sourceSnapshotId:seedSnapshot.snapshot.id,sourceSavedAt:seedSnapshot.savedAt,seededAt:new Date().toISOString()})+'\n',{mode:0o600});
   seedReport=report;return report;
 };
 const seal=async(snapshotAt,id)=>{
   if(seedSnapshot&&!seedReport)throw new ProfileError('profile_storage_seed_required');
   if(snapshotAt)await writeFile(join(temporary,'.orbit-snapshot-at'),snapshotAt,{mode:0o600});
   if(id)await writeFile(join(temporary,'.orbit-snapshot-id'),id,{mode:0o600});
   await previousCache.pruneTransientProfileArtifacts(temporary);
   const stats=await persistentStorageStats(temporary);if(stats.dataBytes>100_000_000)throw new ProfileError('profile_browser_storage_limit');
   await syncTree(temporary);
   // Persist newly created directory entries before the publication journal.
   for(const parent of [root,join(directory,'browser-data'),directory]){const file=await open(parent,'r');try{await file.sync();}finally{await file.close();}}
 };
 return {path:temporary,initialized,savedAt,snapshotId,seedSnapshotId:seedSnapshot?.snapshot.id??null,seed,seal,
  publish:async(snapshotAt,id)=>{
   await seal(snapshotAt,id);
   let previousId=null;
   try{previousId=await readFile(join(current,'.orbit-snapshot-id'),'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
   const retired=join(root,`retired-${randomUUID()}`);let hadPrevious=false,old=false;
   try{await rename(previous,retired);hadPrevious=true;}catch(e){if(e.code!=='ENOENT')throw e;}
   try{try{await rename(current,previous);old=true;}catch(e){if(e.code!=='ENOENT')throw e;}await rename(temporary,current);}
   catch(e){if(old)await rename(previous,current);if(hadPrevious)await rename(retired,previous);throw e;}
   if(old)await previousCache.prunePreviousProfileCache(root,previousId);
   await rm(retired,{recursive:true,force:true});
  },discard:()=>rm(temporary,{recursive:true,force:true})};
}
