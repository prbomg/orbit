const {createHash,randomUUID}=require('node:crypto');
const {copyFile,rename,rm,open,chmod}=require('node:fs/promises');
const {dirname}=require('node:path');
const fp=require('./fingerprint.js');
function snapshotHash(profile){const {snapshot,...data}=profile;return createHash('sha256').update(JSON.stringify(data)).digest('hex');}
function passportHash(profile){return fp.identityHash(profile.profileId,{fingerprint:profile.fingerprint,headers:profile.headers,canvasSeed:profile.canvasSeed,timezone:profile.passport?.timezone??null});}
function legacyPassportHash(profile){return fp.legacyIdentityHash(profile.profileId,{fingerprint:profile.fingerprint,headers:profile.headers,canvasSeed:profile.canvasSeed,timezone:profile.passport?.timezone??null});}
function stampSnapshot(profile,storageMode='snapshot',warmupStage) {
 return {...profile,snapshot:{version:1,identityHashVersion:fp.CURRENT_IDENTITY_HASH_VERSION,id:randomUUID(),passportHash:passportHash(profile),contentHash:snapshotHash(profile),storageMode,...(warmupStage?{warmupStage}:{})}};
}
function checkSnapshot(profile){
 if(!profile.snapshot)return true; // Existing profiles upgrade on their next verified save.
 const version=profile.snapshot.identityHashVersion;
 if(version!==undefined&&version!==fp.CURRENT_IDENTITY_HASH_VERSION)return false;
 return profile.snapshot.version===1 && profile.snapshot.passportHash===(version===undefined?legacyPassportHash(profile):passportHash(profile)) && profile.snapshot.contentHash===snapshotHash(profile);
}
async function publishSnapshot(temporary,target){
 const backup=`${target}.previous`,staging=`${backup}.${randomUUID()}.tmp`;
 try{await copyFile(target,staging);await chmod(staging,0o600);const file=await open(staging,'r');try{await file.sync();}finally{await file.close();}await rename(staging,backup);}
 catch(error){await rm(staging,{force:true});if(error.code!=='ENOENT')throw error;}
 await rename(temporary,target);
 const directory=await open(dirname(target),'r');try{await directory.sync();}finally{await directory.close();}
}
module.exports={snapshotHash,passportHash,legacyPassportHash,stampSnapshot,checkSnapshot,publishSnapshot};
