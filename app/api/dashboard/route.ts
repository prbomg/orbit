import { withAuth } from "@/lib/auth";
import { ApiError, apiError, json } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { visitWindow } from "@/utils/projectVisits";
import { dashboardStats } from "@/utils/dashboardStats";
import { eligibleProfiles } from "@/utils/profilePool";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = withAuth(async (request: Request) => {
  try {
    const period = new URL(request.url).searchParams.get('period') || 'today';
    if (!['today','week'].includes(period)) throw new ApiError(400, 'Выберите период: сегодня или семь дней.');
    const outcome = new URL(request.url).searchParams.get('outcome') || 'all';
    if (!['all','completed','failed'].includes(outcome)) throw new ApiError(400, 'Некорректный фильтр результата.');
    const now = new Date(); const window = visitWindow({period}, +now) as {start:Date;end:Date};
    const [stats, projects, leases, proxies, recent] = await Promise.all([
      dashboardStats(prisma, period, +now),
      prisma.project.findMany({where:{archivedAt:null},select:{id:true,name:true,targetUrl:true,scheduleHours:true,scheduleTimezone:true},orderBy:{createdAt:'desc'}}),
      prisma.workflowLease.findMany({where:{key:{startsWith:'profile:'},expiresAt:{gt:now}},select:{key:true}}),
      prisma.proxy.findMany({where:{isActive:true},select:{purpose:true,channel:true,host:true}}),
      prisma.taskExecution.findMany({where:{status:{in:outcome==='all'?['completed','failed']:[outcome]},completedAt:{gte:window.start!,lt:new Date(Math.min(+window.end!,+now+1))},OR:[{errorCode:null},{errorCode:{not:'stopped'}}]},select:{id:true,taskId:true,status:true,completedAt:true,errorCode:true,task:{select:{url:true,project:{select:{name:true,targetUrl:true}}}}},orderBy:[{completedAt:'desc'},{id:'desc'}],take:20}),
    ]);
    const freeProfiles = await prisma.profile.count({where:{...eligibleProfiles(undefined, now),id:{notIn:leases.map(l=>l.key.slice('profile:'.length))}}});
    return json({stats,recent,outcome,projects,resources:{freeProfiles,enabledProxies:proxies.length,targetProxies:proxies.filter(p=>p.purpose!=='warmup').length},checkedAt:now.toISOString()});
  } catch (error) { return apiError(error); }
});
