import { withAuth } from "@/lib/auth";
import { ApiError, apiError, json } from "@/lib/api";
import { diagnosticSummary } from "@/lib/diagnostics";
import { diagnosticIpPage, diagnosticRecentPage } from "@/utils/diagnosticIpPage";
import { z } from "zod";
const pageLimitSchema=z.coerce.number().int().min(25).max(5000).multipleOf(25);
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const GET=withAuth(async(request:Request)=>{
 try{
  const query=new URL(request.url).searchParams,period=query.get('period')||'week',projectId=query.get('projectId');
  if(!['today','week','month'].includes(period))throw new ApiError(400,'Выберите период: сегодня, семь или тридцать дней.');
  if(projectId!==null&&!/^[a-zA-Z0-9_-]{1,128}$/.test(projectId))throw new ApiError(400,'Некорректный проект.');
  const ipLimit=pageLimitSchema.parse(query.get('ipLimit')??25);
  const recentLimit=pageLimitSchema.parse(query.get('recentLimit')??25);
  return json(diagnosticRecentPage(diagnosticIpPage(await diagnosticSummary(period,projectId),ipLimit),recentLimit));
 }catch(error){return apiError(error);}
});
