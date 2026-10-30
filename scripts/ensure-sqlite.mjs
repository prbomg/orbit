import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const value = process.env.DATABASE_URL;
if (!value?.startsWith('file:')) throw new Error('DATABASE_URL must point to a SQLite file');
const name = decodeURIComponent(value.slice(5).split('?')[0]);
if (!name) throw new Error('DATABASE_URL must include a filename');
const path = isAbsolute(name) ? name : resolve('prisma', name);
mkdirSync(dirname(path), { recursive: true });
if (!existsSync(path)) closeSync(openSync(path, 'wx', 0o600));
// Run during setup/maintenance, before application workers start. WAL is a
// persistent database property; do not change durability or buffer leases.
const database = new DatabaseSync(path);
try {
  database.exec('PRAGMA busy_timeout=10000');
  const result = database.prepare('PRAGMA journal_mode=WAL').get();
  if (result.journal_mode !== 'wal') throw Error('Could not enable SQLite WAL');
  console.log('SQLite journal mode: WAL');
} finally { database.close(); }
