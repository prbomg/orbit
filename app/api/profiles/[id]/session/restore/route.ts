import { withAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { Prisma } from '@prisma/client';
import { ApiError,apiError,json,checkDeleteOrigin } from '@/lib/api';
import { open,writeFile,rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import snapshots from '@/utils/profileSnapshots';
import state from '@/utils/sessionState';
import fp from '@/utils/fingerprint';
import publication from '@/utils/profilePublication';
import { preparePersistentProfile } from '@/worker/persistent-profile.mjs';
export const runtime='nodejs';
export const POST=withAuth(async(request:Request,{params}:{params:Promise<{id:string}>})=>{
 let temporary:string|undefined;
 let publicationId:string|undefined;
 let nativeBackup:Awaited<ReturnType<typeof preparePersistentProfile>>|undefined;
 const root=resolve(process.cwd(),process.env.WORKER_PROFILES_DIR??'profiles');
 try{
  checkDeleteOrigin(request); const {id}=await params;
  if(!/^[a-f0-9-]{36}$/i.test(id))throw new ApiError(400,'Некорректный профиль');
  const target=resolve(root,`${id}.json`); publicationId=id;
  const result=await prisma.$transaction(async tx=>{
   await tx.$executeRaw`UPDATE "Settings" SET "id"="id" WHERE "id"=1`;
   const profile=await tx.profile.findUnique({where:{id},include:{warmupJob:{select:{totalStages:true}}}});
   if(!profile||profile.deletedAt)throw new ApiError(404,'Профиль не найден');
   if(profile.status==='banned')throw new ApiError(409,'Профиль заблокирован');
   if(await tx.workflowLease.count({where:{key:`profile:${id}`,expiresAt:{gt:new Date()}}}) || await tx.warmupJob.count({where:{profileId:id,status:'running'}}) || await tx.taskExecution.count({where:{profileId:id,status:'running'}}))throw new ApiError(409,'Профиль занят. Дождитесь завершения сеанса.');
   await publication.recoverProfilePublication(tx,{directory:root,profileId:id});
   let backup;
   const file=await open(`${target}.previous`,constants.O_RDONLY|constants.O_NOFOLLOW);
   try{const stat=await file.stat();if(!stat.isFile()||stat.size>10000000)throw new ApiError(400,'Резервная копия повреждена');backup=JSON.parse(await file.readFile('utf8'));}finally{await file.close();}
   if(backup.profileId!==id||!backup.savedAt||!snapshots.checkSnapshot(backup))throw new ApiError(400,'Резервная копия не прошла проверку');
   state.storageStateSchema.parse(backup);
   if(!profile.fingerprint || snapshots.passportHash(backup)!==fp.identityHash(id,profile.fingerprint))throw new ApiError(400,'Паспорт резервной копии отличается от текущего');
   // The original backup has passed its own versioned checksum. Keep its
   // storage state, but apply the current passport's browser metadata.
   const currentPassport=fp.devicePassport(profile.fingerprint);
   backup={...backup,fingerprint:currentPassport.fingerprint,headers:currentPassport.headers};
   if(profile.storageMode==='persistent'){
    if(!backup.snapshot?.id)throw new ApiError(409,'У резервного снимка нет связанной копии каталога Chromium.');
    try{nativeBackup=await preparePersistentProfile(root,id,{source:'previous',expectedSnapshotId:backup.snapshot.id});}
    catch{throw new ApiError(409,'Полная резервная копия Chromium отсутствует или не соответствует снимку. JSON не заменяет нативное хранилище.');}
   }
   // Restoration is a new publication even when the backup predates snapshot IDs.
   backup=snapshots.stampSnapshot(backup,profile.storageMode,backup.snapshot?.warmupStage);
   temporary=resolve(root,`.${id}.${randomUUID()}.restore`);
   await writeFile(temporary,JSON.stringify(backup),{mode:0o600,flag:'wx'});
   const stagedFile=await open(temporary,'r');try{await stagedFile.sync();}finally{await stagedFile.close();}
   await nativeBackup?.seal(backup.savedAt,backup.snapshot.id);
   await tx.profile.update({where:{id},data:{status:profile.warmedAt?'needs_check':'queued',snapshotId:backup.snapshot.id,storageResetRequested:!nativeBackup,sessionCheck:Prisma.DbNull,readinessVersion:0,readinessVerifiedAt:null,readinessValidUntil:null}});
   await tx.warmupJob.updateMany({where:{profileId:id},data:{status:'paused',owner:null,stage:'session_restored',...(!profile.warmedAt?{currentStage:Math.min(profile.warmupJob?.totalStages??1,(backup.snapshot?.warmupStage??0)+1),progress:0}:{} )}});
   await tx.profileWarmupEvent.create({data:{profileId:id,event:'session_restored',details:{reason:'previous_snapshot'},createdAt:new Date()}});
   await publication.publishProfileFiles({directory:root,profileId:id,stagedPath:temporary,persistentPath:nativeBackup?.path,previousSnapshotId:profile.snapshotId,nextSnapshotId:backup.snapshot.id,allowInvalidPrevious:true});
   return {restored:true,requiresVerification:true};
  },{timeout:60000});
  return json(result);
 }catch(error){if((error as NodeJS.ErrnoException)?.code==='ENOENT')return json({error:'Резервная копия не найдена'},404);return apiError(error);}
 finally{
  if(publicationId && await publication.hasPendingPublication(root,publicationId)) {
   const id=publicationId;
   await prisma.$transaction(async tx=>{
    await tx.$executeRaw`UPDATE "Settings" SET "id"="id" WHERE "id"=1`;
    if(await tx.workflowLease.count({where:{key:`profile:${id}`,expiresAt:{gt:new Date()}}}))return;
    await publication.recoverProfilePublication(tx,{directory:root,profileId:id});
   }).catch(()=>{}); // The worker retries recovery; keep the durable journal.
  }
  if(temporary)await rm(temporary,{force:true});
  // Keep an uncommitted native run if the durable publication needs recovery.
  if(nativeBackup && (!publicationId || !await publication.hasPendingPublication(root,publicationId)))await nativeBackup.discard().catch(()=>{});
 }
});
