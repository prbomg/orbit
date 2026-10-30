import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { poolFixture } from './helpers/pool-fixture.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
test('project deletion: confirmation, activity guards, atomic cleanup and preserved profiles', { timeout: 90000 }, async () => {
  const fixture = await poolFixture();
  const root = resolve(import.meta.dirname, '..');
  let server, browser, output = '';
  try {
    await fixture.db.proxy.deleteMany();
    const task = await fixture.db.task.create({ data: { projectId: fixture.project.id, url: 'https://example.test/', status: 'paused' } });
    const user = await fixture.db.authUser.create({ data: { email: 'tech-log@example.test', passwordHash: 'disabled-fixture' } });
    const token = randomBytes(32).toString('hex');
    await fixture.db.authSession.create({ data: { userId: user.id, tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt: new Date(Date.now() + 300000) } });
    const socket = createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
    const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
    const origin = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, [join(root, 'node_modules/next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
      cwd: root, env: { ...process.env, DATABASE_URL: `file:${fixture.dir}/test.db`, AUTH_EMAIL: user.email, APP_ORIGIN: origin, ORBIT_LIVE_RUNTIME_DIRECTORY: join(fixture.dir, 'runtime') }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.on('data', bytes => output += bytes); server.stderr.on('data', bytes => output += bytes);
    for (let n = 0; ; n++) {
      try { if ((await fetch(origin + '/login/')).ok) break; } catch {}
      if (n > 150) throw Error('Fixture startup failed'); await wait(100);
    }
    const endpoint = `${origin}/api/projects/${fixture.project.id}/`;
    assert.equal((await fetch(endpoint,{method:'DELETE'})).status,401);
    browser = await chromium.launch({ headless: true, executablePath: process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath() });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addCookies([{ name: 'orbit_session', value: token, url: origin }]);
    const request = context.request;
    const profile=await fixture.db.profile.create({data:{name:'Preserved profile',status:'ready'}});
    const other=await fixture.db.project.create({data:{name:'Keep project',targetUrl:'https://other.test',yandexRegionId:'213',regionName:''}});
    const execution=await fixture.db.taskExecution.create({data:{taskId:task.id,profileId:profile.id,status:'completed'}});
    await fixture.db.taskDailyPlan.create({data:{taskId:task.id,dayKey:'2026-10-22',settingsKey:'fixture',slots:[]}});
    for(const projectId of [fixture.project.id,other.id]){
      await fixture.db.projectProfileUse.create({data:{projectId,profileId:profile.id,...(projectId===fixture.project.id?{taskId:task.id}:{})}});
      await fixture.db.profileProjectHistory.create({data:{projectId,profileId:profile.id,source:'fixture'}});
      await fixture.db.projectVisit.create({data:{projectId,kind:'direct',engine:'',visitedAt:new Date()}});
    }
    const remove=(confirmation,originHeader=origin)=>request.delete(endpoint,{headers:{Origin:originHeader},...(confirmation===undefined?{}:{data:{deleteHistory:true,confirmation}})});
    const info=await (await request.get(endpoint+'?deletion=1')).json();
    assert.deepEqual({tasks:info.tasks,executions:info.executions,visits:info.visits,profileUses:info.profileUses,profileHistory:info.profileHistory,blocked:info.blocked},{tasks:1,executions:1,visits:1,profileUses:1,profileHistory:1,blocked:false});
    assert.equal((await remove()).status(),409);
    assert.equal((await remove('wrong name')).status(),400);
    assert.equal((await remove('Fixture','https://foreign.test')).status(),403);
    await fixture.db.task.update({where:{id:task.id},data:{status:'running'}});
    assert.equal((await remove('Fixture')).status(),409);
    await fixture.db.task.update({where:{id:task.id},data:{status:'paused'}});
    await fixture.db.taskExecution.update({where:{id:execution.id},data:{status:'running'}});
    assert.equal((await remove('Fixture')).status(),409);
    await fixture.db.taskExecution.update({where:{id:execution.id},data:{status:'completed'}});
    // Force the final delete to fail and verify all child deletes roll back.
    await fixture.db.$executeRawUnsafe(`CREATE TRIGGER deletion_fixture BEFORE DELETE ON Project BEGIN SELECT RAISE(ABORT, 'fixture'); END`);
    assert.equal((await remove('Fixture')).status(),500);
    assert.equal(await fixture.db.task.count({where:{projectId:fixture.project.id}}),1);
    assert.equal(await fixture.db.projectVisit.count({where:{projectId:fixture.project.id}}),1);
    assert.equal(await fixture.db.projectProfileUse.count({where:{projectId:fixture.project.id}}),1);
    assert.equal(await fixture.db.profileProjectHistory.count({where:{projectId:fixture.project.id}}),1);
    assert.equal(await fixture.db.taskDailyPlan.count({where:{taskId:task.id}}),1);
    await fixture.db.$executeRawUnsafe('DROP TRIGGER deletion_fixture');
    const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(origin+'/');await page.getByRole('button',{name:'Удалить проект Fixture',exact:true}).click();
    const dialog=page.getByRole('dialog');await dialog.getByLabel('Название проекта для удаления').waitFor();
    const button=dialog.getByRole('button',{name:'Удалить проект и историю',exact:true});assert(await button.isDisabled());
    await dialog.getByLabel('Название проекта для удаления').fill('wrong');assert(await button.isDisabled());
    await page.setViewportSize({width:390,height:844});assert.equal(await dialog.evaluate(el=>el.scrollWidth>el.clientWidth),false);
    await dialog.getByLabel('Название проекта для удаления').fill('Fixture');
    const response=page.waitForResponse(r=>r.url()===endpoint&&r.request().method()==='DELETE');await button.click();assert.equal((await response).status(),204);
    await dialog.waitFor({state:'hidden'});await page.getByRole('button',{name:'Удалить проект Fixture',exact:true}).waitFor({state:'detached'});
    assert.equal(await fixture.db.project.count({where:{id:fixture.project.id}}),0);
    for(const [model,where] of [['task',{projectId:fixture.project.id}],['taskExecution',{taskId:task.id}],['taskDailyPlan',{taskId:task.id}],['projectVisit',{projectId:fixture.project.id}],['projectProfileUse',{projectId:fixture.project.id}],['profileProjectHistory',{projectId:fixture.project.id}]])assert.equal(await fixture.db[model].count({where}),0,model);
    assert.equal(await fixture.db.profile.count({where:{id:profile.id}}),1);
    for(const model of ['projectVisit','projectProfileUse','profileProjectHistory'])assert.equal(await fixture.db[model].count({where:{projectId:other.id}}),1);
    assert.equal((await remove('Fixture')).status(),404);assert.deepEqual(errors,[]);
    // The reported case: no tasks, but historical links remain.
    const historyEndpoint=`${origin}/api/projects/${other.id}/`;
    assert.equal((await request.delete(historyEndpoint,{headers:{Origin:origin},data:{deleteHistory:true,confirmation:'Keep project'}})).status(),204);
    assert.equal(await fixture.db.profile.count({where:{id:profile.id}}),1);
  } catch (error) { error.message += '\n' + output.slice(-3000); throw error; }
  finally {
    await browser?.close();
    if (server && server.exitCode === null) { server.kill('SIGTERM'); await new Promise(resolve => server.once('exit', resolve)); }
    await fixture.cleanup();
  }
});
