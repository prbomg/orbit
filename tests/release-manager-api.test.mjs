import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, symlink, mkdir, writeFile, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chromium } from 'playwright';
import { poolFixture } from './helpers/pool-fixture.mjs';
const root=resolve(import.meta.dirname,'..');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
test('settings lists dated versions, protects live releases and deletes only explicitly confirmed selections',{timeout:90000},async()=>{
 const f=await poolFixture();let server,worker,browser,output='';
 try{
  for(const name of ['worker','utils'])await cp(join(root,name),join(f.dir,name),{recursive:true});
  for(const name of ['node_modules','.next'])await symlink(join(root,name),join(f.dir,name),'dir');
  for(const name of ['package.json','next.config.ts'])await cp(join(root,name),join(f.dir,name));
  const catalog=join(f.dir,'releases'),data=join(f.dir,'data'),logs=join(f.dir,'logs');await mkdir(catalog);await mkdir(data);await mkdir(logs);
  await writeFile(join(data,'keep-profile'),'unchanged');
  for(const id of ['20261001-old','20261002-worker','20261003-current']){await mkdir(join(catalog,id));await writeFile(join(catalog,id,'code'),Buffer.alloc(1000000));}
  await symlink(data,join(catalog,'20261001-old','data'));await symlink(join(catalog,'20261003-current'),join(f.dir,'current'));
  worker=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{cwd:join(catalog,'20261002-worker'),stdio:'ignore'});
  const ports=createServer();await new Promise(r=>ports.listen(0,'127.0.0.1',r));const port=ports.address().port;await new Promise(r=>ports.close(r));const base=`http://127.0.0.1:${port}`;
  const user=await f.db.authUser.create({data:{email:'fixture@example.test',passwordHash:'disabled'}}),token=randomBytes(32).toString('hex');
  await f.db.authSession.create({data:{userId:user.id,tokenHash:createHash('sha256').update(token).digest('hex'),expiresAt:new Date(Date.now()+3600000)}});
  server=spawn(process.execPath,[join(root,'node_modules/next/dist/bin/next'),'start','--hostname','127.0.0.1','--port',String(port)],{cwd:f.dir,env:{...process.env,DATABASE_URL:`file:${f.dir}/test.db`,AUTH_EMAIL:'fixture@example.test',APP_ORIGIN:base,ORBIT_SERVICE_DIRECTORY:f.dir,ORBIT_DATA_DIRECTORY:data,ORBIT_LOG_DIRECTORY:logs},stdio:['ignore','pipe','pipe']});
  server.stdout.on('data',b=>{output+=b;});server.stderr.on('data',b=>{output+=b;});
  const deadline=Date.now()+20000;while(true){try{if((await fetch(base+'/login/')).status===200)break;}catch{}if(Date.now()>deadline)throw new Error('Fixture server did not start');await wait(100);}
  const endpoint=base+'/api/system/releases/',headers={Cookie:`orbit_session=${token}`,'Content-Type':'application/json',Origin:base};
  assert.equal((await fetch(endpoint)).status,401);
  const listing=await(await fetch(endpoint,{headers})).json();assert.equal(listing.releases.length,3);
  const old=listing.releases.find(r=>r.id==='20261001-old'),current=listing.releases.find(r=>r.id==='20261003-current');
  const body=rows=>JSON.stringify({releases:rows.map(({id,revision})=>({id,revision}))});
  assert.equal((await fetch(endpoint,{method:'DELETE',headers:{'Content-Type':'application/json'},body:body([old])})).status,401);
  assert.equal((await fetch(endpoint,{method:'DELETE',headers:{...headers,Origin:'https://other.test'},body:body([old])})).status,403);
  assert.equal((await fetch(endpoint,{method:'DELETE',headers,body:body([old,current])})).status,409);await access(join(catalog,old.id));
  assert.equal((await fetch(endpoint,{method:'DELETE',headers,body:body([{id:'../data',revision:old.revision}])})).status,400);
  const readStorage=async previous=>{let value;const deadline=Date.now()+15000;do{value=await(await fetch(base+'/api/system/resources/',{headers})).json();if(value.disk.scanState==='idle'&&value.disk.complete&&(!previous||value.disk.measuredAt!==previous))return value;await new Promise(r=>setTimeout(r,100));}while(Date.now()<deadline);throw new Error('Storage scan did not finish');};
  const before=await readStorage();
  browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
  const context=await browser.newContext();await context.addCookies([{name:'orbit_session',value:token,url:base}]);
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.name));await page.goto(base+'/settings/');
  await page.locator('#settings-tab-maintenance').click();
  const panel=page.getByRole('region',{name:'Сохранённые релизы'});await panel.getByText(old.id,{exact:true}).waitFor();
  assert.equal(await panel.getByRole('checkbox',{name:'Выбрать 20261003-current',exact:true}).isDisabled(),true);
  assert.equal(await panel.getByRole('checkbox',{name:'Выбрать 20261002-worker',exact:true}).isDisabled(),true);
  assert.ok(await panel.getByText(/Сохранён:/).count());
  await panel.getByRole('checkbox',{name:'Выбрать 20261001-old',exact:true}).check();await panel.getByRole('button',{name:'Удалить выбранные (1)',exact:true}).click();
  await page.getByRole('dialog').getByRole('button',{name:'Отмена',exact:true}).click();await access(join(catalog,old.id));
  await panel.getByRole('button',{name:'Удалить выбранные (1)',exact:true}).click();
  const deletion=page.waitForResponse(r=>r.url().endsWith('/api/system/releases/')&&r.request().method()==='DELETE');
  await page.getByRole('dialog').getByRole('button',{name:'Подтвердить удаление',exact:true}).click();assert.equal((await deletion).status(),202);
  await panel.getByText('Удаление завершено: 1 из 1',{exact:true}).waitFor();
  await assert.rejects(access(join(catalog,old.id)),{code:'ENOENT'});await access(join(catalog,'20261002-worker'));await access(join(catalog,'20261003-current'));await access(join(data,'keep-profile'));
  const after=await readStorage(before.disk.measuredAt);assert.ok(after.disk.bytes<before.disk.bytes);
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);
  assert.equal((await(await fetch(endpoint,{headers})).json()).releases.length,2);
 }catch(error){error.message+='\nFixture output:\n'+output.slice(-2000);throw error;}
 finally{await browser?.close();if(worker&&worker.exitCode===null){worker.kill('SIGTERM');await new Promise(r=>worker.once('exit',r));}if(server&&server.exitCode===null){server.kill('SIGTERM');await new Promise(r=>server.once('exit',r));}await f.cleanup();}
});
