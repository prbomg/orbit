import { prisma } from "@/lib/prisma";
import { apiError, json, proxySelect, readBody } from "@/lib/api";
import { proxyPostSchema } from "@/lib/api-validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try { return json(await prisma.proxy.findMany({ select: proxySelect, orderBy: { id: "asc" } })); }
  catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  try {
    const input = proxyPostSchema.parse(await readBody(request));
    if ("proxies" in input) {
      // One transaction: a duplicate rolls back the entire batch.
      const proxies = await prisma.$transaction(input.proxies.map(data => prisma.proxy.create({ data, select: proxySelect })));
      return json(proxies, 201);
    }
    return json(await prisma.proxy.create({ data: input, select: proxySelect }), 201);
  } catch (error) { return apiError(error); }
}
