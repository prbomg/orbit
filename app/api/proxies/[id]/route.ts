import { syncBinding, provider } from "@/utils/proxyTcpStore";
import { assertProxyIdle, assertProxyCanChangeRotation } from "@/lib/proxy-lease";
import { withAuth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { apiError, checkDeleteOrigin, json, proxySelect, readBody } from "@/lib/api";
import { replaceProxySchema, updateProxySchema } from "@/lib/api-validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

async function GETHandler(_request: Request, { params }: Context) {
  try {
    const proxy = await prisma.proxy.findUnique({ where: { id: (await params).id }, select: proxySelect });
    return proxy ? json(proxy) : json({ error: "Запись не найдена" }, 404);
  } catch (error) { return apiError(error); }
}

async function update(request: Request, { params }: Context, replace: boolean) {
  try {
    const data = (replace ? replaceProxySchema : updateProxySchema).parse(await readBody(request));
    const id = (await params).id;
    const existing = await prisma.proxy.findUniqueOrThrow({where:{id}});
    const networkChanged = (["host","port","username","channel","rotationUrl"] as const).some(field => field in data && data[field] !== existing[field]);
    const providerRows = networkChanged && await prisma.proxyTcpChannel.count() ? await (await provider(prisma)).proxies() : undefined;
    return json(await prisma.$transaction(async tx => {
      await tx.$executeRaw`UPDATE "Settings" SET "id"="id" WHERE "id"=1`;
      const current = await tx.proxy.findUniqueOrThrow({ where: { id } });
      const changed = (Object.keys(data) as (keyof typeof data)[]).filter(field => data[field] !== current[field]);
      const rotationOnly = "rotationUrl" in data && changed.every(field => field === "rotationUrl");
      const check = rotationOnly ? assertProxyCanChangeRotation : assertProxyIdle;
      await check(tx, id);
      await tx.proxy.update({ where: { id }, data });
      if (networkChanged) await syncBinding(tx, id, providerRows);
      await check(tx, id);
      return tx.proxy.findUniqueOrThrow({ where: { id }, select: proxySelect });
    }));
  } catch (error) { return apiError(error); }
}
async function PATCHHandler(request: Request, context: Context) { return update(request, context, false); }
async function PUTHandler(request: Request, context: Context) { return update(request, context, true); }

async function DELETEHandler(request: Request, { params }: Context) {
  try {
    checkDeleteOrigin(request);
    const id = (await params).id;
    await prisma.$transaction(async tx => { await tx.$executeRaw`UPDATE "Settings" SET "id"="id" WHERE "id"=1`; await assertProxyIdle(tx, id); await tx.proxy.delete({ where: { id } }); });
    return new Response(null, { status: 204 });
  } catch (error) { return apiError(error); }
}

export const GET = withAuth(GETHandler);
export const PATCH = withAuth(PATCHHandler);
export const PUT = withAuth(PUTHandler);
export const DELETE = withAuth(DELETEHandler);
