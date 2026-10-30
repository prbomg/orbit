import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {createHash,randomBytes} from 'node:crypto';
import {resolve} from 'node:path';
import {chromium} from 'playwright';
import {poolFixture} from './helpers/pool-fixture.mjs';
import policy from '../utils/visitSettings.js';
const settings={minSeconds:60,maxSeconds:120,maxInternalTransitions:2,allowedSections:[]};
test('metrics flags survive normalization and reject non-boolean values',()=>{
 for(const flags of [{},{trackMetrics:true,disableMetrics:false},{trackMetrics:false,disableMetrics:true},{trackMetrics:false},{disableMetrics:true}])assert.deepEqual(policy.visitSettings({...settings,...flags}),{...settings,...flags});
 for(const flags of [{trackMetrics:'false'},{disableMetrics:1}])assert.throws(()=>policy.visitSettings({...settings,...flags}));
});
test('metrics checkbox persists both flags through create/edit and reflects legacy settings in the list',{timeout:120000},async()=>{
 const f=await poolFixture({wal:true});let server,browser,output='';
 try{
 const legacy=await f.db.task.create({data:{projectId:f.project.id,name:'Legacy metrics',url:'https://example.test/',status:'paused'}});
 const user=await f.db.authUser.create({data:{email:'metrics@example.test',passwordHash:'disabled'}}),token=randomBytes(32).toString('hex');await f.db.authSession.create({data:{userId:user.id,tokenHash:createHash('sha256').update(token).digest('hex'),expiresAt:new Date(Date.now()+300000)}});
 const socket=createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));const origin=`http://127.0.0.1:${port}`;
 server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port',String(port)],{cwd:resolve('.'),env:{...process.env,DATABASE_URL:`file:${f.dir}/test.db`,APP_ORIGIN:origin,AUTH_EMAIL:user.email},stdio:['ignore','pipe','pipe']});server.stdout.on('data',b=>output+=b);server.stderr.on('data',b=>output+=b);
 for(let i=0;;i++){try{if((await fetch(origin+'/login/')).ok)break;}catch{}if(i>150)throw Error('Fixture startup failed');await new Promise(r=>setTimeout(r,100));}
 browser=await chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:1440,height:1100}});await context.addCookies([{name:'orbit_session',value:token,url:origin}]);const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(origin+'/tasks/');
 const legacyRow=page.locator(`[data-task-id="${legacy.id}"]`);await legacyRow.locator('summary').first().click();await legacyRow.getByText('Метрика: учитывается',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Создать задачу',exact:true}).click();const dialog=page.getByRole('dialog'),checkbox=dialog.locator('[name="trackMetrics"]');assert.equal(await checkbox.isChecked(),false);assert.equal(await dialog.locator('[name="mode"][value="search"]').isChecked(),true);
 await dialog.getByLabel('Проект новой задачи').selectOption(f.project.id);await dialog.getByLabel('Название задачи',{exact:true}).fill('Metrics fixture');await dialog.locator('[name="status"]').selectOption('paused');await dialog.getByLabel('Поисковые фразы',{exact:true}).fill('test query');
 await dialog.getByRole('button',{name:'Создать задачу',exact:true}).click();await dialog.waitFor({state:'hidden'});
 const saved=await f.db.task.findFirstOrThrow({where:{name:'Metrics fixture'}});assert.equal(saved.visitSettings.trackMetrics,false);assert.equal(saved.visitSettings.disableMetrics,true);
 const row=page.locator(`[data-task-id="${saved.id}"]`);await row.locator('summary').first().click();await row.getByText('Метрика: отключена (блокируется)',{exact:true}).waitFor();
 await row.getByRole('button',{name:'Редактировать Metrics fixture',exact:true}).click();assert.equal(await checkbox.isChecked(),false);await checkbox.check();await dialog.getByRole('button',{name:'Сохранить изменения'}).click();await dialog.waitFor({state:'hidden'});
 const enabled=await f.db.task.findUniqueOrThrow({where:{id:saved.id}});assert.equal(enabled.visitSettings.trackMetrics,true);assert.equal(enabled.visitSettings.disableMetrics,false);await row.getByText('Метрика: учитывается',{exact:true}).waitFor();
 for(const flags of [{trackMetrics:false},{disableMetrics:true}]){
  await f.db.task.update({where:{id:saved.id},data:{visitSettings:{...settings,...flags}}});await page.reload();await row.getByRole('button',{name:'Редактировать Metrics fixture',exact:true}).click();assert.equal(await checkbox.isChecked(),false);await dialog.getByRole('button',{name:'Отмена',exact:true}).click();
 }
 await page.setViewportSize({width:390,height:844});await row.getByRole('button',{name:'Редактировать Metrics fixture',exact:true}).click();await checkbox.scrollIntoViewIfNeeded();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);
 }catch(e){e.message+='\nFixture: '+output.slice(-1500);throw e;}finally{await browser?.close();if(server&&server.exitCode===null){server.kill('SIGTERM');await new Promise(r=>server.once('exit',r));}await f.cleanup();}
});
