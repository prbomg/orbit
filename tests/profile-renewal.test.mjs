import test from 'node:test';
import assert from 'node:assert/strict';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { poolFixture } from './helpers/pool-fixture.mjs';
import fp from '../utils/fingerprint.js';
import generation from '../utils/profileGeneration.js';
const exec = promisify(execFile);
test('public generation metadata distinguishes old passports and excludes identity fields', () => {
 const p=fp.localPassport({fingerprintMode:'local'});
 const info=generation.profileGeneration(p);
 assert.equal(info.current,true);assert.ok(info.model);assert.equal(info.version,'6');assert.equal('seed' in info,false);assert.equal('fingerprint' in info,false);
 const old=structuredClone(p);old.generation.version='4';assert.equal(generation.profileGeneration(old).current,false);
 const preAudit=structuredClone(p);delete preAudit.fingerprint.gpu;assert.equal(generation.profileGeneration(preAudit).current,false);
 assert.equal(generation.profileGeneration(null).current,false);
});
test('renewal dry-run, busy guard, archived files and current passport preservation', async () => {
 const f=await poolFixture();
 try {
  await f.db.settings.update({where:{id:1},data:{replenishBatchSize:3,autoReplenishEnabled:false}});
  const old=await f.db.profile.create({data:{name:'Legacy'}});
  const passport=fp.localPassport({fingerprintMode:'local'});
  const current=await f.db.profile.create({data:{name:'Current',fingerprint:passport}});
  await f.db.warmupJob.create({data:{profileId:old.id,status:'queued'}});
  const dir=join(f.dir,'profiles');await mkdir(dir);await writeFile(join(dir,old.id+'.json'),'old session');
  const env={...process.env,DATABASE_URL:`file:${f.dir}/test.db`,WORKER_PROFILES_DIR:dir};
  const run=args=>exec(process.execPath,['scripts/renew-profile-pool.mjs',...args],{env});
  await run([]);assert.equal(await f.db.profile.count({where:{deletedAt:null}}),2);
  const backup=join(f.dir,'backup');await mkdir(backup);await f.db.$executeRawUnsafe(`VACUUM INTO '${backup}/before.db'`);
  await f.db.workflowLease.create({data:{key:`profile:${old.id}`,owner:'test',expiresAt:new Date(Date.now()+60000)}});
  await assert.rejects(run(['--apply','--expected','1','--backup',backup]),/active_work_prevents_renewal/);
  assert.equal((await f.db.profile.findUnique({where:{id:old.id}})).deletedAt,null);
  await f.db.workflowLease.deleteMany();
  const backup2=join(f.dir,'backup2');await mkdir(backup2);await f.db.$executeRawUnsafe(`VACUUM INTO '${backup2}/before.db'`);
  await run(['--apply','--expected','1','--backup',backup2]);
  assert.equal(await f.db.profile.count({where:{deletedAt:null}}),4);
  assert.ok((await f.db.profile.findUnique({where:{id:old.id}})).deletedAt);
  assert.deepEqual((await f.db.profile.findUnique({where:{id:current.id}})).fingerprint,passport);
  assert.equal(await readFile(join(backup2,'sessions',old.id+'.json'),'utf8'),'old session');
  await assert.rejects(access(join(dir,old.id+'.json')));
  const fresh=await f.db.profile.findMany({where:{deletedAt:null,id:{not:current.id}}});assert.equal(fresh.length,3);
  assert.ok(fresh.every(p=>generation.profileGeneration(p.fingerprint).current&&p.fingerprint.source==='local'));
  assert.equal((await f.db.settings.findUnique({where:{id:1}})).warmupEnabled,false);
 } finally {await f.cleanup();}
});
