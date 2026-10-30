import { z } from "zod";
import { withAuth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { apiError, json, readBody } from "@/lib/api";
import * as tcp from "@/utils/proxyTcp";
import * as store from "@/utils/proxyTcpStore";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = {params: Promise<{id:string}>};
function failure(error:unknown) { if(error instanceof tcp.TcpError) return json({error:store.message(error),code:error.code},error.code==='tcp_missing'?404:['tcp_busy','tcp_management_busy','tcp_channel_conflict'].includes(error.code)?409:502);return apiError(error); }
async function GETHandler(_request:Request,{params}:Context){try{return json(await store.state(prisma,(await params).id));}catch(error){return failure(error);}}
async function POSTHandler(request:Request,{params}:Context){try{const data=z.discriminatedUnion('action',[z.object({action:z.literal('apply'),profileId:z.number().int().min(0)}).strict(),z.object({action:z.literal('diagnose')}).strict()]).parse(await readBody(request));const id=(await params).id;return json(data.action==='apply'?await store.apply(prisma,id,data.profileId):await store.diagnose(prisma,id));}catch(error){return failure(error);}}
export const GET=withAuth(GETHandler);
export const POST=withAuth(POSTHandler);
