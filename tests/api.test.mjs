import {mobileProfileFixture} from './helpers/mobile-profile-fixture.mjs';
import { authHeaders } from './helpers/auth.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

import snapshots from '../utils/profileSnapshots.js';
import { attestedSession } from './helpers/attestation.mjs';

const base = process.env.API_TEST_BASE_URL;
if (!base || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname)) {
  throw new Error('Set API_TEST_BASE_URL to a running local Orbit server');
}
const testProfileIds = new Set();
const testProjectIds = new Set();

test('warmup settings expose hours and persist editable sites with independent partial updates', async () => {
  const db = new PrismaClient();
  const previous = await db.settings.findUnique({ where: { id: 1 } });
  try {
    const sites = ['https://example.com/#anchor', 'https://example.org/news', 'https://example.net'];
    const saved = await call('/api/settings/', 'PATCH', { warmupStageIntervalHours: 1.5, warmupSites: sites });
    assert.equal(saved.status, 200);
    assert.equal(saved.data.warmupStageIntervalHours, 1.5);
    assert.equal(saved.data.warmupSitesDuplicatesRemoved, 0);
    assert.ok(!('warmupStageIntervalMinutes' in saved.data));
    assert.deepEqual(saved.data.warmupSites, ['https://example.com/', 'https://example.org/news', 'https://example.net/']);
    assert.equal((await db.settings.findUniqueOrThrow({ where: { id: 1 } })).warmupStageIntervalMinutes, 90);
    assert.equal((await call('/api/settings/', 'PATCH', { warmupStageIntervalHours: 2 })).status, 200);
    assert.deepEqual((await call('/api/settings/')).data.warmupSites, saved.data.warmupSites);
    for (const hours of [0, -1, 169]) assert.equal((await call('/api/settings/', 'PATCH', { warmupStageIntervalHours: hours })).status, 400);
    for (const badSites of [[], ['https://example.com', 'https://example.com/', 'https://example.org'], ['http://127.0.0.1', 'https://example.org', 'https://example.net']]) assert.equal((await call('/api/settings/', 'PATCH', { warmupSites: badSites })).status, 400);
    assert.equal((await call('/api/settings/')).data.warmupStageIntervalHours, 2);
    assert.equal((await call('/api/settings/', 'PATCH', { warmupSites: sites })).data.warmupStageIntervalHours, 2);
    const largeSites = Array.from({length:350}, (_, i) => `https://site${i}.ru`);
    const large = await call('/api/settings/', 'PATCH', {warmupSites:[...largeSites, 'https://site0.ru/', ' https://SITE1.ru/#section ']});
    assert.equal(large.status, 200); assert.equal(large.data.warmupSites.length,350); assert.equal(large.data.warmupSitesDuplicatesRemoved,2);
    assert.deepEqual((await call('/api/settings/')).data.warmupSites,large.data.warmupSites);
    assert.equal((await db.settings.findUniqueOrThrow({where:{id:1}})).warmupSites.length,350);
    const parallel = await call('/api/settings/', 'PATCH', { warmupConcurrency: 5, warmupSharedProxy: true });
    assert.equal(parallel.status, 200); assert.equal(parallel.data.warmupConcurrency, 5); assert.equal(parallel.data.warmupSharedProxy, true);
    assert.equal((await call('/api/settings/', 'PATCH', { warmupSharedProxy: false })).data.warmupSharedProxy, false);
    assert.equal((await call('/api/settings/')).data.warmupConcurrency, 5);
    for (const count of [11, 50, 1000]) {
      const updated=await call('/api/settings/', 'PATCH', {warmupConcurrency:count});
      assert.equal(updated.status,200);assert.equal(updated.data.warmupConcurrency,count);
      assert.equal((await db.settings.findUniqueOrThrow({where:{id:1}})).warmupConcurrency,count);
    }
    for (const count of [0,-1,1.5,'20']) assert.equal((await call('/api/settings/','PATCH',{warmupConcurrency:count})).status,400);
    assert.equal((await call('/api/settings/', 'PATCH', { warmupSharedProxy: 'true' })).status, 400);
  } finally {
    if (previous) await db.settings.update({ where: { id: 1 }, data: { warmupSites: previous.warmupSites ?? (await import('@prisma/client')).Prisma.DbNull, warmupStageIntervalMinutes: previous.warmupStageIntervalMinutes, warmupConcurrency: previous.warmupConcurrency, warmupSharedProxy: previous.warmupSharedProxy } });
    else await db.settings.deleteMany({ where: { id: 1 } });
    await db.$disconnect();
  }
});
test('profile journal is authenticated, paginated, isolated by profile and unavailable after deletion', async () => {
  const db=new PrismaClient();
  try {
    const a=await db.profile.create({data:{name:'Journal A'}}),b=await db.profile.create({data:{name:'Journal B'}});
    testProfileIds.add(a.id);testProfileIds.add(b.id);
    await db.profileWarmupEvent.createMany({data:Array.from({length:4},(_,i)=>({profileId:a.id,event:'warmup_site_completed',stage:2,attempt:1,proxyLabel:'192.0.2.1:8080',details:{domain:`site${i}.invalid`}}))});
    await db.profileWarmupEvent.create({data:{profileId:b.id,event:'queued'}});
    assert.equal((await fetch(`${base}/api/profiles/${a.id}/history/`)).status,401);
    const first=await call(`/api/profiles/${a.id}/history/?limit=2`);assert.equal(first.status,200);assert.equal(first.data.items.length,2);assert.equal(first.data.hasMore,true);
    const second=await call(`/api/profiles/${a.id}/history/?limit=2&before=${first.data.nextCursor}`);assert.equal(second.data.items.length,2);assert.equal(second.data.hasMore,false);
    assert.equal(new Set([...first.data.items,...second.data.items].map(e=>e.id)).size,4);
    assert.ok(first.data.items.every(e=>e.event==='warmup_site_completed'&&e.details.domain.endsWith('.invalid')&&!('password' in e)&&!('profileId' in e)));
    assert.equal((await call(`/api/profiles/${a.id}/history/?limit=1000`)).status,400);
    assert.equal((await call(`/api/profiles/${randomUUID()}/history/`)).status,404);
    await db.profile.update({where:{id:a.id},data:{deletedAt:new Date()}});
    assert.equal((await call(`/api/profiles/${a.id}/history/`)).status,404);
  }finally{await db.$disconnect();}
});
after(async () => {
  const db = new PrismaClient();
  try { await db.project.deleteMany({ where: { id: { in: [...testProjectIds] }, tasks: { none: {} }, profileHistory: { none: {} }, profileUses: { none: {} } } }); await db.profile.deleteMany({ where: { id: { in: [...testProfileIds] }, tasks: { none: {} } } }); }
  finally { await db.$disconnect(); }
});
async function call(path, method = 'GET', body) {
  if (path === '/api/tasks/' && method === 'POST' && body?.taskType !== 'warmup' && !body?.projectId) {
    let targetUrl;
    try { targetUrl = new URL(body?.fixtureTargetUrl || body?.url).href; } catch {}
    if (targetUrl?.startsWith('http')) {
      const db = new PrismaClient();
      try { const project = await db.project.create({ data: { name: 'Task API fixture', targetUrl, yandexRegionId: '213', regionName: '' } }); testProjectIds.add(project.id); body = { ...body, projectId: project.id }; }
      finally { await db.$disconnect(); }
    }
    if (body && 'fixtureTargetUrl' in body) { const { fixtureTargetUrl: _url, ...fields } = body; body = fields; }
  }
  const response = await fetch(`${base}${path}`, {
    method, headers: { ...await authHeaders(), 'Content-Type': 'application/json', Origin: new URL(base).origin },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = response.status === 204 ? null : await response.json();
  if (response.ok && (method === 'POST' || (method === 'PATCH' && body?.profileId))) {
    if (path === '/api/profiles/') testProfileIds.add(data.id);
    if (path.startsWith('/api/tasks/') && data.profileId) testProfileIds.add(data.profileId);
  }
  return { status: response.status, data };
}

test('task CRUD persists fields and validates updates', async () => {
  let id;
  try {
    const created = await call('/api/tasks/', 'POST', { url: `https://example.com/api-test-${randomUUID()}`, targetKeywords: ['цена', 'QA'] });
    assert.equal(created.status, 201);
    id = created.data.id;
    assert.equal(created.data.status, 'running');
    assert.equal(created.data.currentExecutions, 0);
    assert.equal(created.data.taskType, 'target');
    assert.equal(created.data.profile, null);
    assert.equal(created.data.profileId, null);
    assert.ok(!Number.isNaN(Date.parse(created.data.createdAt)));
    assert.deepEqual((await call(`/api/tasks/${id}/`)).data.targetKeywords, ['цена', 'QA']);
    assert.ok((await call('/api/tasks/')).data.some(task => task.id === id));
    const patch = await call(`/api/tasks/${id}/`, 'PATCH', { status: 'paused', targetExecutions: 7 });
    assert.equal(patch.status, 200);
    assert.equal((await call(`/api/tasks/${id}/`)).data.currentExecutions, 0);
    assert.equal((await call(`/api/tasks/${id}/`, 'PATCH', { currentExecutions: -1 })).status, 400);
    assert.equal((await call(`/api/tasks/${id}/`, 'PATCH', { status: 'bogus' })).status, 400);
    assert.equal((await call(`/api/tasks/${id}/`, 'PATCH', {})).status, 400);
    const replacement = { url: 'https://example.org/replaced', targetKeywords: [], status: 'completed', targetExecutions: 9 };
    assert.equal((await call(`/api/tasks/${id}/`, 'PUT', replacement)).status, 200);
    const db = new PrismaClient();
    try {
      const row = await db.task.findUniqueOrThrow({ where: { id } });
      assert.equal(row.currentExecutions, 0); assert.equal(row.targetExecutions, 9);
      assert.deepEqual(row.targetKeywords, []);
      assert.equal(row.profileId, created.data.profileId, 'PUT without profileId must preserve the session');
    } finally { await db.$disconnect(); }
    assert.equal((await call(`/api/tasks/${id}/`, 'DELETE')).status, 204);
    assert.equal((await call(`/api/tasks/${id}/`)).status, 404);
    assert.equal((await call(`/api/tasks/${id}/`, 'DELETE')).status, 404);
    id = undefined;
  } finally { if (id) await call(`/api/tasks/${id}/`, 'DELETE'); }
});

test('proxy CRUD excludes passwords and batch conflicts roll back all inserts', async () => {
  const username = `test-${randomUUID()}`;
  const input = { host: '192.0.2.99', port: 8080, username, password: 'test-password:with-colon', isActive: true };
  const ids = [];
  try {
    const created = await call('/api/proxies/', 'POST', input);
    assert.equal(created.status, 201);
    const id = created.data.id; ids.push(id);
    assert.equal('password' in created.data, false);
    assert.equal('password' in (await call(`/api/proxies/${id}/`)).data, false);
    assert.equal((await call('/api/proxies/', 'POST', input)).status, 409);
    const fresh = { ...input, username: `${username}-batch` };
    assert.equal((await call('/api/proxies/', 'POST', { proxies: [fresh, input] })).status, 409);
    assert.equal((await call('/api/proxies/')).data.some(p => p.username === fresh.username), false);
    assert.equal((await call(`/api/proxies/${id}/`, 'PATCH', { isActive: false })).data.isActive, false);
    assert.equal((await call(`/api/proxies/${id}/`, 'PATCH', { rotationUrl: 'https://example.com/rotate?token=synthetic' })).data.rotationUrl, 'https://example.com/rotate?token=synthetic');
    assert.equal((await call(`/api/proxies/${id}/`, 'PATCH', { rotationUrl: 'javascript:alert(1)' })).status, 400);
    assert.equal((await call(`/api/proxies/${id}/`, 'PATCH', { rotationUrl: null })).data.rotationUrl, null);
    assert.equal((await call(`/api/proxies/${id}/`, 'PUT', { ...input, port: 8081, password: 'updated-test-password' })).status, 200);
    const db = new PrismaClient();
    try { assert.equal((await db.proxy.findUniqueOrThrow({ where: { id } })).password, 'updated-test-password'); }
    finally { await db.$disconnect(); }
    const batch = await call('/api/proxies/', 'POST', { proxies: [fresh, { ...fresh, port: 8082 }] });
    assert.equal(batch.status, 201);
    ids.push(...batch.data.map(p => p.id));
    assert.ok(batch.data.every(p => !('password' in p)));
    assert.equal((await call(`/api/proxies/${id}/`, 'DELETE')).status, 204);
    assert.equal((await call(`/api/proxies/${id}/`)).status, 404);
  } finally { for (const id of ids) await call(`/api/proxies/${id}/`, 'DELETE'); }
});

test('proxy import into a running channel preserves leases and keeps editing and TCP management protected', async () => {
  const db = new PrismaClient(), tag = randomUUID(), ids = [], leaseKeys = [];
  const input = {host:'192.0.2.253',port:8000,username:`busy-${tag}`,password:'fixture-only',isActive:true};
  try {
    const original = await call('/api/proxies/', 'POST', input); assert.equal(original.status,201); ids.push(original.data.id);
    const cases = [
      {key:`proxy:endpoint:${input.host}:8100`,data:{}},
      {key:`warmup-share:proxy:endpoint:${input.host}:8101:fixture-${tag}`,data:{}},
      {key:`proxy:channel-${tag}`,data:{host:'198.51.100.253',channel:`channel-${tag}`}},
      {key:`rotation:${(await import('node:crypto')).createHash('sha256').update('https://example.com/rotate-fixture').digest('hex')}`,data:{host:'198.51.100.252',rotationUrl:'https://example.com/rotate-fixture'}},
    ];
    for (const [index, item] of cases.entries()) {
      const lease = {key:item.key,owner:`running-${tag}`,expiresAt:new Date(Date.now()+60000)}; leaseKeys.push(lease.key);
      await db.workflowLease.create({data:lease});
      const added = await call('/api/proxies/', 'POST', {proxies:[{...input,...item.data,port:8100+index}]});
      assert.equal(added.status,201,JSON.stringify(added.data));const row=added.data[0];ids.push(row.id);assert.equal('password' in row,false);
      assert.deepEqual(await db.workflowLease.findUnique({where:{key:lease.key}}),lease);
      assert.equal((await call(`/api/proxies/${row.id}/`,'PATCH',{isActive:false})).status,409);
      assert.equal((await call(`/api/proxies/${row.id}/`,'DELETE')).status,409);
      await db.workflowLease.delete({where:{key:lease.key}});
    }
    const managementKey=`proxy:endpoint:${input.host}:8201`;leaseKeys.push(managementKey);
    await db.workflowLease.create({data:{key:managementKey,owner:`tcp-operation:${tag}`,expiresAt:new Date(Date.now()+60000)}});
    const blocked=await call('/api/proxies/','POST',{proxies:[{...input,host:'203.0.113.253',port:8200},{...input,port:8201}]});
    assert.equal(blocked.status,409);assert.match(blocked.data.error,/TCP/);
    assert.equal(await db.proxy.count({where:{username:input.username,port:{in:[8200,8201]}}}),0,'batch must roll back');
    assert.equal(await db.proxy.count({where:{id:{in:ids}}}),ids.length);
  } finally {
    await db.workflowLease.deleteMany({where:{key:{in:leaseKeys}}});
    await db.proxy.deleteMany({where:{id:{in:ids}}});await db.$disconnect();
  }
});

test('rotation-only updates save during active sessions, preserve claims and reject mixed edits or TCP management conflicts', async()=>{
 const db=new PrismaClient(),tag=randomUUID(),ids=[],keys=[];
 const input={host:'192.0.2.250',port:8000,username:`rotation-${tag}`,password:'fixture',channel:`rotation-${tag}`,isActive:true};
 try{
  const created=await call('/api/proxies/','POST',input);assert.equal(created.status,201);const id=created.data.id;ids.push(id);
  for(const shared of [false,true]){
   const key=shared?`warmup-share:proxy:${input.channel}:fixture`:`proxy:${input.channel}`;keys.push(key);
   const lease={key,owner:`active-${tag}`,expiresAt:new Date(Date.now()+60000)};await db.workflowLease.create({data:lease});
   const url=`https://example.com/rotate-${shared}`;
   const saved=await call(`/api/proxies/${id}/`,'PATCH',{rotationUrl:url});assert.equal(saved.status,200);assert.equal(saved.data.rotationUrl,url);
   assert.deepEqual(await db.workflowLease.findUnique({where:{key}}),lease);
   assert.equal((await call(`/api/proxies/${id}/`,'PATCH',{rotationUrl:null,isActive:false})).status,409);
   assert.equal((await call(`/api/proxies/${id}/`,'GET')).data.rotationUrl,url);
   assert.equal((await call(`/api/proxies/${id}/`,'DELETE')).status,409);
   assert.equal((await call(`/api/proxies/${id}/`,'PATCH',{rotationUrl:null})).status,200);
   assert.deepEqual(await db.workflowLease.findUnique({where:{key}}),lease);
   await db.workflowLease.delete({where:{key}});
  }
  const other=await call('/api/proxies/','POST',{...input,host:'198.51.100.250',channel:`other-${tag}`,rotationUrl:'https://example.com/managed'});assert.equal(other.status,201);ids.push(other.data.id);
  const management=`proxy:other-${tag}`;keys.push(management);await db.workflowLease.create({data:{key:management,owner:`tcp-operation:${tag}`,expiresAt:new Date(Date.now()+60000)}});
  assert.equal((await call(`/api/proxies/${id}/`,'PATCH',{rotationUrl:'https://example.com/managed'})).status,409);
  assert.equal((await call(`/api/proxies/${id}/`)).data.rotationUrl,null,'new channel conflict rolls back URL');
 }finally{await db.workflowLease.deleteMany({where:{key:{in:keys}}});await db.proxy.deleteMany({where:{id:{in:ids}}});await db.$disconnect();}
});

test('profiles are allocated by the worker; manual assignment and main-list warmups are rejected', async () => {
  const created = await call('/api/tasks/', 'POST', { url: 'https://example.com', status: 'paused' });
  try {
    assert.equal(created.status, 201); assert.equal(created.data.profileId, null);
    assert.equal((await call('/api/tasks/', 'POST', { url: 'https://example.com', profileId: randomUUID() })).status, 400);
    assert.equal((await call(`/api/tasks/${created.data.id}/`, 'PATCH', { profileId: randomUUID() })).status, 400);
    assert.equal((await call('/api/tasks/', 'POST', { taskType: 'warmup' })).status, 400);
    assert.equal((await call(`/api/tasks/${created.data.id}/`, 'PATCH', { taskType: 'warmup' })).status, 400);
  } finally { if(created.data.id) await call(`/api/tasks/${created.data.id}/`, 'DELETE'); }
});

test('new profiles automatically enter the dedicated queue and support pause/resume', async () => {
  const profile = await call('/api/profiles/', 'POST', { name: 'Synthetic warmup profile' });
  assert.equal(profile.status, 201); assert.equal(profile.data.status, 'queued');
  const id = profile.data.id;
  const db = new PrismaClient();
  try {
    assert.equal((await db.warmupJob.findUniqueOrThrow({ where: { profileId: id } })).status, 'queued');
    assert.equal((await call('/api/tasks/')).data.some(task => task.profileId === id), false);
    assert.equal((await call('/api/profiles/actions/', 'POST', { profileIds: [id], action: 'pause' })).status, 200);
    assert.equal((await db.warmupJob.findUniqueOrThrow({ where: { profileId: id } })).status, 'paused');
    assert.equal((await call('/api/profiles/actions/', 'POST', { profileIds: [id], action: 'resume' })).data.queued, 1);
    assert.equal((await call(`/api/profiles/${id}/`, 'PATCH', { status: 'ready' })).status, 400);
    const rows = (await call('/api/profiles/?page=1&queue=1')).data;
    assert.ok(rows.items.some(row => row.id === id));
    assert.equal((await call('/api/profiles/pool/')).status, 200);
  } finally { await db.$disconnect(); }
});

test('search task fields persist, normalize domains and validate merged PATCH data', async () => {
  let taskId;
  try {
    const fields = { searchEngine: 'mail', searchQueries: [' QA поиск ', 'второй запрос'], vitalPhrases: [' Бренд '], fixtureTargetUrl: 'https://ПРИМЕР.РФ/' };
    const created = await call('/api/tasks/', 'POST', fields);
    assert.equal(created.status, 201); taskId = created.data.id;
    assert.equal(created.data.url, ''); assert.deepEqual(created.data.searchQueries, ['QA поиск', 'второй запрос']); assert.deepEqual(created.data.vitalPhrases, ['Бренд']);
    assert.equal(new URL(created.data.project.targetUrl).hostname, 'xn--e1afmkfd.xn--p1ai');
    const db = new PrismaClient();
    try { assert.equal((await db.task.findUniqueOrThrow({ where: { id: taskId } })).searchEngine, 'mail'); }
    finally { await db.$disconnect(); }
    assert.equal((await call(`/api/tasks/${taskId}/`, 'PATCH', { searchEngine: 'dzen' })).status, 200);
    assert.equal((await call(`/api/tasks/${taskId}/`, 'PATCH', { searchQueries: [] })).status, 400);
    assert.equal((await call('/api/tasks/', 'POST', { ...fields, targetDomain: 'https://example.com/' })).status, 400);
    assert.equal((await call('/api/tasks/', 'POST', { ...fields, searchEngine: 'unknown' })).status, 400);
    assert.equal((await call('/api/tasks/', 'POST', { ...fields, searchQueries: ['qa\nEnter'] })).status, 400);
    assert.equal((await call('/api/tasks/', 'POST', { url: 'https://example.com', searchQueries: ['incomplete'] })).status, 400);
    assert.equal((await call(`/api/tasks/${taskId}/`, 'PATCH', { searchEngine: '', searchQueries: [], vitalPhrases: [], url: 'https://example.com' })).status, 200);
  } finally { if (taskId) await call(`/api/tasks/${taskId}/`, 'DELETE'); }
});

test('RuCaptcha key persists in Settings but never appears in API responses', async () => {
  const db = new PrismaClient();
  const previous = await db.settings.findUnique({ where: { id: 1 } });
  try {
    const key = 'synthetic-rucaptcha-api-test-key';
    const saved = await call('/api/settings/', 'PATCH', { rucaptchaApiKey: key });
    assert.equal(saved.status, 200);
    assert.equal(saved.data.rucaptchaConfigured, true); assert.ok(!JSON.stringify(saved.data).includes(key));
    assert.equal((await db.settings.findUniqueOrThrow({ where: { id: 1 } })).rucaptchaApiKey, key);
    assert.equal((await call('/api/settings/')).data.rucaptchaConfigured, true);
    assert.equal((await call('/api/settings/', 'PATCH', { rucaptchaApiKey: '' })).status, 400);
    assert.equal((await call('/api/settings/', 'PATCH', { rucaptchaApiKey: 'key with spaces' })).status, 400);
    assert.equal((await fetch(`${base}/api/settings/`, { method: 'PATCH', headers: { ...await authHeaders(), 'Content-Type': 'application/json', Origin: 'https://unrelated.example' }, body: JSON.stringify({ rucaptchaApiKey: key }) })).status, 403);
    assert.equal((await call('/api/settings/', 'PATCH', { rucaptchaApiKey: null })).data.rucaptchaConfigured, false);
    assert.equal((await db.settings.findUniqueOrThrow({ where: { id: 1 } })).rucaptchaApiKey, null);
  } finally {
    if (previous) await db.settings.upsert({ where: { id: 1 }, create: previous, update: previous });
    else await db.settings.deleteMany({ where: { id: 1 } });
    await db.$disconnect();
  }
});

test('malformed bodies, invalid URLs, invalid ports and cross-origin writes are rejected', async () => {
  assert.equal((await call('/api/tasks/', 'POST', { url: 'not a url' })).status, 400);
  assert.equal((await call('/api/tasks/', 'POST', { url: 'javascript:alert(1)' })).status, 400);
  assert.equal((await call('/api/tasks/', 'POST', { url: 'https://example.com', targetKeywords: 'not-an-array' })).status, 400);
  assert.equal((await call('/api/proxies/', 'POST', { host: '999.0.0.1', port: 70000, username: 'test', password: 'test' })).status, 400);
  assert.equal((await fetch(`${base}/api/tasks/`, { method: 'POST', headers: { ...await authHeaders(), 'Content-Type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await fetch(`${base}/api/tasks/`, { method: 'POST', headers: { ...await authHeaders(), 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await fetch(`${base}/api/tasks/`, { method: 'POST', headers: { ...await authHeaders(), 'Content-Type': 'application/json', Origin: 'https://unrelated.example' }, body: '{}' })).status, 403);
  assert.equal((await call('/api/tasks/missing/', 'PATCH', { status: 'paused' })).status, 404);
});


test('OpenAI key persists, is never returned, and partial updates preserve other integration settings', async () => {
  const db = new PrismaClient(); const previous = await db.settings.findUnique({ where: { id: 1 } });
  try {
    const key = 'synthetic-openai-settings-key';
    await call('/api/settings/', 'PATCH', { rucaptchaApiKey: 'synthetic-captcha-preserved' });
    const saved = await call('/api/settings/', 'PATCH', { openaiApiKey: key });
    assert.equal(saved.status, 200); assert.equal(saved.data.openaiStored, true); assert.equal(saved.data.openaiSource, 'database');
    assert.equal(saved.data.rucaptchaConfigured, true); assert.ok(!JSON.stringify(saved.data).includes(key));
    const row = await db.settings.findUniqueOrThrow({ where: { id: 1 } });
    assert.equal(row.openaiApiKey, key); assert.equal(row.rucaptchaApiKey, 'synthetic-captcha-preserved');
    const fetched = await call('/api/settings/'); assert.ok(!('openaiApiKey' in fetched.data)); assert.ok(!('rucaptchaApiKey' in fetched.data));
    assert.equal((await call('/api/settings/', 'PATCH', {})).status, 400);
    assert.equal((await call('/api/settings/', 'PATCH', { openaiApiKey: 'bad key' })).status, 400);
    assert.equal((await call('/api/settings/', 'PATCH', { openaiApiKey: null })).data.openaiStored, false);
  } finally {
    if (previous) await db.settings.upsert({ where: { id: 1 }, create: previous, update: previous }); else await db.settings.deleteMany({ where: { id: 1 } });
    await db.$disconnect();
  }
});

test('profile management and service diagnostics return safe metadata', async () => {
  const profile = await call('/api/profiles/', 'POST', { name: 'Synthetic metadata profile' });
  assert.equal(profile.status, 201);
  const row = (await call(`/api/profiles/${profile.data.id}/`)).data;
  assert.equal(row.session.state, 'missing'); assert.equal(row.session.cookiesCount, 0); assert.ok(!('cookies' in row));
  assert.equal((await call(`/api/profiles/${profile.data.id}/`, 'PATCH', { name: 'Renamed profile' })).data.name, 'Renamed profile');
  const system = await call('/api/system/'); assert.equal(system.status, 200);
  assert.ok(['running', 'stopped', 'stale', 'unknown'].includes(system.data.workerState));
  assert.deepEqual(system.data.mobileDevices, ['Android', 'iOS']); assert.ok(!('databasePath' in system.data)); assert.ok(!('openaiApiKey' in system.data));
});

test('profile readiness explains missing, legacy, restored and empty sessions without disclosing values', async () => {
  const db = new PrismaClient();
  const profile = await call('/api/profiles/', 'POST', { name: 'Session diagnostics fixture' });
  const id = profile.data.id;
  const directory = resolve(process.cwd(), process.env.WORKER_PROFILES_DIR ?? 'profiles');
  const path = resolve(directory, `${id}.json`);
  try {
    const missing = (await call(`/api/profiles/${id}/`)).data;
    assert.equal(missing.session.state, 'missing'); assert.equal(missing.readiness.state, 'warming');
    await db.profile.update({ where: { id }, data: { status: 'ready', warmedAt: new Date(), fingerprintState: 'verified', warmupJob: { update: { status: 'completed', currentStage: 6, progress: 100 } } } });
    const snapshot = { ...mobileProfileFixture(id), savedAt: new Date().toISOString(), cookies: [
      { name: 'expired', value: 'private-cookie-data', domain: 'example.com', path: '/', expires: 1, secure: true, httpOnly: true, sameSite: 'Lax' },
    ], origins: [{ origin: 'https://example.com', localStorage: [{ name: 'preference', value: 'private-local-data' }], indexedDB: [{ name: 'sessions', version: 1, stores: [{ name: 'records', autoIncrement: false, indexes: [], records: [{ key: 1, value: 'private-db-data' }] }] }] }] };
    await mkdir(directory, { recursive: true }); await writeFile(path, JSON.stringify(snapshot), { flag: 'wx', mode: 0o600 });
    const legacy = (await call(`/api/profiles/${id}/`)).data;
    assert.equal(legacy.readiness.state, 'needs_check'); assert.equal(legacy.session.expiredCookiesCount, 1); assert.equal(legacy.session.activeCookiesCount, 0);
    assert.equal(legacy.session.localStorageEntriesCount, 1); assert.equal(legacy.session.indexedDBRecordsCount, 1);
    assert.ok(!JSON.stringify(legacy).includes('private-'));
    const verified = snapshots.stampSnapshot(snapshot);
    await writeFile(path, JSON.stringify(verified));
    const evidence = attestedSession({snapshotId:verified.snapshot.id,savedAt:verified.savedAt,passportHash:verified.snapshot.passportHash});
    await db.profile.update({ where: { id }, data: { snapshotId:verified.snapshot.id,readinessVersion:1,readinessVerifiedAt: new Date(), readinessValidUntil: new Date(Date.now()+86400000), sessionCheck:evidence.sessionCheck } });
    const ready = (await call(`/api/profiles/${id}/`)).data;
    assert.equal(ready.readiness.state, 'ready'); assert.ok(ready.readiness.checks.every(check => check.state === 'passed'));
    const list = (await call(`/api/profiles/?page=1&search=${id}`)).data.items[0];
    assert.equal(list.readiness.state, 'ready'); assert.equal(list.session.indexedDBRecordsCount, 1); assert.ok(!JSON.stringify(list).includes('private-'));
    await writeFile(path, JSON.stringify({ ...snapshot, origins: [] }));
    assert.equal((await call(`/api/profiles/${id}/`)).data.readiness.state, 'needs_check');
    await writeFile(path, JSON.stringify({ ...snapshot, savedAt: null }));
    assert.equal((await call(`/api/profiles/${id}/`)).data.session.state, 'unsaved');
    await writeFile(path, '{');
    const corrupted = (await call(`/api/profiles/${id}/`)).data;
    assert.equal(corrupted.session.state, 'unreadable'); assert.equal(corrupted.readiness.state, 'needs_check');
    await db.profile.update({ where: { id }, data: { status: 'queued', warmedAt: null, warmupJob: { update: { status: 'retry_wait', stage: 'stage_1_proxy_wait', errorCode: 'network' } } } });
    const waiting = (await call(`/api/profiles/${id}/`)).data;
    assert.equal(waiting.readiness.state, 'waiting'); assert.equal(waiting.readiness.label, 'Ожидает восстановления прокси');
  } finally { await rm(path, { force: true }); await db.$disconnect(); }
});

test('fingerprint source settings validate locale/timezone and keep MobileProxy token private',async()=>{
 const db=new PrismaClient();const previous=await db.settings.findUnique({where:{id:1}});
 try{
  const saved=await call('/api/settings/','PATCH',{fingerprintMode:'auto',fingerprintLocale:'ru-RU',fingerprintTimezone:'Europe/Moscow',mobileProxyApiKey:'synthetic-mobileproxy-secret'});
  assert.equal(saved.status,200);assert.equal(saved.data.mobileProxyConfigured,true);assert.ok(!JSON.stringify(saved.data).includes('synthetic-mobileproxy-secret'));assert.ok(!('mobileProxyApiKey' in saved.data));
  assert.equal((await call('/api/settings/','PATCH',{fingerprintTimezone:'invalid/timezone'})).status,400);
  assert.equal((await call('/api/settings/','PATCH',{fingerprintMode:'arbitrary'})).status,400);
  const profile=await call('/api/profiles/','POST',{name:'Fingerprint fixture'});assert.equal(profile.status,201);assert.equal(profile.data.fingerprint.source,'local');assert.equal(profile.data.fingerprint.requestedSource,'auto');assert.match(profile.data.fingerprintHash,/^[a-f0-9]{64}$/);
  assert.equal((await call(`/api/profiles/${profile.data.id}/`)).data.fingerprint.seed,profile.data.fingerprint.seed);
  assert.equal((await call(`/api/profiles/${profile.data.id}/`,'PATCH',{fingerprintState:'verified'})).status,400);
  const list=(await call('/api/profiles/?page=1')).data.items;assert.ok(list.every(row=>!('fingerprint' in row)&&!('fingerprintCheck' in row)));
 }finally{if(previous)await db.settings.update({where:{id:1},data:previous});else await db.settings.deleteMany({where:{id:1}});await db.$disconnect();}
});
