import { syncBinding, provider } from "@/utils/proxyTcpStore";
import { assertProxyCanBeAdded } from "@/lib/proxy-lease";
import { withAuth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { apiError, json, proxySelect, readBody } from "@/lib/api";
import { proxyPostSchema } from "@/lib/api-validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function GETHandler() {
  try { return json(await prisma.proxy.findMany({ select: proxySelect, orderBy: { id: "asc" } })); }
  catch (error) { return apiError(error); }
}

async function POSTHandler(request: Request) {
  try {
    const input = proxyPostSchema.parse(await readBody(request));
    const providerRows = await prisma.proxyTcpChannel.count() ? await (await provider(prisma)).proxies() : undefined;
    const items = "proxies" in input ? input.proxies : [input];
    const result = await prisma.$transaction(async tx => {
      await tx.$executeRaw`UPDATE "Settings" SET "id"="id" WHERE "id"=1`;
      const proxies = [];
      for (const data of items) { const row=await tx.proxy.create({data}); await syncBinding(tx,row.id,providerRows); await assertProxyCanBeAdded(tx,row.id); proxies.push(await tx.proxy.findUniqueOrThrow({where:{id:row.id},select:proxySelect})); }
      return proxies;
    });
    return json("proxies" in input ? result : result[0],201);
  } catch (error) { return apiError(error); }
}

export const GET = withAuth(GETHandler);
export const POST = withAuth(POSTHandler);
