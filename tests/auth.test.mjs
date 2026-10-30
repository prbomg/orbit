import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { hashPassword, verifyPassword } from '../lib/password.mjs';
const base = process.env.API_TEST_BASE_URL;
if (!base || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname)) throw new Error('Set API_TEST_BASE_URL to an isolated local Orbit server');
const origin = new URL(base).origin;
const email = process.env.AUTH_EMAIL || 'seo@uniofweb.ru';
const request = (path, { method = 'GET', cookie, body, headers = {} } = {}) => fetch(`${base}${path}`, {
  method, redirect: 'manual', headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
  ...(body ? { body: JSON.stringify(body) } : {}),
});
test('password hashes are salted and reject incorrect or malformed credentials', async () => {
  const password = randomBytes(24).toString('base64url');
  const hash = await hashPassword(password);
  assert.notEqual(hash, await hashPassword(password));
  assert.ok(await verifyPassword(password, hash));
  assert.equal(await verifyPassword(`${password}!`, hash), false);
  assert.equal(await verifyPassword(password, 'broken'), false);
});
test('private pages and every API method require a valid session, even with forged proxy headers', async () => {
  for (const path of ['/', '/projects/', '/projects/fake/', '/tasks/', '/tasks/fake/live/', '/profiles/', '/proxies/', '/settings/']) {
    for (const cookie of [undefined, `orbit_session=${'0'.repeat(64)}`]) {
      const response = await request(path, { cookie });
      assert.equal(response.status, 307, path); assert.match(response.headers.get('location'), /\/login\/$/);
    }
  }
  const routes = {
    '/api/projects/': ['GET', 'POST'], '/api/projects/fake/': ['GET', 'PATCH', 'DELETE'], '/api/projects/fake/run/': ['GET', 'POST'],
    '/api/tasks/': ['GET', 'POST'], '/api/tasks/fake/': ['GET', 'PATCH', 'PUT', 'DELETE'],
    '/api/tasks/fake/live/': ['GET'], '/api/tasks/fake/live/screenshot/': ['GET'],
    '/api/profiles/': ['GET', 'POST'], '/api/profiles/fake/': ['GET', 'PATCH', 'DELETE'], '/api/profiles/pool/': ['GET'], '/api/profiles/actions/': ['POST'], '/api/profiles/batch/': ['POST'], '/api/profiles/warmup/': ['POST'],
    '/api/proxies/': ['GET', 'POST'], '/api/proxies/fake/': ['GET', 'PATCH', 'PUT', 'DELETE'], '/api/settings/': ['GET', 'PATCH'], '/api/settings/mobileproxy-key/': ['GET'], '/api/system/': ['GET'],
  };
  for (const [path, methods] of Object.entries(routes)) for (const method of methods) {
    const response = await request(path, { method, cookie: `orbit_session=${'0'.repeat(64)}`, headers: { 'x-middleware-subrequest': 'proxy:proxy:proxy:proxy:proxy' } });
    assert.equal(response.status, 401, `${method} ${path}`);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.equal((await request('/login/')).status, 200);
});
test('login, CSRF, expiry, logout revocation, allowlist and persistent throttling', async () => {
  const db = new PrismaClient();
  const password = randomBytes(24).toString('base64url');
  const previous = await db.authUser.findUnique({ where: { email } });
  const user = await db.authUser.upsert({ where: { email }, create: { email, passwordHash: await hashPassword(password) }, update: { passwordHash: await hashPassword(password) } });
  const hashes = [];
  try {
    await db.authThrottle.deleteMany({});
    const login = (body = { email, password }, headers) => request('/api/auth/login/', { method: 'POST', body, headers });
    assert.equal((await login(undefined, { Origin: 'https://evil.test' })).status, 403);
    assert.equal((await login({ email, password: 'incorrect' })).status, 401);
    assert.equal((await login({ email: 'another@example.test', password })).status, 401);
    const response = await login({ email: email.toUpperCase(), password });
    assert.equal(response.status, 200);
    const setCookie = response.headers.get('set-cookie');
    assert.match(setCookie, /HttpOnly/i); assert.match(setCookie, /SameSite=lax/i); assert.doesNotMatch(setCookie, /Max-Age|Expires=/i);
    const cookie = setCookie.split(';')[0];
    const tokenHash = createHash('sha256').update(cookie.split('=')[1]).digest('hex'); hashes.push(tokenHash);
    const ordinarySession = await db.authSession.findUniqueOrThrow({ where: { tokenHash } });
    assert.ok(Math.abs(ordinarySession.expiresAt.getTime() - Date.now() - 12 * 3600_000) < 5000);
    assert.equal((await request('/api/projects/', { cookie })).status, 200);
    assert.equal((await request('/', { cookie })).status, 200);
    assert.equal((await request('/api/auth/logout/', { method: 'POST', cookie, headers: { Origin: 'https://evil.test' } })).status, 403);
    assert.equal((await request('/api/projects/', { cookie })).status, 200);
    assert.equal((await request('/api/auth/logout/', { method: 'POST', cookie })).status, 200);
    assert.equal((await request('/api/projects/', { cookie })).status, 401);
    assert.equal(await db.authSession.findUnique({ where: { tokenHash } }), null);
    assert.equal((await login({ email, password, rememberMe: "true" })).status, 400);
    const remembered = await login({ email, password, rememberMe: true });
    assert.equal(remembered.status, 200);
    const persistentCookie = remembered.headers.get('set-cookie');
    assert.match(persistentCookie, /Max-Age=2592000/i); assert.match(persistentCookie, /HttpOnly/i);
    const rememberedCookie = persistentCookie.split(';')[0];
    const rememberedHash = createHash('sha256').update(rememberedCookie.split('=')[1]).digest('hex'); hashes.push(rememberedHash);
    const persistentSession = await db.authSession.findUniqueOrThrow({where:{tokenHash:rememberedHash}});
    assert.ok(Math.abs(persistentSession.expiresAt.getTime() - Date.now() - 30 * 24 * 3600_000) < 5000);
    assert.equal((await request('/api/settings/', {cookie:rememberedCookie})).status, 200);
    // Logging in again replaces the remembered session with a short browser session.
    const short = await request('/api/auth/login/', {method:'POST',cookie:rememberedCookie,body:{email,password,rememberMe:false}});
    assert.equal(short.status,200);assert.doesNotMatch(short.headers.get('set-cookie'), /Max-Age|Expires=/i);
    assert.equal((await request('/api/settings/', {cookie:rememberedCookie})).status,401);
    const shortCookie = short.headers.get('set-cookie').split(';')[0];
    await request('/api/auth/logout/', {method:'POST',cookie:shortCookie});
    const rememberedLogout = await login({email,password,rememberMe:true});
    const logoutCookie = rememberedLogout.headers.get('set-cookie').split(';')[0];
    await request('/api/auth/logout/', {method:'POST',cookie:logoutCookie});
    assert.equal((await request('/api/settings/', {cookie:logoutCookie})).status,401);
    const nextCookie = (await login()).headers.get('set-cookie').split(';')[0];
    const nextHash = createHash('sha256').update(nextCookie.split('=')[1]).digest('hex'); hashes.push(nextHash);
    await db.authSession.update({ where: { tokenHash: nextHash }, data: { expiresAt: new Date(Date.now() - 1000) } });
    assert.equal((await request('/api/settings/', { cookie: nextCookie })).status, 401);
    await db.authThrottle.upsert({ where: { id: 'login' }, create: { id: 'login', attempts: 20, resetAt: BigInt(Date.now() + 60_000) }, update: { attempts: 20, resetAt: BigInt(Date.now() + 60_000) } });
    assert.equal((await login()).status, 429);
    assert.equal((await login(undefined, { 'x-forwarded-for': '192.0.2.1' })).status, 429);
    await db.authThrottle.update({ where: { id: 'login' }, data: { resetAt: BigInt(Date.now() - 1000) } });
    const recovered = await login(); assert.equal(recovered.status, 200);
    await request('/api/auth/logout/', { method: 'POST', cookie: recovered.headers.get('set-cookie').split(';')[0] });
  } finally {
    await db.authSession.deleteMany({ where: { tokenHash: { in: hashes } } });
    await db.authThrottle.deleteMany({});
    if (previous) await db.authUser.update({ where: { id: user.id }, data: { passwordHash: previous.passwordHash } });
    else await db.authUser.delete({ where: { id: user.id } });
    await db.$disconnect();
  }
});
