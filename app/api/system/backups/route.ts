import { Readable } from 'node:stream';
import { z } from 'zod';
import { withAuth } from '@/lib/auth';
import { apiError, json, readBody } from '@/lib/api';
import { createBackupManager, BackupError } from '@/utils/serviceBackups';
export const runtime='nodejs';
export const dynamic='force-dynamic';
const manager=createBackupManager();
const id=z.string().uuid();
const operation=z.discriminatedUnion('action',[
 z.object({action:z.literal('create'),label:z.string().max(120).optional()}).strict(),
 z.object({action:z.literal('restore'),id,confirmation:z.literal('ВОССТАНОВИТЬ')}).strict(),
 z.object({action:z.literal('protect'),id,important:z.boolean()}).strict(),
 z.object({action:z.literal('delete'),id}).strict(),
 z.object({action:z.literal('configure'),enabled:z.boolean(),intervalHours:z.number().int().min(1).max(720),retentionDays:z.number().int().min(1).max(3650)}).strict(),
]);
function failure(e:unknown){return e instanceof BackupError?json({error:e.message},e.status):apiError(e);}
export const GET=withAuth(async(request:Request)=>{try{const url=new URL(request.url),download=url.searchParams.get('download');if(download){id.parse(download);const {handle,size}=await manager.download(download);return new Response(Readable.toWeb(handle.createReadStream()) as ReadableStream,{headers:{'Content-Type':'application/gzip','Content-Disposition':`attachment; filename="orbit-service-${download}.tar.gz"`,'Content-Length':String(size),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});}return json(await manager.list());}catch(e){return failure(e);}});
export const POST=withAuth(async(request:Request)=>{try{const body=operation.parse(await readBody(request));switch(body.action){case 'create':case 'restore':return json(await manager.enqueue(body.action,body),202);case 'protect':return json(await manager.protect(body.id,body.important));case 'delete':return json(await manager.remove(body.id));case 'configure':return json(await manager.configure(body));}}catch(e){return failure(e);}});
