import { withAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { apiError, json } from '@/lib/api';
import { taskLiveFiles } from '@/lib/task-live';
import { liveEventStream } from '@/utils/liveEvents';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const GET=withAuth(async(request:Request,{params}:{params:Promise<{id:string}>})=>{
 try{
  const {id}=await params;
  const task=await prisma.task.findUnique({where:{id},select:{projectId:true}});
  if(!task)return json({error:'Задача не найдена'},404);
  if(!task.projectId)return json({error:'Наблюдение доступно для задач проекта'},400);
  const projectId=task.projectId;
  const requested=new URL(request.url).searchParams.get('executionId');
  if(requested&&!await prisma.taskExecution.findFirst({where:{id:requested,taskId:id},select:{id:true}}))return json({error:'Сеанс задачи не найден'},404);
  const selected=requested||(await prisma.taskExecution.findFirst({where:{taskId:id,status:'running'},orderBy:{startedAt:'desc'},select:{id:true}}))?.id||(await prisma.taskExecution.findFirst({where:{taskId:id},orderBy:{startedAt:'desc'},select:{id:true}}))?.id;
  const stream=liveEventStream({signal:request.signal,getSocket:async()=>(await taskLiveFiles(projectId,id,selected))?.socket||null});
  return new Response(stream,{headers:{'Content-Type':'text/event-stream','Cache-Control':'no-store, no-transform','X-Accel-Buffering':'no','X-Content-Type-Options':'nosniff'}});
 }catch(error){return apiError(error);}
});
