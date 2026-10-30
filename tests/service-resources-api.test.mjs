import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, symlink, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chromium } from 'playwright';
import { poolFixture } from './helpers/pool-fixture.mjs';
const root=resolve(import.meta.dirname,'..');

test('resource API is private, caches scans and renders real settings metrics on narrow and wide screens',{timeout:60000},async()=>{
 const f=await poolFixture({wal:true});let server,browser,output='';
 try{
  for(const name of ['worker','utils'])await cp(join(root,name),join(f.dir,name),{recursive:true});
  for(const name of ['node_modules','.next'])await symlink(join(root,name),join(f.dir,name),'dir');
  for(const name of ['package.json','next.config.ts'])await cp(join(root,name),join(f.dir,name));
  const data=join(f.dir,'data'),logs=join(f.dir,'logs');
  for(const name of ['profiles','backups','runtime','browsers','service-backups','maintenance','reports','home'])await mkdir(join(data,name),{recursive:true});await mkdir(logs);
  await mkdir(join(logs,'tasks'));await writeFile(join(logs,'tasks','attempt.txt'),Buffer.alloc(4096));await writeFile(join(data,'profiles','private-profile-key'),Buffer.alloc(8192));await writeFile(join(logs,'orbit.log'),Buffer.alloc(4096));
  const ports=createServer();await new Promise(r=>ports.listen(0,'127.0.0.1',r));const port=ports.address().port;await new Promise(r=>ports.close(r));const base=`http://127.0.0.1:${port}`;
  const user=await f.db.authUser.create({data:{email:'fixture@example.test',passwordHash:'disabled'}});
  const token=randomBytes(32).toString('hex');await f.db.authSession.create({data:{userId:user.id,tokenHash:createHash('sha256').update(token).digest('hex'),expiresAt:new Date(Date.now()+3600000)}});
  server=spawn(process.execPath,[join(root,'node_modules/next/dist/bin/next'),'start','--hostname','127.0.0.1','--port',String(port)],{cwd:f.dir,env:{...process.env,DATABASE_URL:`file:${f.dir}/test.db`,AUTH_EMAIL:'fixture@example.test',APP_ORIGIN:base,ORBIT_SERVICE_DIRECTORY:f.dir,ORBIT_DATA_DIRECTORY:data,ORBIT_LOG_DIRECTORY:logs,WORKER_PROFILES_DIR:join(data,'profiles'),PLAYWRIGHT_BROWSERS_PATH:join(data,'browsers'),FONTCONFIG_FILE:'',ORBIT_SERVICE_BACKUPS_DIRECTORY:join(data,'service-backups')},stdio:['ignore','pipe','pipe']});
  server.stdout.on('data',b=>{output+=b;});server.stderr.on('data',b=>{output+=b;});
  const deadline=Date.now()+20000;
  while(true){try{if((await fetch(base+'/login/')).status===200)break;}catch{}if(Date.now()>deadline)throw new Error('Fixture server did not start');await new Promise(r=>setTimeout(r,100));}
  const endpoint=base+'/api/system/resources/';assert.equal((await fetch(endpoint)).status,401);
  const headers={Cookie:`orbit_session=${token}`};
  const responses=await Promise.all([fetch(endpoint,{headers}),fetch(endpoint+'?path=/etc/',{headers})]);
  assert.ok(responses.every(r=>r.status===200&&r.headers.get('cache-control')==='no-store'));
  await Promise.all(responses.map(r=>r.arrayBuffer()));
  let ready; const scanDeadline=Date.now()+10000;
  do { ready=await(await fetch(endpoint,{headers})).json();if(ready.disk.scanState==='idle'&&ready.disk.complete)break;await new Promise(r=>setTimeout(r,100));}while(Date.now()<scanDeadline);
  assert.equal(ready.disk.complete,true);
  const [a,b]=await Promise.all([fetch(endpoint,{headers}).then(r=>r.json()),fetch(endpoint+'?path=/etc/',{headers}).then(r=>r.json())]);assert.equal(a.disk.measuredAt,b.disk.measuredAt);assert.equal(a.processes.measuredAt,b.processes.measuredAt);
  assert.equal(a.disk.complete,true);assert.ok(a.disk.bytes>0);assert.equal(a.disk.bytes,a.disk.breakdown.reduce((sum,row)=>sum+row.bytes,0));
  assert.ok(a.processes.count>=1);assert.ok(a.processes.memoryBytes>0);assert.ok(a.processes.cpuCores>=0);
  assert.doesNotMatch(JSON.stringify(a),/private-profile-key|\/etc\/|\.socket|passwordHash|tokenHash/);
  browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
  const context=await browser.newContext();await context.addCookies([{name:'orbit_session',value:token,url:base}]);
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.name));
  await page.setViewportSize({width:1400,height:1000});await page.goto(base+'/settings/');
  await page.locator('#settings-tab-monitoring').click();
  const panel=page.getByRole('region',{name:'Ресурсы сервиса'});await panel.getByText('Место на диске по категориям',{exact:true}).waitFor();
  assert.ok(a.disk.breakdown.find(x=>x.key==='taskLogs').bytes>=4096);assert.match(await panel.innerText(),/МиБ|КиБ|ГиБ/);
  for(const label of ['Файлы Orbit','Свободно на диске','Память Orbit','CPU Orbit','Профили и сессии','Логи заданий','Журналы служб','База данных, WAL и SHM','Резервные копии сервиса','Кэши зависимостей и окружения','Диагностика и материалы выкладок'])assert.ok(await panel.getByText(label,{exact:true}).count());
  const refreshed=page.waitForResponse(r=>r.url().endsWith('/api/system/resources/?refresh=1'));await panel.getByRole('button',{name:'Обновить ресурсы'}).click();assert.equal((await refreshed).status(),200);
  // df computes capacity using used + available (excluding reserved blocks).
  const gib=1024**3;
  await page.route('**/api/system/resources/**',route=>route.fulfill({json:{...a,disk:{...a.disk,scanState:'idle',volume:{totalBytes:1000*gib,usedBytes:800*gib,availableBytes:100*gib}}}}));
  await panel.getByRole('button',{name:'Обновить ресурсы'}).click();
  await panel.getByText('Резерв файловой системы: 100 ГиБ',{exact:true}).waitFor();
  assert.equal(await panel.getByRole('progressbar').getAttribute('aria-valuenow'),'89');
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);
 }catch(error){error.message+='\nFixture output:\n'+output.slice(-2000);throw error;}
 finally{await browser?.close();if(server&&server.exitCode===null){server.kill('SIGTERM');await new Promise(r=>server.once('exit',r));}await f.cleanup();}
});
