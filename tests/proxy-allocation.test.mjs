import test from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { poolFixture } from './helpers/pool-fixture.mjs';
import { claimTarget, claimWarmup, finishClaim, markTargetUsed } from '../worker/pool-scheduler.mjs';
import channels from '../utils/proxyChannel.js';
import pool from '../utils/profilePool.js';

process.env.WORKER_PROFILES_DIR = '';
async function prepared(run) {
  const f = await poolFixture();
  try {
    for (let i = 0; i < 10; i++) await f.ready();
    for (const port of [8001, 8002, 8003]) await f.db.proxy.create({ data: { host: f.proxy.host, port, username: 'fixture', password: 'fixture', rotationUrl: `https://rotation.test/${port}` } });
    await run(f);
  } finally { await f.cleanup(); }
}

test('different ports on a gateway are independent; explicit, rotation and TCP aliases stay linked', () => {
  const a = { id: 'a', host: 'gateway.test', port: 8000 };
  const b = { id: 'b', host: a.host, port: 8001 };
  assert.notEqual(channels.proxyKey(a), channels.proxyKey(b));
  assert.equal(channels.channelMembers([a, b], a).length, 1);
  for (const shared of [{ channel: 'modem' }, { rotationUrl: 'https://rotation.test/shared' }, { tcpChannelId: 'modem' }]) {
    const proxies = [{ ...a, ...shared }, { ...b, ...shared }];
    assert.equal(channels.channelMembers(proxies, proxies[0]).length, 2);
  }
});

test('parallel reservations across tasks and database clients get four different project proxies', async () => {
  await prepared(async f => {
    const tasks = [await f.task(f.project.id, 4), await f.task(f.project.id, 4)];
    await f.db.task.updateMany({ data: { concurrency: 2 } });
    const other = new PrismaClient({ datasources: { db: { url: `file:${f.dir}/test.db` } } });
    try {
      const claims = await Promise.all([claimTarget(f.db, tasks[0].id, 'a'), claimTarget(other, tasks[1].id, 'b'), claimTarget(f.db, tasks[0].id, 'a'), claimTarget(other, tasks[1].id, 'b')]);
      assert.ok(claims.every(Boolean));
      assert.equal(new Set(claims.map(claim => claim.proxy.id)).size, 4);
      assert.equal(new Set(claims.map(claim => claim.task.profileId)).size, 4);
    } finally { await other.$disconnect(); }
  });
});

test('when enough proxies exist, a busy alternative causes waiting instead of sharing the project proxy', async () => {
  await prepared(async f => {
    await f.db.proxy.updateMany({ where: { port: { in: [8002, 8003] } }, data: { isActive: false } });
    const task = await f.task(f.project.id, 4); await f.db.task.update({ where: { id: task.id }, data: { concurrency: 2 } });
    const first = await claimTarget(f.db, task.id, 'a'); assert.ok(first);
    const spare = await f.db.proxy.findFirst({ where: { isActive: true, id: { not: first.proxy.id } } });
    const key = channels.proxyKey(spare);
    await f.db.workflowLease.create({ data: { key, owner: 'busy', expiresAt: new Date(Date.now() + 60000) } });
    assert.equal(await claimTarget(f.db, task.id, 'a'), null);
    await f.db.workflowLease.delete({ where: { key } });
    assert.equal((await claimTarget(f.db, task.id, 'a')).proxy.id, spare.id);
  });
});

test('more slots than proxies distribute load before sharing', async () => {
  await prepared(async f => {
    await f.db.proxy.updateMany({ where: { port: { in: [8002, 8003] } }, data: { isActive: false } });
    const task = await f.task(f.project.id, 6); await f.db.task.update({ where: { id: task.id }, data: { concurrency: 3 } });
    const a = await claimTarget(f.db, task.id, 'a'), b = await claimTarget(f.db, task.id, 'a'), c = await claimTarget(f.db, task.id, 'a');
    assert.ok(a && b && c); assert.notEqual(a.proxy.id, b.proxy.id);
    assert.ok([a.proxy.id, b.proxy.id].includes(c.proxy.id));
  });
});

test('a successful sibling cannot erase a pending failed allocation; failed profiles stay excluded after reconnect', async () => {
  await prepared(async f => {
    const task = await f.task(f.project.id, 6); await f.db.task.update({ where: { id: task.id }, data: { concurrency: 2 } });
    const a = await claimTarget(f.db, task.id, 'a'), b = await claimTarget(f.db, task.id, 'a');
    await finishClaim(f.db, a, { errorCode: 'timeout' });
    await finishClaim(f.db, b, { success: true });
    assert.deepEqual((await f.db.task.findUnique({ where: { id: task.id } })).retryState, {});
    // Force the failed proxy to sort first unless the pending failure excludes it.
    await f.db.taskExecution.update({ where: { id: a.task.executionId }, data: { startedAt: new Date(0) } });
    await f.db.$disconnect();
    const next = await claimTarget(f.db, task.id, 'a');
    assert.ok(next); assert.notEqual(next.proxy.id, a.proxy.id); assert.notEqual(next.task.profileId, a.task.profileId);
    await finishClaim(f.db, next, { success: true });
    for (let i = 0; i < 3; i++) {
      const claim = await claimTarget(f.db, task.id, 'a'); assert.ok(claim); assert.notEqual(claim.task.profileId, a.task.profileId);
      await finishClaim(f.db, claim, { success: true });
    }
  });
});

test('failed channel aliases cannot substitute for a new proxy', async () => {
  await prepared(async f => {
    await f.db.proxy.updateMany({ data: { channel: 'same-modem' } });
    const task = await f.task(f.project.id, 3), first = await claimTarget(f.db, task.id, 'a');
    await finishClaim(f.db, first, { errorCode: 'timeout' });
    assert.equal(await claimTarget(f.db, task.id, 'a'), null);
  });
});

test('successful sequential allocations use idle proxies in turn; warmup may use another port of the gateway', async () => {
  await prepared(async f => {
    const task = await f.task(f.project.id, 4), ids = [];
    for (let i = 0; i < 4; i++) {
      const claim = await claimTarget(f.db, task.id, 'a'); assert.ok(claim); ids.push(claim.proxy.id);
      await markTargetUsed(f.db, claim);
      await finishClaim(f.db, claim, { success: true });
    }
    assert.equal(new Set(ids).size, 4);
    await f.db.$transaction(tx => pool.createProfileBatch(tx, { count: 1 }));
    const warmup = await claimWarmup(f.db); assert.ok(warmup);
    const target = await claimTarget(f.db, task.id, 'a'); assert.ok(target);
    assert.notEqual(warmup.proxy.port, target.proxy.port);
  });
});
