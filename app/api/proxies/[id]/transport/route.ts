import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { withAuth } from '@/lib/auth';
import { apiError, json, readBody } from '@/lib/api';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const exec = promisify(execFile);
export const POST = withAuth(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  try {
    z.object({ action: z.literal('measure') }).strict().parse(await readBody(request));
    const id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/).parse((await params).id);
    const { stdout } = await exec(process.execPath, ['--env-file-if-exists=.env', 'scripts/verify-network-runtime.mjs', '--proxy', id], {
      cwd: process.cwd(), timeout: 45000, maxBuffer: 262144, encoding: 'utf8',
    });
    const report = JSON.parse(stdout.trim());
    const messages: Record<string, string> = { proxy_busy:'Прокси занят. Дождитесь завершения сеанса.',proxy_inactive:'Прокси выключен.',proxy_missing:'Прокси не найден.' };
    if (messages[report.reason]) return json({error:messages[report.reason]},report.reason==='proxy_missing'?404:409);
    return json(report);
  } catch (error) { return apiError(error); }
});
