import { PrismaClient } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { after } from 'node:test';
let fixture;
export async function authHeaders() {
  if (!fixture) fixture = (async () => {
    const base = process.env.API_TEST_BASE_URL;
    if (!base || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname)) throw new Error('Authentication fixtures require a local server');
    const db = new PrismaClient();
    try {
      const email = process.env.AUTH_EMAIL || 'seo@uniofweb.ru';
      const user = await db.authUser.upsert({ where: { email }, create: { email, passwordHash: 'fixture-disabled-password' }, update: {} });
      const token = randomBytes(32).toString('hex');
      const tokenHash = createHash('sha256').update(token).digest('hex');
      await db.authSession.create({ data: { tokenHash, userId: user.id, expiresAt: new Date(Date.now() + 3600_000) } });
      return { token, tokenHash };
    } finally { await db.$disconnect(); }
  })();
  return { Cookie: `orbit_session=${(await fixture).token}` };
}
after(async () => {
  if (!fixture) return;
  const db = new PrismaClient();
  try { await db.authSession.deleteMany({ where: { tokenHash: (await fixture).tokenHash } }); }
  finally { await db.$disconnect(); }
});
