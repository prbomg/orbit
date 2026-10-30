import test from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { chromium } from 'playwright';
import { authHeaders } from './helpers/auth.mjs';

test('live task page shows only task visits, supports periods and refreshes automatically', {timeout:60000}, async()=>{
 const base=process.env.API_TEST_BASE_URL;
 assert.ok(base&&new URL(base).hostname==='127.0.0.1');
 const headers=await authHeaders(),db=new PrismaClient();let browser,project;
 try{
  project=await db.project.create({data:{name:'Task visits fixture',targetUrl:'https://example.test/',yandexRegionId:'213',regionName:''}});
  const task=await db.task.create({data:{projectId:project.id,url:'https://example.test/',searchEngine:'yandex',searchQueries:['мой запрос','пока пусто']}});
  const other=await db.task.create({data:{projectId:project.id,url:'https://example.test/',searchEngine:'yandex',searchQueries:['чужой запрос']}});
  const visit={projectId:project.id,taskId:task.id,kind:'search',query:'мой запрос',actualQuery:'мой запрос бренд',engine:'yandex',source:'observed',visitedAt:new Date('2026-01-01T12:00:00Z')};
  await db.projectVisit.create({data:visit});
  await db.projectVisit.create({data:{...visit,taskId:other.id,query:'чужой запрос'}});
  const endpoint=`${base}/api/tasks/${task.id}/visits/`;
  assert.equal((await fetch(endpoint)).status,401);
  assert.equal((await fetch(`${base}/api/tasks/missing/visits/`,{headers})).status,404);
  assert.equal((await fetch(`${endpoint}?period=custom&from=bad&to=bad`,{headers})).status,400);
  assert.equal((await(await fetch(`${endpoint}?period=all`,{headers})).json()).total,1);
  browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
  const context=await browser.newContext({viewport:{width:1400,height:1000}});
  await context.addCookies([{name:'orbit_session',value:headers.Cookie.split('=')[1],url:base}]);
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`${base}/tasks/${task.id}/live/`);
  const stats=page.getByRole('region',{name:'Переходы по запросам'});
  await stats.getByRole('cell',{name:'пока пусто',exact:true}).waitFor();
  assert.equal(await stats.getByRole('button',{name:'Всё время',exact:true}).getAttribute('aria-pressed'),'true');
  assert.equal(await stats.getByText('чужой запрос',{exact:true}).count(),0);
  await stats.getByText('Уточнённые запросы (1)',{exact:true}).click();
  await stats.getByText('мой запрос бренд',{exact:true}).waitFor();
  // Polling must pick up a newly recorded visit without reloading the page.
  await db.projectVisit.create({data:visit});
  await page.waitForFunction(()=>[...document.querySelectorAll('section[aria-label="Переходы по запросам"] tbody tr')].some(r=>r.textContent.includes('мой запрос')&&r.children[1].textContent==='2'),{},{timeout:22000});
  const response=page.waitForResponse(r=>r.url().includes('/visits/?period=custom'));
  await stats.getByRole('button',{name:'Свои даты',exact:true}).click();await response;
  await stats.getByLabel('С даты',{exact:true}).fill('2026-01-01');
  await stats.getByLabel('По дату включительно',{exact:true}).fill('2026-01-01');
  const custom=page.waitForResponse(r=>r.url().includes('from=2026-01-01'));
  await stats.getByRole('button',{name:'Применить',exact:true}).click();assert.equal((await custom).status(),200);
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.deepEqual(errors,[]);
 }finally{
  await browser?.close();
  if(project){
   await db.projectVisit.deleteMany({where:{projectId:project.id}});
   await db.task.deleteMany({where:{projectId:project.id}});
   await db.project.delete({where:{id:project.id}});
  }
  await db.$disconnect();
 }
});
