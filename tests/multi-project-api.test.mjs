import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, symlink, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chromium } from 'playwright';
import { poolFixture } from './helpers/pool-fixture.mjs';
import runtime from '../utils/workerRuntime.js';

const root=resolve(import.meta.dirname,'..');
async function until(check,timeout=20000){
 const deadline=Date.now()+timeout;
 while(Date.now()<deadline){const value=await check();if(value)return value;await new Promise(r=>setTimeout(r,100));}
 throw new Error('Timed out waiting for fixture state');
}
test('two real managed projects run together, isolate live events and stop/restart independently', {timeout:90000},async()=>{
 const f=await poolFixture();let server,browser,base,headers,output='';const projects=[];
 const paths=id=>runtime.projectPaths(join(f.dir,'.orbit-runtime'),id);
 const call=async(path,body)=>{
  const response=await fetch(base+path,{headers:{...headers,Origin:base,'Content-Type':'application/json'},...(body?{method:'POST',body:JSON.stringify(body)}:{})});
  return {status:response.status,data:await response.json()};
 };
 const status=async id=>(await call(`/api/projects/${id}/run/`)).data;
 try{
  for(const name of ['worker','utils'])await cp(join(root,name),join(f.dir,name),{recursive:true});
  for(const name of ['node_modules','.next'])await symlink(join(root,name),join(f.dir,name),'dir');
  for(const name of ['package.json','next.config.ts'])await cp(join(root,name),join(f.dir,name));
  const portServer=createServer();await new Promise(r=>portServer.listen(0,'127.0.0.1',r));const port=portServer.address().port;await new Promise(r=>portServer.close(r));base=`http://127.0.0.1:${port}`;
  const user=await f.db.authUser.create({data:{email:'fixture@example.test',passwordHash:'disabled'}});
  const token=randomBytes(32).toString('hex');headers={Cookie:`orbit_session=${token}`};
  await f.db.authSession.create({data:{userId:user.id,tokenHash:createHash('sha256').update(token).digest('hex'),expiresAt:new Date(Date.now()+3600000)}});
  const second=await f.db.project.create({data:{name:'Second',targetUrl:'https://example.test/',yandexRegionId:'213',regionName:''}});
  projects.push(f.project.id,second.id);const tasks=await Promise.all(projects.map(id=>f.task(id,3)));
  await f.db.task.updateMany({data:{concurrency:2}});
  server=spawn(process.execPath,[join(root,'node_modules/next/dist/bin/next'),'start','--hostname','127.0.0.1','--port',String(port)],{cwd:f.dir,env:{...process.env,DATABASE_URL:`file:${f.dir}/test.db`,AUTH_EMAIL:'fixture@example.test',APP_ORIGIN:base,WORKER_PROFILES_DIR:join(f.dir,'profiles'),WORKER_PLAN_MODE:'local',WORKER_POLL_MS:'1000',ORBIT_WORKER_RUN_ID:''},stdio:['ignore','pipe','pipe']});
  server.stdout.on('data',b=>{output+=b;});server.stderr.on('data',b=>{output+=b;});
  await until(async()=>{try{return (await fetch(base+'/login/')).status===200;}catch{return false;}});
  const starts=await Promise.all(projects.map(id=>call(`/api/projects/${id}/run/`,{action:'start'})));
  assert.deepEqual(starts.map(r=>r.status),[200,200]);
  await until(async()=>{const rows=await Promise.all(projects.map(status));return rows.every(r=>r.state==='waiting');});
  const records=await Promise.all(projects.map(async id=>JSON.parse(await readFile(paths(id).record,'utf8'))));
  assert.notEqual(records[0].pid,records[1].pid);assert.notEqual(records[0].runId,records[1].runId);
  assert.equal((await call(`/api/projects/${projects[0]}/run/`,{action:'start'})).status,409);
  const system=(await call('/api/system/')).data;assert.equal(system.activeProjectCount,2);assert.equal(system.projectRuns.filter(r=>['running','waiting'].includes(r.state)).length,2);
  for(let i=0;i<2;i++){
   const dir=join(f.dir,'.orbit-runtime','live',records[i].runId);await mkdir(dir,{recursive:true});
   await writeFile(join(dir,tasks[i].id+'.jsonl'),JSON.stringify({time:new Date().toISOString(),event:i?'fixture_b':'fixture_a'})+'\n');
   const live=(await call(`/api/tasks/${tasks[i].id}/live/`)).data;
   assert.deepEqual(live.events.map(e=>e.event),[i?'fixture_b':'fixture_a']);assert.equal(live.run.state,'waiting');
  }
  browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
  const context=await browser.newContext();await context.addCookies([{name:'orbit_session',value:token,url:base}]);
  const errors=[];
  for(const id of projects){const page=await context.newPage();page.on('pageerror',e=>errors.push(e.name));await page.goto(`${base}/projects/${id}/`);await page.getByRole('button',{name:'Остановить',exact:true}).waitFor();assert.doesNotMatch(await page.locator('body').innerText(),/Исполнитель занят другим проектом|Ожидает запуска/);}
  assert.deepEqual(errors,[]);
  assert.equal((await call(`/api/projects/${projects[0]}/run/`,{action:'stop'})).status,200);
  await until(async()=>['stopped','completed'].includes((await status(projects[0])).state));
  assert.equal((await status(projects[1])).state,'waiting');assert.equal((await call('/api/system/')).data.activeProjectCount,1);
  assert.equal(JSON.parse(await readFile(paths(projects[1]).record,'utf8')).pid,records[1].pid);
  const duplicate=await Promise.all([1,2].map(()=>call(`/api/projects/${projects[0]}/run/`,{action:'start'})));
  assert.deepEqual(duplicate.map(r=>r.status).sort(),[200,409]);
  await until(async()=>(await status(projects[0])).state==='waiting');
  const restarted=JSON.parse(await readFile(paths(projects[0]).record,'utf8'));assert.notEqual(restarted.runId,records[0].runId);
  process.kill(restarted.pid,'SIGKILL');await until(async()=>(await status(projects[0])).state==='failed');
  assert.equal((await call(`/api/projects/${projects[0]}/run/`,{action:'start'})).status,200);
  await until(async()=>(await status(projects[0])).state==='waiting');
  assert.equal((await status(projects[1])).state,'waiting');
 }catch(error){error.message+='\nFixture server output:\n'+output.slice(-2500);for(const id of projects)try{error.message+='\nFixture worker output:\n'+(await readFile(paths(id).log,'utf8')).slice(-2500);}catch{}throw error;}
 finally{
  await browser?.close();
  for(const id of projects){
   if(base)await call(`/api/projects/${id}/run/`,{action:'stop'}).catch(()=>{});
   try{const r=JSON.parse(await readFile(paths(id).record,'utf8'));try{process.kill(r.pid,'SIGTERM');}catch{}await until(async()=>{try{process.kill(r.pid,0);return false;}catch{return true;}},10000);}catch{}
  }
  if(server&&server.exitCode===null){server.kill('SIGTERM');await new Promise(r=>server.once('exit',r));}
  await f.cleanup();
 }
});
