import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

const value = process.env.DATABASE_URL;
if (!value?.startsWith('file:')) throw new Error('DATABASE_URL must point to a SQLite file');
const name = decodeURIComponent(value.slice(5).split('?')[0]);
if (!name) throw new Error('DATABASE_URL must include a filename');
const path = isAbsolute(name) ? name : resolve('prisma', name);
mkdirSync(dirname(path), { recursive: true });
if (!existsSync(path)) closeSync(openSync(path, 'wx', 0o600));
