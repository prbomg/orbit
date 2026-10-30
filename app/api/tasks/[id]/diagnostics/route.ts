import { withAuth } from "@/lib/auth";
import { ApiError, apiError, json } from "@/lib/api";
import { selectedDiagnostic } from "@/lib/diagnostics";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const GET=withAuth(async(request:Request,{params}:{params:Promise<{id:string}>})=>{
 try{
  const executionId=new URL(request.url).searchParams.get('executionId');
  if(!executionId||!/^[a-zA-Z0-9_-]{1,128}$/.test(executionId))throw new ApiError(400,'Выберите попытку выполнения.');
  return json(await selectedDiagnostic((await params).id,executionId));
 }catch(error){return apiError(error);}
});
