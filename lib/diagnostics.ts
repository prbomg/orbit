import "server-only";
import { resolve } from "node:path";
import { prisma } from "@/lib/prisma";
import { readLiveNetwork, taskLiveFiles } from "@/lib/task-live";
import { readDiagnosticLog, diagnosticFileIndex } from "@/utils/diagnosticLogs";
import { attemptDiagnostics, aggregateDiagnostics, type DiagnosticExecution, type AssignedProxy } from "@/utils/attemptDiagnostics";
import { visitWindow } from "@/utils/projectVisits";
import { ApiError } from "@/lib/api";

const runtime = resolve(process.env.ORBIT_LIVE_RUNTIME_DIRECTORY || resolve(process.cwd(), ".orbit-runtime"));
const emptyLog = {events:[],available:false,truncated:false,invalidLines:0};
const selection = {id:true,taskId:true,proxyId:true,status:true,errorCode:true,startedAt:true,completedAt:true,profile:{select:{id:true,name:true}},task:{select:{projectId:true,project:{select:{id:true,name:true}}}}} as const;
const serialize = (row: Awaited<ReturnType<typeof loadExecution>>): DiagnosticExecution => ({...row,startedAt:row.startedAt?.toISOString()||null,completedAt:row.completedAt?.toISOString()||null});
async function loadExecution(taskId:string,executionId:string) {
 const row = await prisma.taskExecution.findFirst({where:{id:executionId,taskId},select:selection});
 if(!row)throw new ApiError(404,'Попытка задачи не найдена');return row;
}
export async function selectedDiagnostic(taskId:string,executionId:string) {
 const row=await loadExecution(taskId,executionId);
 const [files,proxy]=await Promise.all([row.task.projectId?taskLiveFiles(row.task.projectId,taskId,row.id):null,row.proxyId?prisma.proxy.findUnique({where:{id:row.proxyId},select:{id:true,host:true,port:true}}):null]);
 const [log,network]=files?await Promise.all([readDiagnosticLog(files.events),readLiveNetwork(files.network,row.id)]):[emptyLog,null];
 return attemptDiagnostics(serialize(row),log,network,proxy);
}

type Summary = Awaited<ReturnType<typeof buildSummary>>;
const cached = new Map<string,{expires:number;value:Summary}>();
const inFlight = new Map<string,Promise<Summary>>();
export async function diagnosticSummary(period:string,projectId:string|null) {
 const key=`${period}:${projectId||'*'}`,existing=cached.get(key);
 if(existing&&existing.expires>Date.now())return existing.value;
 const running=inFlight.get(key);if(running)return running;
 const operation=buildSummary(period,projectId).then(value=>{cached.set(key,{expires:Date.now()+15000,value});if(cached.size>16)cached.delete(cached.keys().next().value!);return value;}).finally(()=>inFlight.delete(key));
 inFlight.set(key,operation);return operation;
}
async function buildSummary(period:string,projectId:string|null) {
 const now=Date.now(),window=visitWindow({period},now) as {start:Date;end:Date;from:string;to:string;timezone:string};
 if(projectId&&!await prisma.project.findUnique({where:{id:projectId},select:{id:true}}))throw new ApiError(404,'Проект не найден');
 const where={startedAt:{gte:window.start!,lt:new Date(Math.min(+window.end!,now+1))},task:{projectId:projectId?projectId:{not:null}}};
 const [total,rows,projects,index,assigned]=await Promise.all([
  prisma.taskExecution.count({where}),
  prisma.taskExecution.findMany({where,select:selection,orderBy:[{startedAt:'desc'},{id:'desc'}],take:5000}),
  prisma.project.findMany({select:{id:true,name:true,archivedAt:true},orderBy:{name:'asc'}}),
  diagnosticFileIndex(runtime),prisma.proxy.findMany({select:{id:true,host:true,port:true}}),
 ]);
 const proxyMap=new Map<string,AssignedProxy>(assigned.map(proxy=>[proxy.id,proxy]));
 const records: {execution:DiagnosticExecution;diagnostic:ReturnType<typeof attemptDiagnostics>}[]=new Array(rows.length);let at=0;
 await Promise.all(Array.from({length:Math.min(4,rows.length)},async()=>{for(;;){const offset=at++;if(offset>=rows.length)return;const row=rows[offset],file=index.get(row.id);
  const [log,network]=await Promise.all([file?.events?readDiagnosticLog(file.events.path):emptyLog,file?.network?readLiveNetwork(file.network.path,row.id):null]);
  const execution=serialize(row);records[offset]={execution,diagnostic:attemptDiagnostics(execution,log,network,row.proxyId?proxyMap.get(row.proxyId)||null:null,now,{includeStages:false})};
 }}));
 const taskIds=new Map(rows.map(row=>[row.id,row.taskId]));
 const stats=aggregateDiagnostics(records),recent=records.filter(r=>r.execution.status==='failed'&&r.execution.errorCode!=='stopped').map(({execution:e,diagnostic:d})=>({id:e.id,taskId:taskIds.get(e.id)!,projectName:e.task?.project?.name||'Без проекта',errorCode:e.errorCode,startedAt:e.startedAt,browserIp:d.network?.browserIp||null,proxy:d.assignedProxy?`${d.assignedProxy.host}:${d.assignedProxy.port}`:null}));
 return {period,projectId,window:{from:window.from,to:window.to,timezone:window.timezone},total,limited:total>rows.length,projects,stats,recent,checkedAt:new Date(now).toISOString()};
}
