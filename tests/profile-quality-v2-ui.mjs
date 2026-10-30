import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { poolFixture } from './helpers/pool-fixture.mjs';
import journal from '../utils/warmupJournal.js';
const f=await poolFixture();let server,browser;
try{
 const profile=await f.db.profile.create({data:{name:'Проверка качества',sessionCheck:{status:'passed',checkedAt:new Date().toISOString(),storageCoverage:{version:1,cookies:'verified',localStorage:'verified',indexedDB:'verified',httpCache:'disabled_by_routing',serviceWorkers:'blocked',sessionStorage:'not_saved'}}}});
 const ctx={profileId:profile.id,runId:'quality-fixture',stage:1,attempt:1};
 const events=[['warmup_run_context',{release:'test-release',model:'s23_android14',storageMode:'snapshot',preset:'standard'}],['warmup_site_partial',{domain:'fixture.test',quality:'partial',reason:'interaction_not_confirmed',confirmedScrollPixels:0,confirmedLinks:0}],['warmup_storage_check',{result:'passed'}],['session_saved',{preparationMs:5000}],['warmup_run_finished',{outcome:'passed',durationMs:1000}]];
 await f.db.profileWarmupEvent.createMany({data:events.map(([event,d])=>journal.journalEntry(ctx,event,d))});
 const user=await f.db.authUser.create({data:{email:'seo@uniofweb.ru',passwordHash:'fixture'}}),token=randomBytes(32).toString('hex');
 await f.db.authSession.create({data:{userId:user.id,tokenHash:createHash('sha256').update(token).digest('hex'),expiresAt:new Date(Date.now()+300000)}});
 const base='http://127.0.0.1:3103';
 server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port','3103'],{env:{...process.env,DATABASE_URL:`file:${f.dir}/test.db`,APP_ORIGIN:base,AUTH_EMAIL:user.email},stdio:['ignore','pipe','pipe']});
 let output='';server.stdout.on('data',d=>output+=d);server.stderr.on('data',d=>output+=d);
 for(let i=0;i<100;i++){try{if((await fetch(base+'/login/',{signal:AbortSignal.timeout(1000)})).ok)break;}catch{}if(i===99)throw Error(output);await new Promise(r=>setTimeout(r,250));}
 const unauthorized=await fetch(base+'/api/profiles/statistics/',{redirect:'manual'});assert.notEqual(unauthorized.status,200);
 browser=await chromium.launch({headless:true,executablePath:process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH});
 for(const width of [1280,390]){
  const context=await browser.newContext({viewport:{width,height:900},...(width===390?{isMobile:true,hasTouch:true}:{})});await context.addCookies([{name:'orbit_session',value:token,url:base}]);
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/profiles/?section=statistics');const region=page.getByRole('region',{name:'Эффективность подготовки'});
  await region.getByText('test-release',{exact:true}).waitFor();await region.getByLabel('Группировка статистики').selectOption('model');await region.getByText('s23_android14',{exact:true}).waitFor();
  const response=await context.request.get(base+'/api/profiles/statistics/?days=7');assert.equal(response.status(),200);const stats=await response.json();assert.equal(stats.summary.passed,1);assert.equal(stats.summary.restoreRate,100);assert.equal(stats.domains[0].partial,1);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.goto(base+`/profiles/?profile=${profile.id}`);const dialog=page.getByRole('dialog');await dialog.getByText('HTTP-кэш страниц: отключён перехватом запросов.',{exact:true}).waitFor();
  for(const [mode,label] of [['blocked','в последней проверке были заблокированы.'],['not_saved','разрешены; регистрации и CacheStorage не входят в JSON-снимок.'],['allowed_unverified','разрешены; восстановление регистраций и CacheStorage не проверялось.']]){
   await f.db.profile.update({where:{id:profile.id},data:{sessionCheck:{...profile.sessionCheck,storageCoverage:{...profile.sessionCheck.storageCoverage,serviceWorkers:mode}}}});
   await page.goto(base+`/profiles/?profile=${profile.id}`);await dialog.getByText('Service Workers: '+label,{exact:true}).waitFor();
  }
  await dialog.getByRole('button',{name:'Журнал',exact:true}).click();const history=page.getByRole('region',{name:'Журнал прогрева'});await history.locator('summary').first().click();await history.getByText('Требования выполнены частично',{exact:false}).waitFor();
  await page.goto(base+'/profiles/?section=settings');const select=page.getByLabel('Цель подготовки новых профилей');await select.waitFor();await select.selectOption('storage');
  const form=select.locator('xpath=ancestor::form');await form.getByRole('button',{name:'Сохранить',exact:false}).click();await page.getByText('Настройки сохранены.',{exact:false}).waitFor();
  const settings=await (await context.request.get(base+'/api/settings/')).json();assert.equal(settings.warmupPlanPreset,'storage');
  // Return the fixture to the default for the second viewport.
  const reset=await context.request.patch(base+'/api/settings/',{data:{warmupPlanPreset:'standard',expectedUpdatedAt:settings.updatedAt},headers:{Origin:base}});assert.equal(reset.status(),200);
  assert.deepEqual(errors,[]);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  console.log(`Quality UI ${width}px: statistics, storage coverage, journal, plan settings, authenticated API, no overflow/errors`);await context.close();
 }
}finally{await browser?.close();if(server){const stopped=new Promise(resolve=>server.once('exit',resolve));server.kill('SIGTERM');await stopped;}await f.cleanup();}
