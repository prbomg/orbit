import { withAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { json, apiError } from '@/lib/api';
import downloads from '@/utils/taskLogDownloads';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = withAuth(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) return json({ error: 'Некорректный ID задачи' }, 400);
  try {
    if (!await prisma.task.findUnique({ where: { id }, select: { id: true } })) return json({ error: 'Задача не найдена' }, 404);
    return await downloads.response(request, id);
  } catch (error) { return apiError(error); }
});
