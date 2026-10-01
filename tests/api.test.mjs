import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const base = process.env.API_TEST_BASE_URL;
if (!base || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname)) {
  throw new Error('Set API_TEST_BASE_URL to a running local Orbit server');
}
const testProfileIds = new Set();
const testProjectIds = new Set();
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
    method, headers: { 'Content-Type': 'application/json', Origin: new URL(base).origin },
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
    assert.equal(created.data.profile.id, created.data.profileId);
    assert.match(created.data.profileId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
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

test('tasks can share an existing profile UUID; invalid IDs are rejected', async () => {
  const ids = [];
  try {
    const first = await call('/api/tasks/', 'POST', { url: 'https://example.com/session-test', status: 'paused' });
    assert.equal(first.status, 201); ids.push(first.data.id);
    const second = await call('/api/tasks/', 'POST', { url: 'https://example.org/session-test', status: 'paused', profileId: first.data.profileId });
    assert.equal(second.status, 201); ids.push(second.data.id);
    assert.equal(second.data.profileId, first.data.profileId);
    assert.equal((await call('/api/tasks/', 'POST', { url: 'https://example.com', profileId: '../escape' })).status, 400);
    assert.equal((await call(`/api/tasks/${second.data.id}/`, 'PATCH', { profileId: 'invalid' })).status, 400);
    const updated = await call(`/api/tasks/${second.data.id}/`, 'PATCH', { profileId: randomUUID() });
    assert.equal(updated.status, 200);
    assert.notEqual(updated.data.profileId, first.data.profileId);
  } finally { for (const id of ids) await call(`/api/tasks/${id}/`, 'DELETE'); }
});

test('warmup tasks require no URL, reuse named profiles and cannot become targets without a URL', async () => {
  let taskId;
  try {
    const profile = await call('/api/profiles/', 'POST', { name: 'Synthetic warmup profile' });
    assert.equal(profile.status, 201);
    assert.equal(profile.data.status, 'new');
    assert.ok((await call('/api/profiles/')).data.some(row => row.id === profile.data.id));
    const created = await call('/api/tasks/', 'POST', { taskType: 'warmup', profileId: profile.data.id, status: 'paused' });
    assert.equal(created.status, 201); taskId = created.data.id;
    assert.equal(created.data.url, '');
    assert.equal(created.data.profile.name, profile.data.name);
    assert.equal((await call(`/api/tasks/${taskId}/`, 'PATCH', { taskType: 'target' })).status, 400);
    assert.equal((await call(`/api/tasks/${taskId}/`, 'PATCH', { taskType: 'unknown' })).status, 400);
    assert.equal((await call('/api/tasks/', 'POST', { taskType: 'target' })).status, 400);
    const target = await call(`/api/tasks/${taskId}/`, 'PATCH', { taskType: 'target', url: 'https://example.com' });
    assert.equal(target.status, 400);
    
    assert.equal((await call(`/api/profiles/${profile.data.id}/`, 'PATCH', { name: 'Renamed synthetic profile', isEnabled: false })).status, 200);
    assert.equal((await call(`/api/tasks/${taskId}/`)).data.profile.isEnabled, false);
    assert.equal((await call(`/api/profiles/${profile.data.id}/`, 'PATCH', { status: 'bogus' })).status, 400);
  } finally { if (taskId) await call(`/api/tasks/${taskId}/`, 'DELETE'); }
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
    assert.equal((await fetch(`${base}/api/settings/`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Origin: 'https://unrelated.example' }, body: JSON.stringify({ rucaptchaApiKey: key }) })).status, 403);
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
  assert.equal((await fetch(`${base}/api/tasks/`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await fetch(`${base}/api/tasks/`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await fetch(`${base}/api/tasks/`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://unrelated.example' }, body: '{}' })).status, 403);
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
  const profiles = await call('/api/profiles/'); const row = profiles.data.find(item => item.id === profile.data.id);
  assert.equal(row.session.state, 'missing'); assert.equal(row.session.cookiesCount, 0); assert.ok(!('cookies' in row));
  assert.equal((await call(`/api/profiles/${profile.data.id}/`, 'PATCH', { name: 'Renamed profile', status: 'ready' })).data.status, 'ready');
  const system = await call('/api/system/'); assert.equal(system.status, 200);
  assert.ok(['running', 'stopped', 'stale', 'unknown'].includes(system.data.workerState));
  assert.deepEqual(system.data.mobileDevices, ['Android', 'iOS']); assert.ok(!('databasePath' in system.data)); assert.ok(!('openaiApiKey' in system.data));
});
