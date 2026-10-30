import { withAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { apiError, json, readBody } from '@/lib/api';
import preview from '@/utils/profilePreview';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const POST = withAuth(async (request: Request) => {
  try {
    const parsed = preview.previewSchema.safeParse(await readBody(request));
    if (!parsed.success) return json({ error: "Проверьте параметры предварительной проверки", details: parsed.error.issues.map((issue: { path: (string | number)[]; message: string }) => ({ field: issue.path.join("."), message: issue.message })) }, 400);
    const input = parsed.data;
    const settings = await prisma.settings.findUnique({ where: { id: 1 } });
    return json(await preview.previewProfiles(input, settings ?? {}));
  } catch (error) { return apiError(error); }
});
