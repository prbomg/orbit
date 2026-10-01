import { prisma } from "@/lib/prisma";
import { apiError, checkDeleteOrigin, json, proxySelect, readBody } from "@/lib/api";
import { replaceProxySchema, updateProxySchema } from "@/lib/api-validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Context) {
  try {
    const proxy = await prisma.proxy.findUnique({ where: { id: (await params).id }, select: proxySelect });
    return proxy ? json(proxy) : json({ error: "Запись не найдена" }, 404);
  } catch (error) { return apiError(error); }
}

async function update(request: Request, { params }: Context, replace: boolean) {
  try {
    const data = (replace ? replaceProxySchema : updateProxySchema).parse(await readBody(request));
    return json(await prisma.proxy.update({ where: { id: (await params).id }, data, select: proxySelect }));
  } catch (error) { return apiError(error); }
}
export async function PATCH(request: Request, context: Context) { return update(request, context, false); }
export async function PUT(request: Request, context: Context) { return update(request, context, true); }

export async function DELETE(request: Request, { params }: Context) {
  try {
    checkDeleteOrigin(request);
    await prisma.proxy.delete({ where: { id: (await params).id } });
    return new Response(null, { status: 204 });
  } catch (error) { return apiError(error); }
}
