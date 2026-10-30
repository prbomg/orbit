import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { poolFixture } from './helpers/pool-fixture.mjs';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('attempt picker cleanup preserves records, statistics and direct links; new and active attempts remain visible', {timeout:120000}, async()=>{
 const f=await poolFixture();let server,browser,output='';
 try{
  const task=await f.db.task.create({data:{projectId:f.project.id,status:'paused',currentExecutions:7,targetExecutions:99}});
  const oldDate=new Date(Date.now()-3600000),ids=Array.from({length:66},(_,i)=>'picker-'+randomBytes(10).toString('hex'));
  await f.db.profile.createMany({data:ids.map((id,i)=>({id,name:i<35?'Old profile '+i:'New profile '+i}))});
  await f.db.taskExecution.createMany({data:ids.slice(0,35).map((profileId,i)=>({id:'execution-'+profileId,taskId:task.id,profileId,status:'failed',startedAt:oldDate,errorCode:'fixture'}))});
  const before=await f.db.taskExecution.findMany({where:{taskId:task.id},orderBy:{id:'asc'}});
  const user=await f.db.authUser.create({data:{email:'attempt-list@example.test',passwordHash:'disabled-fixture'}}),token=randomBytes(32).toString('hex');
  await f.db.authSession.create({data:{userId:user.id,tokenHash:createHash('sha256').update(token).digest('hex'),expiresAt:new Date(Date.now()+300000)}});
  const socket=createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
  const origin=`http://127.0.0.1:${port}`,root=resolve(import.meta.dirname,'..'),runtime=join(f.dir,'runtime');await mkdir(runtime);
  server=spawn(process.execPath,[join(root,'node_modules/next/dist/bin/next'),'start','--hostname','127.0.0.1','--port',String(port)],{cwd:root,env:{...process.env,DATABASE_URL:`file:${f.dir}/test.db`,APP_ORIGIN:origin,AUTH_EMAIL:user.email,ORBIT_LIVE_RUNTIME_DIRECTORY:runtime},stdio:['ignore','pipe','pipe']});
  server.stdout.on('data',b=>output+=b);server.stderr.on('data',b=>output+=b);
  for(let n=0;;n++){try{if((await fetch(origin+'/login/')).ok)break;}catch{}if(n>150)throw Error('Fixture startup failed');await wait(100);}
  const endpoint=`${origin}/api/tasks/${task.id}/live/`;assert.equal((await fetch(endpoint)).status,401);
  browser=await chromium.launch({headless:true,executablePath:process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH||chromium.executablePath()});
  const ctx=await browser.newContext({viewport:{width:1440,height:1000}});await ctx.addCookies([{name:'orbit_session',value:token,url:origin}]);
  const get=async(suffix='')=>{const r=await ctx.request.get(endpoint+suffix);assert.equal(r.status(),200);return r.json();};
  const legacy=await get();assert.equal(legacy.executionTotal,35);assert.equal(legacy.executions.length,30);assert.ok(legacy.executionCursor);
  const page=await ctx.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(`${origin}/tasks/${task.id}/live/`);
  const picker=page.getByLabel('Попытка выполнения',{exact:true});await page.waitForFunction(()=>document.querySelector('select[aria-label="Попытка выполнения"]')?.options.length>1);
  // Exercise an already-loaded and paginated list before changing visibility.
  await page.getByRole('button',{name:'Более ранние попытки',exact:true}).click();await page.waitForFunction(()=>document.querySelector('select[aria-label="Попытка выполнения"]')?.options.length===36);
  const cutoff=new Date(),config=join(runtime,'task-attempt-list.json');await writeFile(config,JSON.stringify({version:1,visibleSince:cutoff.toISOString()}));
  await page.waitForFunction(()=>{const p=document.querySelector('select[aria-label="Попытка выполнения"]');return p?.disabled&&p.options.length===1&&p.textContent.includes('Новых попыток пока нет');});
  const empty=await get();assert.equal(empty.executionTotal,0);assert.deepEqual(empty.executions,[]);assert.equal(empty.executionCursor,null);assert.equal(empty.selectedExecutionId,null);assert.deepEqual(empty.events,[]);assert.equal(empty.imageVersion,null);
  assert.equal((await ctx.request.get(endpoint+'?executionCursor='+legacy.executionCursor)).status(),404);
  assert.equal((await get('?executionId='+before[0].id)).selectedExecutionId,before[0].id);
  assert.deepEqual(await f.db.taskExecution.findMany({where:{taskId:task.id},orderBy:{id:'asc'}}),before);
  assert.equal((await f.db.task.findUnique({where:{id:task.id}})).currentExecutions,7);
  await f.db.taskExecution.createMany({data:ids.slice(35).map(profileId=>({id:'execution-'+profileId,taskId:task.id,profileId,status:'completed',startedAt:new Date(cutoff.getTime()+1000)}))});
  await f.db.taskExecution.update({where:{id:before[0].id},data:{status:'running'}});
  const current=await get();assert.equal(current.executionTotal,32);assert.equal(current.executions.length,30);assert.ok(current.executionCursor);
  const next=await get('?executionCursor='+current.executionCursor);assert.equal(next.executions.length,2);assert.equal(next.executionCursor,null);
  assert.equal(new Set([...current.executions,...next.executions].map(e=>e.id)).size,32);
  assert.equal(current.selectedExecutionId,before[0].id);
  await page.waitForFunction(()=>document.querySelector('select[aria-label="Попытка выполнения"]')?.options.length>1);
  await page.setViewportSize({width:390,height:844});assert.equal(await picker.isEnabled(),true);assert.deepEqual(errors,[]);
  await rm(config);assert.equal((await get()).executionTotal,66);
 }catch(e){e.message+='\n'+output.slice(-2000);throw e;}
 finally{await browser?.close();if(server&&server.exitCode===null){server.kill('SIGTERM');await new Promise(resolve=>server.once('exit',resolve));}await f.cleanup();}
});
