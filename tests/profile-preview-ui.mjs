import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { poolFixture } from './helpers/pool-fixture.mjs';
const f=await poolFixture();let server,browser;
try{
 const user=await f.db.authUser.create({data:{email:'seo@uniofweb.ru',passwordHash:'fixture'}}),token=randomBytes(32).toString('hex');
 await f.db.authSession.create({data:{userId:user.id,tokenHash:createHash('sha256').update(token).digest('hex'),expiresAt:new Date(Date.now()+300000)}});
 const base='http://127.0.0.1:3104';
 server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port','3104'],{env:{...process.env,DATABASE_URL:`file:${f.dir}/test.db`,APP_ORIGIN:base,AUTH_EMAIL:user.email},stdio:['ignore','pipe','pipe']});
 let output='';server.stdout.on('data',d=>output+=d);server.stderr.on('data',d=>output+=d);
 for(let i=0;i<100;i++){try{if((await fetch(base+'/login/',{signal:AbortSignal.timeout(1000)})).ok)break;}catch{}if(i===99)throw Error(output);await new Promise(r=>setTimeout(r,250));}
 assert.notEqual((await fetch(base+'/api/profiles/preview/',{method:'POST',redirect:'manual'})).status,200);
 const settingsBefore=await f.db.settings.findUnique({where:{id:1}});
 browser=await chromium.launch({headless:true,executablePath:process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH});
 for(const width of [1280,390]){
  const context=await browser.newContext({viewport:{width,height:900},...(width===390?{isMobile:true,hasTouch:true}:{})});await context.addCookies([{name:'orbit_session',value:token,url:base}]);
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/profiles/?section=settings');const region=page.getByRole('region',{name:'Проверка генерации профилей'});
  await region.getByLabel('Размер тестовой партии').fill('20');await region.getByRole('button',{name:'Проверить конфигурацию'}).click();await region.getByText('Проверено: 20 · Успешно: 20').waitFor();
  await page.getByLabel('Локальный язык',{exact:true}).fill('en-US');assert.equal(await region.getByText('Проверено: 20 · Успешно: 20').count(),0);
  await page.getByLabel('Источник',{exact:true}).selectOption('mobileproxy');await region.getByRole('button',{name:'Проверить конфигурацию'}).click();await region.getByText('Локальная выборка не выполнялась.',{exact:false}).waitFor();
  const response=await context.request.post(base+'/api/profiles/preview/',{data:{count:1001}});assert.equal(response.status(),400);
  assert.deepEqual(errors,[]);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  console.log(`Preview UI ${width}px passed: validation, stale preview cleared, provider scope, no overflow`);await context.close();
 }
 assert.deepEqual(await f.db.settings.findUnique({where:{id:1}}),settingsBefore);
 assert.equal(await f.db.profile.count(),0);assert.equal(await f.db.warmupJob.count(),0);
 console.log('Preview: settings, profiles and jobs unchanged');
}finally{await browser?.close();if(server){const stopped=new Promise(resolve=>server.once('exit',resolve));server.kill('SIGTERM');await stopped;}await f.cleanup();}
