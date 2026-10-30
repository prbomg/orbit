import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { poolFixture } from './helpers/pool-fixture.mjs';
import fp from '../utils/fingerprint.js';
const f=await poolFixture();let server,browser;
try {
 await f.db.settings.update({where:{id:1},data:{warmupEnabled:false,warmupPlanPreset:'storage',fingerprintMode:'local'}});
 const profiles=[];
 for(const status of ['queued','waiting_stage']){
  const p=await f.db.profile.create({data:{name:`Тест ${status}`,status:'queued',fingerprint:fp.localPassport({fingerprintMode:'local'})}});profiles.push(p);
  await f.db.warmupJob.create({data:{profileId:p.id,status,totalStages:1}});
 }
 const old=await f.db.profile.create({data:{name:'Удалённый профиль',deletedAt:new Date()}});
 await f.db.profileWarmupEvent.createMany({data:[{profileId:profiles[0].id,runId:'active',event:'warmup_run_finished',details:{outcome:'passed'}},{profileId:old.id,runId:'old',event:'warmup_run_finished',details:{outcome:'failed'}}]});
 const token=randomBytes(32).toString('hex');const user=await f.db.authUser.create({data:{email:'seo@uniofweb.ru',passwordHash:'fixture'}});
 await f.db.authSession.create({data:{userId:user.id,tokenHash:createHash('sha256').update(token).digest('hex'),expiresAt:new Date(Date.now()+300000)}});
 const origin='http://127.0.0.1:3103';
 server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port','3103'],{env:{...process.env,DATABASE_URL:`file:${f.dir}/test.db`,APP_ORIGIN:origin,AUTH_EMAIL:'seo@uniofweb.ru',WORKER_PROFILES_DIR:f.dir+'/profiles'},stdio:['ignore','pipe','pipe']});
 let log='';server.stdout.on('data',d=>log+=d);server.stderr.on('data',d=>log+=d);
 for(let i=0;i<80;i++){try{if((await fetch(origin+'/login/')).ok)break;}catch{}if(i===79)throw Error(log);await new Promise(r=>setTimeout(r,250));}
 browser=await chromium.launch({headless:true,executablePath:process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH||'/usr/bin/google-chrome'});
 const context=await browser.newContext({viewport:{width:1440,height:1000}});await context.addCookies([{name:'orbit_session',value:token,url:origin}]);
 const api=async path=>{const r=await context.request.get(origin+path);assert.equal(r.status(),200);return r.json();};
 const summary=await api('/api/profiles/pool/');assert.equal(summary.total,2);assert.equal(summary.plan.offsetsHours.length,1);assert.equal(summary.plan.minAgeHours,0);
 const stats=await api('/api/profiles/statistics/');assert.equal(stats.summary.runs,1);assert.equal(stats.summary.failed,0);
 const list=await api('/api/profiles/?page=1');assert.equal(list.items.length,2);assert.equal('fingerprint' in list.items[0],false);assert.equal(list.items[0].generationInfo.current,true);
 const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin+'/profiles/',{waitUntil:'networkidle'});await page.getByRole('button',{name:'Всего в пуле 2',exact:true}).waitFor();
 await page.getByRole('button',{name:'В очереди 1',exact:true}).click();await page.getByText('Найдено 1 · страница 1 из 1').waitFor();
 assert.equal(await page.getByRole('combobox',{name:'Статус профиля'}).inputValue(),'queue:queued');
 await mkdir('prepared/profile-pool-ui',{recursive:true});await page.screenshot({path:'prepared/profile-pool-ui/desktop.png',fullPage:true});
 await page.getByRole('button',{name:'Создать профили',exact:true}).click();
 await page.getByRole('dialog').getByText(/План: 1 сессий, минимум 0 ч/).waitFor();
 await page.getByRole('dialog').getByText(/Подготовка на паузе/).waitFor();
 await page.locator('#batch-count').fill('1');await page.getByRole('button',{name:'Создать 1 и поставить на прогрев',exact:true}).click();
 await page.getByText('Создано и поставлено на прогрев: 1',{exact:true}).waitFor();
 await page.getByText('Найдено 3 · страница 1 из 1').waitFor();
 await page.setViewportSize({width:390,height:844});await page.getByRole('textbox',{name:'Поиск профилей'}).fill('нет такого профиля');
 await page.getByText('По этим условиям профилей нет',{exact:true}).waitFor();
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.getByRole('button',{name:'Сбросить фильтры',exact:true}).first().click();await page.getByText('Найдено 3 · страница 1 из 1').waitFor();
 await page.screenshot({path:'prepared/profile-pool-ui/mobile.png',fullPage:true});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 assert.deepEqual(errors,[]);
 console.log('PASS: deleted profiles excluded from stats; exact counters; compact metadata without passport; actual plan; create/reset filters; desktop/mobile with no overflow or JS errors.');
} finally {await browser?.close();if(server){const ended=new Promise(r=>server.once('exit',r));server.kill('SIGTERM');await ended;}await f.cleanup();}
