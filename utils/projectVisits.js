const HOUR=3600000, DAY=24*HOUR, OFFSET=3*HOUR;
function calendar(value){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(value||''))throw new Error('invalid_date');
 const date=new Date(`${value}T00:00:00.000Z`);
 if(!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==value)throw new Error('invalid_date');
 return date.getTime()-OFFSET;
}
function visitWindow({period='today',from,to}={},now=Date.now()){
 const today=new Date(now+OFFSET).toISOString().slice(0,10),start=calendar(today);
 if(period==='all')return {period,from:null,to:null,start:null,end:null,timezone:'Europe/Moscow'};
 let first=start,last=start;
 if(period==='yesterday')first=last=start-DAY;
 else if(period==='week')first=start-6*DAY;
 else if(period==='month')first=start-29*DAY;
 else if(period==='custom'){first=calendar(from);last=calendar(to);if(first>last)throw new Error('invalid_range');}
 else if(period!=='today')throw new Error('invalid_period');
 return {period,from:new Date(first+OFFSET).toISOString().slice(0,10),to:new Date(last+OFFSET).toISOString().slice(0,10),start:new Date(first),end:new Date(last+DAY),timezone:'Europe/Moscow'};
}
async function projectVisitStats(db,projectId,options,now){
 const window=visitWindow(options,now);
 const project=await db.project.findUnique({where:{id:projectId},select:{id:true,tasks:{select:{taskType:true,searchEngine:true,searchQueries:true}}}});
 if(!project)return null;
 return aggregateVisitStats(db,{projectId},project.tasks,window);
}
async function taskVisitStats(db,taskId,options,now){
 const window=visitWindow(options,now);
 const task=await db.task.findUnique({where:{id:taskId},select:{taskType:true,searchEngine:true,searchQueries:true}});
 if(!task)return null;
 return aggregateVisitStats(db,{taskId},[task],window);
}
async function aggregateVisitStats(db,scope,tasks,window){
 const groups=await db.projectVisit.groupBy({by:['kind','query','actualQuery'],where:{...scope,...(window.start?{visitedAt:{gte:window.start,lt:window.end}}:{})},_count:{_all:true},_max:{visitedAt:true}});
 const rows=new Map();
 const emptyRow=(kind,query)=>({kind,query,count:0,plainCount:0,refinedCount:0,refinementUnknownCount:0,variants:[],lastVisitAt:null});
 for(const task of tasks)if(task.taskType==='target'&&task.searchEngine&&Array.isArray(task.searchQueries))for(const query of task.searchQueries)if(typeof query==='string'&&query.trim())rows.set(`search:${query}`,emptyRow('search',query));
 for(const group of groups){
  const key=`${group.kind}:${group.query||''}`,row=rows.get(key)||emptyRow(group.kind,group.query),count=group._count._all,lastVisitAt=group._max.visitedAt?.toISOString()||null;
  row.count+=count;
  if(lastVisitAt&&(!row.lastVisitAt||lastVisitAt>row.lastVisitAt))row.lastVisitAt=lastVisitAt;
  if(group.kind==='search'){
   if(!group.actualQuery)row.refinementUnknownCount+=count;
   else if(group.actualQuery===group.query)row.plainCount+=count;
   else {row.refinedCount+=count;row.variants.push({actualQuery:group.actualQuery,count,lastVisitAt});}
  }
  rows.set(key,row);
 }
 const items=[...rows.values()].sort((a,b)=>b.count-a.count||(a.query||a.kind).localeCompare(b.query||b.kind,'ru'));
 for(const row of items)row.variants.sort((a,b)=>b.count-a.count||a.actualQuery.localeCompare(b.actualQuery,'ru'));
 return {window:{period:window.period,from:window.from,to:window.to,timezone:window.timezone},total:items.reduce((s,r)=>s+r.count,0),search:items.filter(r=>r.kind==='search').reduce((s,r)=>s+r.count,0),refined:items.reduce((s,r)=>s+r.refinedCount,0),direct:items.filter(r=>r.kind==='direct').reduce((s,r)=>s+r.count,0),unknown:items.filter(r=>r.kind==='unknown').reduce((s,r)=>s+r.count,0),items};
}
async function recordProjectVisit(db,{projectId,taskId,executionId,query=null,actualQuery=null,engine='',visitedAt=new Date()}){
 if(!projectId)return;
 const data={projectId,taskId,executionId:executionId||null,query,actualQuery,engine,kind:engine?(query?'search':'unknown'):'direct',visitedAt,source:'observed'};
 if(executionId)return db.projectVisit.upsert({where:{executionId},create:data,update:{}});
 return db.projectVisit.create({data});
}
module.exports={visitWindow,projectVisitStats,taskVisitStats,recordProjectVisit};
