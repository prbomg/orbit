import { withAuth } from "@/lib/auth";
import { ApiError, apiError, json } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { projectVisitStats } from "@/utils/projectVisits";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const GET = withAuth(async (request:Request,{params}:{params:Promise<{id:string}>})=>{
 try{
  const q=new URL(request.url).searchParams;
  let result;
  try {result=await projectVisitStats(prisma,(await params).id,{period:q.get('period')||'today',from:q.get('from')||undefined,to:q.get('to')||undefined});}
  catch(error){if(error instanceof Error && /^invalid_(date|range|period)$/.test(error.message))throw new ApiError(400,"Укажите корректный период: начальная дата не должна быть позже конечной.");throw error;}
  return result?json(result):json({error:"Проект не найден"},404);
 }catch(error){return apiError(error);}
});
