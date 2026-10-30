import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { access, readFile, rm, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import store from '../utils/taskLogStore.js';
import { poolFixture } from './helpers/pool-fixture.mjs';
test('authenticated downloads, attempt selection, ZIP and mobile journal', {skip:process.env.ORBIT_LOG_UI_TEST!=='1',timeout:120000},async()=>{
 const root=resolve(import.meta.dirname,'..'),logs=join(root,'logs/tasks');
 // Only run against an isolated candidate: never delete existing service logs.
 assert.ok(root.includes('/maintenance/')&&root.endsWith('/candidate'));
 await assert.rejects(access(logs),{code:'ENOENT'});
 const f=await poolFixture();let server,browser,output='';
 try{
  const task=await f.task(),profile=await f.ready();const date=new Date();
  const execution=await f.db.taskExecution.create({data:{taskId:task.id,profileId:profile.id,status:'completed',attempts:1,startedAt:date,completedAt:date}});
  const meta={id:'fixture-attempt',taskId:task.id,executionId:execution.id,startedAt:date.toISOString(),executionStartedAt:date.toISOString()};
  await store.writeBatch(logs,Array.from({length:90},(_,i)=>({meta,time:date.toISOString(),event:'test',line:`[${date.toISOString()}] [test] ${i} ${'x'.repeat(1000)}\n`,end:i===89?'success':undefined})));
  const user=await f.db.authUser.create({data:{email:'logtest@example.test',passwordHash:'disabled'}}),token=randomBytes(32).toString('hex');
  await f.db.authSession.create({data:{userId:user.id,tokenHash:createHash('sha256').update(token).digest('hex'),expiresAt:new Date(Date.now()+300000)}});
  const socket=createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));const origin=`http://127.0.0.1:${port}`;
  server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port',String(port)],{cwd:root,env:{...process.env,DATABASE_URL:`file:${f.dir}/test.db`,APP_ORIGIN:origin,AUTH_EMAIL:user.email},stdio:['ignore','pipe','pipe']});server.stdout.on('data',b=>output+=b);server.stderr.on('data',b=>output+=b);
  for(let i=0;;i++){try{if((await fetch(origin+'/login/')).ok)break;}catch{}if(i>150)throw Error('Fixture server did not start');await new Promise(r=>setTimeout(r,100));}
  const base=`${origin}/api/tasks/${task.id}/tech-log/`,headers={Cookie:`orbit_session=${token}`};
  assert.notEqual((await fetch(base+'?format=index',{redirect:'manual'})).status,200);
  assert.equal((await fetch(base+'?attemptId=unknown',{headers})).status,404);
  const result=await fetch(base+`?format=index&executionId=${execution.id}&startedAt=${encodeURIComponent(date.toISOString())}`,{headers});assert.equal(result.status,200);assert.equal((await result.json()).attempts[0].parts.length,2);
  browser=await chromium.launch({headless:true,executablePath:process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH});const context=await browser.newContext({viewport:{width:1440,height:1000}});await context.addCookies([{name:'orbit_session',value:token,url:origin}]);const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`${origin}/tasks/${task.id}/live/?tab=journal`);
  const parts=page.getByLabel('Часть технического лога');await parts.waitFor();assert.equal(await parts.locator('option').count(),2);
  await parts.selectOption('part-000002.txt');const downloadPromise=page.waitForEvent('download');await page.getByRole('link',{name:'Скачать лог (.txt)',exact:true}).click();const file=await downloadPromise;assert.match(file.suggestedFilename(),/part-000002.txt$/);const text=await readFile(await file.path(),'utf8');assert.match(text,/# Orbit/);assert.ok(Buffer.byteLength(text)<=65536);
  await page.getByText('Скачать историю за период',{exact:true}).click();
  await page.getByLabel('Конец периода логов').fill(new Date(Date.now()+86400000).toISOString().slice(0,16));
  const zipPromise=page.waitForEvent('download');await page.getByRole('button',{name:'Скачать историю (.zip)'}).click();const zip=await zipPromise;assert.match(zip.suggestedFilename(),/history.zip$/);assert.equal((await readFile(await zip.path())).subarray(0,2).toString(),'PK');
  await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
  assert.deepEqual(errors,[]);
  if(process.env.ORBIT_REPORT_DIR){await mkdir(process.env.ORBIT_REPORT_DIR,{recursive:true});await page.screenshot({path:join(process.env.ORBIT_REPORT_DIR,'journal-mobile.png'),fullPage:true});}
 }catch(e){e.message+='\n'+output.slice(-1500);throw e;}
 finally{await browser?.close();if(server&&server.exitCode===null){server.kill('SIGTERM');await new Promise(r=>server.once('exit',r));}await f.cleanup();await rm(logs,{recursive:true,force:true});}
});
