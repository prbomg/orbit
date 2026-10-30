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
test('workspace: home projects, safe copies, searchable task filters and diagnostics', { timeout: 90000 }, async () => {
  const fixture = await poolFixture();
  const root = resolve(import.meta.dirname, '..');
  let server, browser, output = '';
  try {
    await fixture.db.proxy.deleteMany();
    const project = await fixture.db.project.update({where:{id:fixture.project.id},data:{name:'Альфа',scheduleHours:'0'.repeat(12)+'1'.repeat(156),scheduleTimezone:'Asia/Yekaterinburg',geolocation:{mode:'manual',latitude:55.7,longitude:37.6,radiusKm:3}}});
    const other=await fixture.db.project.create({data:{name:'Яблоко',targetUrl:'https://other.test/',yandexRegionId:'15',regionName:'Тула'}});
    const task = await fixture.db.task.create({ data: { projectId: project.id, url: '', status: 'paused',targetExecutions:19,currentExecutions:7,concurrency:3,dailyExecutionLimit:4,yandexRegionId:213,searchEngine:'yandex',searchDepth:7,searchQueries:['тестовая фраза'],vitalPhrases:['название'],targetKeywords:['слово'],visitSettings:{minSeconds:30,maxSeconds:90},retryState:{count:3,code:'test'} } });
    const archived=await fixture.db.project.create({data:{name:'Архив',targetUrl:'https://archive.test/',yandexRegionId:'213',regionName:'',archivedAt:new Date()}});
    const archivedTask=await fixture.db.task.create({data:{projectId:archived.id,status:'paused'}});
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
    assert.equal((await fetch(`${origin}/api/tasks/${task.id}/duplicate/`,{method:'POST',headers:{Origin:origin}})).status,401);
    browser = await chromium.launch({ headless: true, executablePath: process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath() });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addCookies([{ name: 'orbit_session', value: token, url: origin }]);
    const request = context.request;
    const post=path=>request.post(origin+path,{headers:{Origin:origin}});
    assert.equal((await post('/api/projects/missing/duplicate/')).status(),404);
    assert.equal((await post('/api/tasks/missing/duplicate/')).status(),404);
    assert.equal((await post(`/api/tasks/${archivedTask.id}/duplicate/`)).status(),409);
    assert.equal((await request.post(`${origin}/api/tasks/${task.id}/duplicate/`,{headers:{Origin:'https://foreign.test'}})).status(),403);
    const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin+'/');await page.getByRole('heading',{name:'Проекты.',exact:true}).waitFor();
    assert.equal(await page.getByRole('heading',{name:'Динамика выполнений',exact:true}).count(),0);
    const projectResult=page.waitForResponse(r=>r.url().endsWith(`/api/projects/${project.id}/duplicate/`)&&r.request().method()==='POST');
    await page.getByRole('button',{name:'Дублировать проект Альфа',exact:true}).click();
    const pr=await projectResult;assert.equal(pr.status(),201);const projectCopy=await pr.json();
    const savedProject=await fixture.db.project.findUnique({where:{id:projectCopy.id},include:{_count:{select:{tasks:true,profileUses:true,profileHistory:true,visits:true}}}});
    for(const key of ['targetUrl','yandexRegionId','regionName','scheduleHours','scheduleTimezone','geolocation'])assert.deepEqual(savedProject[key],project[key],key);
    assert.equal(savedProject.name,'Альфа — копия');assert.equal(savedProject.archivedAt,null);assert.deepEqual(Object.values(savedProject._count),[0,0,0,0]);
    await page.getByRole('link',{name:'Альфа — копия',exact:true}).waitFor();
    await page.goto(origin+'/projects/');await page.getByRole('heading',{name:'Проекты.',exact:true}).waitFor();
    await page.goto(origin+'/tasks/?mode=direct&sort=progress');
    await page.locator(`[data-task-id="${task.id}"]`).waitFor();
    await page.getByRole('button',{name:/Выбрать проект:/}).waitFor();
    assert.equal(await page.getByLabel('Фильтр сценария',{exact:true}).count(),0);assert.equal(await page.getByLabel('Сортировка задач',{exact:true}).count(),0);
    const selector=page.getByRole('button',{name:/Выбрать проект:/});const search=page.getByRole('textbox',{name:'Поиск задач',exact:true});
    const a=await selector.boundingBox(),b=await search.boundingBox();assert.equal(a.height,b.height);assert(a.x<b.x);
    await selector.click();const options=page.getByRole('option');const names=await options.allTextContents();assert.deepEqual(names,['Все проекты','Альфа','Альфа — копия','Яблоко']);
    await page.getByRole('combobox',{name:'Поиск проекта',exact:true}).fill('альф');assert.equal(await options.count(),2);
    await page.getByRole('option',{name:'Альфа',exact:true}).click();
    await search.fill('тестовая');await page.locator(`[data-task-id="${task.id}"]`).waitFor();await search.fill('');
    const taskResult=page.waitForResponse(r=>r.url().endsWith(`/api/tasks/${task.id}/duplicate/`)&&r.request().method()==='POST');
    await page.locator(`[data-task-id="${task.id}"]`).getByRole('button',{name:/Дублировать задачу/}).click();
    const tr=await taskResult;assert.equal(tr.status(),201);const taskCopy=await tr.json();
    const savedTask=await fixture.db.task.findUnique({where:{id:taskCopy.id},include:{_count:{select:{executions:true,dailyPlans:true,projectUses:true}}}});
    for(const key of ['projectId','taskType','url','targetExecutions','concurrency','dailyExecutionLimit','yandexRegionId','searchEngine','searchDepth','searchQueries','vitalPhrases','targetKeywords','visitSettings'])assert.deepEqual(savedTask[key],task[key],key);
    assert.equal(savedTask.status,'paused');assert.equal(savedTask.currentExecutions,0);assert.equal(savedTask.profileId,null);assert.deepEqual(savedTask.retryState,{});assert.deepEqual(Object.values(savedTask._count),[0,0,0]);
    await page.locator(`[data-task-id="${taskCopy.id}"]`).waitFor();
    await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    const ma=await selector.boundingBox(),mb=await search.boundingBox();assert.equal(ma.height,mb.height);assert(ma.y<mb.y);
    await page.screenshot({path:join(root,'prepared/interface-rework-20261022/tasks-mobile.png'),fullPage:true});
    await page.goto(origin+'/analytics/');await page.getByRole('heading',{name:'Динамика выполнений',exact:true}).waitFor();
    assert.equal(await page.getByRole('heading',{name:'Причины ошибок попыток',exact:true}).count(),0);
    await page.getByRole('button',{name:'Диагностика попыток',exact:true}).click();
    await page.getByRole('heading',{name:'Причины ошибок попыток',exact:true}).waitFor();
    assert.equal(await page.getByRole('heading',{name:'Динамика выполнений',exact:true}).count(),0);
    await page.getByRole('button',{name:'Сервисы капчи',exact:true}).click();await page.getByRole('heading',{name:'Сервисы капчи',exact:true}).waitFor();
    assert.equal(await page.getByRole('heading',{name:'Причины ошибок попыток',exact:true}).count(),0);
    await page.getByRole('button',{name:'Прокси и IP',exact:true}).click();await page.getByRole('heading',{name:'Фактические IP браузера',exact:true}).waitFor();
    await page.reload();await page.getByRole('heading',{name:'Фактические IP браузера',exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.screenshot({path:join(root,'prepared/interface-rework-20261022/analytics-mobile.png'),fullPage:true});
    await page.setViewportSize({width:1440,height:1000});await page.getByRole('button',{name:'Обзор',exact:true}).click();await page.getByRole('heading',{name:'Динамика выполнений',exact:true}).waitFor();
    await page.screenshot({path:join(root,'prepared/interface-rework-20261022/analytics-desktop.png'),fullPage:true});
    assert.deepEqual(errors,[]);assert.deepEqual(await fixture.db.task.findUnique({where:{id:task.id}}),task);
    assert.equal(await fixture.db.task.count({where:{status:'running'}}),0);
  } catch (error) { error.message += '\n' + output.slice(-3000); throw error; }
  finally {
    await browser?.close();
    if (server && server.exitCode === null) { server.kill('SIGTERM'); await new Promise(resolve => server.once('exit', resolve)); }
    await fixture.cleanup();
  }
});
