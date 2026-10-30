import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright';
import { access } from 'node:fs/promises';
import runtime from '../utils/workerRuntime.js';
import { poolFixture } from './helpers/pool-fixture.mjs';

test('task names: defaults, validation, renaming, copies, editor and list search', {timeout:120000}, async()=>{
 const f=await poolFixture();let server,browser,output='';
 try{
  const other=await f.db.project.create({data:{name:'Другой проект',targetUrl:'https://other.test',yandexRegionId:'213',regionName:'Москва'}});
  const legacy=await f.db.task.create({data:{projectId:f.project.id,status:'paused',url:'https://example.test/legacy',targetExecutions:10,currentExecutions:3}});
  const user=await f.db.authUser.create({data:{email:'names@example.test',passwordHash:'disabled'}}),token=randomBytes(32).toString('hex');
  await f.db.authSession.create({data:{userId:user.id,tokenHash:createHash('sha256').update(token).digest('hex'),expiresAt:new Date(Date.now()+300000)}});
  const socket=createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));const origin=`http://127.0.0.1:${port}`,root=resolve(import.meta.dirname,'..');
  server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port',String(port)],{cwd:root,env:{...process.env,DATABASE_URL:`file:${f.dir}/test.db`,APP_ORIGIN:origin,AUTH_EMAIL:user.email},stdio:['ignore','pipe','pipe']});server.stdout.on('data',b=>output+=b);server.stderr.on('data',b=>output+=b);
  for(let i=0;;i++){try{if((await fetch(origin+'/login/')).ok)break;}catch{}if(i>150)throw Error('Fixture server did not start');await new Promise(r=>setTimeout(r,100));}
  const request=(path,body,method='POST')=>fetch(origin+path,{method,headers:{Cookie:`orbit_session=${token}`,Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const call=async(path,body,method)=>{const r=await request(path,body,method);const data=await r.json();assert.ok(r.ok,JSON.stringify(data));return data;};
  const base={projectId:f.project.id,taskType:'target',status:'paused',url:'https://example.test',targetExecutions:10};
  assert.equal((await call('/api/tasks/',base)).name,f.project.name);
  const custom=await call('/api/tasks/',{...base,name:'  Логопед — Москва  '});assert.equal(custom.name,'Логопед — Москва');
  for(const name of ['', '   ', 'x'.repeat(101), 'bad\nname', null, 42])assert.equal((await request('/api/tasks/',{...base,name})).status,400);
  assert.equal((await call(`/api/tasks/${custom.id}/`,{concurrency:2},'PATCH')).name,custom.name);
  const before=await f.db.task.findUniqueOrThrow({where:{id:legacy.id}});
  const renamed=await call(`/api/tasks/${legacy.id}/`,{name:'Только название'},'PATCH');assert.equal(renamed.name,'Только название');
  const after=await f.db.task.findUniqueOrThrow({where:{id:legacy.id}});assert.deepEqual({...after,name:null},before);
  const active=await f.db.task.create({data:{projectId:other.id,status:'running',url:'https://other.test',targetExecutions:10,currentExecutions:2}});
  assert.equal((await call(`/api/tasks/${active.id}/`,{name:'Название активной задачи'},'PATCH')).status,'running');
  await assert.rejects(access(runtime.projectPaths(join(root,'.orbit-runtime'),other.id).record),{code:'ENOENT'});
  assert.deepEqual({...await f.db.task.findUniqueOrThrow({where:{id:active.id}}),name:null},active);
  await f.db.task.update({where:{id:active.id},data:{status:'paused'}});
  const copy=await call(`/api/tasks/${custom.id}/duplicate/`);assert.equal(copy.name,custom.name);assert.equal(copy.status,'paused');assert.equal(copy.currentExecutions,0);
  browser=await chromium.launch({headless:true,executablePath:process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH});const context=await browser.newContext();await context.addCookies([{name:'orbit_session',value:token,url:origin}]);const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(origin+'/tasks/');
  await page.getByRole('button',{name:'Создать задачу',exact:true}).click();const dialog=page.getByRole('dialog'),name=dialog.getByLabel('Название задачи',{exact:true}),project=dialog.getByLabel('Проект новой задачи');
  await project.selectOption(f.project.id);assert.equal(await name.inputValue(),f.project.name);await project.selectOption(other.id);assert.equal(await name.inputValue(),other.name);
  await name.fill('Моя задача по логопедии');await project.selectOption(f.project.id);assert.equal(await name.inputValue(),'Моя задача по логопедии');
  await dialog.locator('[name="status"]').selectOption('paused');await dialog.getByRole('button',{name:'Создать задачу',exact:true}).click();await dialog.waitFor({state:'hidden'});
  const saved=await f.db.task.findFirstOrThrow({where:{name:'Моя задача по логопедии'}});assert.equal(saved.projectId,f.project.id);
  await page.getByLabel('Поиск задач',{exact:true}).fill('ЛОГОПЕДИИ');const rows=page.locator('[data-task-id]');await page.waitForFunction(()=>document.querySelectorAll('[data-task-id]').length===1);assert.equal(await rows.first().getAttribute('data-task-id'),saved.id);
  await rows.first().getByRole('button',{name:'Редактировать Моя задача по логопедии',exact:true}).click();assert.equal(await name.inputValue(),saved.name);await name.fill('Переименованная задача');await dialog.getByRole('button',{name:'Сохранить изменения'}).click();await dialog.waitFor({state:'hidden'});
  await page.getByLabel('Поиск задач',{exact:true}).fill('Переименованная');await page.waitForFunction(()=>document.querySelectorAll('[data-task-id]').length===1);assert.equal(await rows.first().locator('.task-name-cell strong a').innerText(),'Переименованная задача');
  await page.reload();await rows.first().waitFor();await page.getByLabel('Поиск задач',{exact:true}).fill('Переименованная');await page.waitForFunction(()=>document.querySelectorAll('[data-task-id]').length===1);assert.equal(await rows.first().getAttribute('data-task-id'),saved.id);
  await page.getByRole('button',{name:'Создать задачу',exact:true}).click();await project.selectOption(f.project.id);assert.equal(await name.inputValue(),f.project.name);assert.deepEqual(errors,[]);
 }catch(e){e.message+='\n'+output.slice(-1500);throw e;}
 finally{await browser?.close();if(server&&server.exitCode===null){server.kill('SIGTERM');await new Promise(r=>server.once('exit',r));}await f.cleanup();}
});
