import { withAuth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ApiError, apiError, json } from "@/lib/api";
import { withTaskDailyState } from "@/lib/task-view";
import { readEventPage } from "@/utils/liveHistory";
import { readLiveNetwork, screenshotVersion, taskLiveFiles, taskLiveStatus, taskAttemptListCutoff } from "@/lib/task-live";
import { taskState as describeTask, nextTaskWindow } from "@/utils/dashboardState";
import type { Task, ProjectRunState } from "@/lib/data-store";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const selection={id:true,status:true,startedAt:true,completedAt:true,errorCode:true,profile:{select:{name:true}}} as const;
const valid=(v:string|null)=>v===null||/^[a-zA-Z0-9_-]{1,128}$/.test(v);
export const GET=withAuth(async(request:Request,{params}:{params:Promise<{id:string}>})=>{
 try{
  const {id}=await params,q=new URL(request.url).searchParams,requested=q.get('executionId'),cursor=q.get('executionCursor'),before=q.get('eventsBefore');
  if(!valid(requested)||!valid(cursor)||before!==null&&(!/^\d{1,16}$/.test(before)||!Number.isSafeInteger(Number(before))))throw new ApiError(400,'Некорректная позиция истории.');
  const row=await prisma.task.findUnique({where:{id},select:{id:true,projectId:true,status:true,currentExecutions:true,targetExecutions:true,concurrency:true,dailyExecutionLimit:true,retryState:true,project:{select:{scheduleHours:true,scheduleTimezone:true}},executions:{where:{status:'running'},select:{id:true,status:true,profileId:true}}}});
  if(!row)return json({error:'Задача не найдена'},404);if(!row.projectId)return json({error:'Наблюдение доступно для задач проекта'},400);
  const cutoff=await taskAttemptListCutoff(),attemptsVisibleSince=cutoff?.toISOString()??null;
  const visibleWhere={taskId:id,...(cutoff?{OR:[{status:'running'},{startedAt:{gte:cutoff}}]}:{})};
  if(cursor&&!await prisma.taskExecution.findFirst({where:{...visibleWhere,id:cursor},select:{id:true}}))return json({error:'Попытка задачи не найдена'},404);
  const [page,total]=await Promise.all([prisma.taskExecution.findMany({where:visibleWhere,orderBy:[{startedAt:'desc'},{id:'desc'}],take:31,...(cursor?{cursor:{id:cursor},skip:1}:{}),select:selection}),prisma.taskExecution.count({where:visibleWhere})]);
  const executions=page.slice(0,30),executionCursor=page.length>30?executions.at(-1)!.id:null;
  const selectedExecution=requested?await prisma.taskExecution.findFirst({where:{taskId:id,id:requested},select:selection}):await prisma.taskExecution.findFirst({where:{taskId:id,status:'running'},orderBy:[{startedAt:'desc'},{id:'desc'}],select:selection})||executions[0]||null;
  if(requested&&!selectedExecution)return json({error:'Попытка задачи не найдена'},404);
  const selected=selectedExecution?.id||null,files=selected?await taskLiveFiles(row.projectId,id,selected):null,task=await withTaskDailyState(row),run=taskLiveStatus(row.projectId,id);
  const [eventPage,imageVersion,network]=files?await Promise.all([readEventPage(files.events,before===null?{}:{before:Number(before)}),screenshotVersion(files.screenshot),readLiveNetwork(files.network,selected)]):[{events:[],nextCursor:null},null,null];
  const began=selectedExecution?.startedAt?.getTime()||0;
  const events=eventPage.events.filter(e=>!began||Date.parse(e.time)>=began);
  const eventsCursor=began&&eventPage.events.some(e=>Date.parse(e.time)<began)?null:eventPage.nextCursor;
  const currentImage=imageVersion!==null&&imageVersion>=began?imageVersion:null;
  const currentNetwork=network&&(!began||network.checkedAt&&Date.parse(network.checkedAt)>=began)?network:null;
  const active=selectedExecution?.status==='running'&&['running','waiting','stopping'].includes(run.state);
  const nextAt=row.project?nextTaskWindow(row.project,task as unknown as Task,{...run,projectId:row.projectId} as ProjectRunState):null;
  return json({attemptsVisibleSince,task,taskState:describeTask(task as unknown as Task,{...run,projectId:row.projectId} as ProjectRunState),run:{...run,active:Boolean(active)},executions,executionCursor,executionTotal:total,selectedExecution,selectedExecutionId:selected,events,eventsCursor,eventSource:files?.record.runId||null,imageVersion:currentImage,network:currentNetwork,nextAt});
 }catch(error){return apiError(error);}
});
