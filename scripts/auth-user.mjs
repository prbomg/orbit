import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { hashPassword } from '../lib/password.mjs';

// Run as the application owner. Passwords are never arguments or log output.
const db = new PrismaClient();
try {
  const email = (process.env.AUTH_EMAIL || 'seo@uniofweb.ru').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Invalid AUTH_EMAIL');
  const existing = await db.authUser.findUnique({ where: { email } });
  if (existing && !process.argv.includes('--reset')) {
    console.log(`Account ${email} already exists; use --reset to rotate its password and revoke all sessions.`);
  } else {
    const password = process.env.ORBIT_AUTH_PASSWORD || randomBytes(24).toString('base64url');
    const passwordHash = await hashPassword(password);
    const path = resolve(process.env.ORBIT_CREDENTIALS_FILE || '.auth-credentials');
    // Refuse to overwrite an existing credential file; preserve the only copy.
    await writeFile(path, `Email: ${email}\nPassword: ${password}\n`, { flag: 'wx', mode: 0o600 });
    await db.$transaction(async tx => {
      await tx.authUser.upsert({ where: { email }, create: { email, passwordHash }, update: { passwordHash } });
      await tx.authSession.deleteMany({});
      await tx.authThrottle.deleteMany({});
    });
    console.log(`Account ${email} configured. Credentials saved privately to ${path}.`);
  }
} finally { await db.$disconnect(); }
