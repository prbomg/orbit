import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { authHeaders } from './helpers/auth.mjs';

test('resource views keep mobile actions visible and preserve task, rotation and import requests', { timeout: 90000 }, async () => {
  const base = process.env.API_TEST_BASE_URL;
  assert.ok(base && ['localhost', '127.0.0.1'].includes(new URL(base).hostname));
  const token = (await authHeaders()).Cookie.split('=')[1];
  const project = { id: 'ui-project', name: 'Проект проверки', targetUrl: 'https://example.test/', scheduleTimezone: 'Europe/Moscow' };
  let tasks = [{ id: 'ui-task', projectId: project.id, project, taskType: 'target', searchEngine: 'yandex', searchQueries: ['Проверка интерфейса'], vitalPhrases: [], targetKeywords: [], url: '', targetExecutions: 20, currentExecutions: 7, concurrency: 2, status: 'paused', profile: null, profileId: null, visitSettings: { minSeconds: 60, maxSeconds: 120, maxInternalTransitions: 2 }, createdAt: new Date().toISOString() }];
  let proxies = [{ id: 'ui-proxy', host: '192.0.2.10', port: 8080, username: 'fixture-user', isActive: true, rotationUrl: 'https://provider.test/old', tcpChannel: null }];
  const updatedRotation = "https://provider.test/updated?key=" + "synthetic".repeat(20);
  const writes = [], errors = [];
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.addCookies([{ name: 'orbit_session', value: token, url: base }]);
    await context.route('**/api/**', async route => {
      const req = route.request(), path = new URL(req.url()).pathname;
      let body = [];
      if (req.method() !== 'GET') writes.push({ path, method: req.method(), data: req.postDataJSON() });
      if (path === '/api/tasks/') body = tasks;
      else if (path === '/api/tasks/ui-task/') { Object.assign(tasks[0], req.postDataJSON()); body = tasks[0]; }
      else if (path === '/api/proxies/') {
        if (req.method() === 'POST') { const data=req.postDataJSON().proxies; const added=data.map((p,i)=>({...p,id:'import-'+i})); proxies.push(...added); await route.fulfill({json:added}); return; }
        body = proxies;
      } else if (path === '/api/proxies/ui-proxy/') { Object.assign(proxies[0], req.postDataJSON()); body = proxies[0]; }
      else if (path === '/api/system/') body = { workerState: 'stopped', projectRuns: [], projectRun: null, planMode: 'local' };
      await route.fulfill({ json: body });
    });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(base+'/tasks/');
    const observe = page.getByRole('link', { name: 'Наблюдать', exact: true });
    await observe.waitFor();
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      const box = await observe.boundingBox(); assert.ok(box && box.x>=0 && box.x+box.width<=width);
      assert.ok(await page.getByText('На паузе', {exact:true}).last().isVisible());
    }
    await page.setViewportSize({width:390,height:844});
    await page.locator('.task-parameters>summary').click();
    await page.getByText('Запросов: 1 · витальных: 0', {exact:true}).click();
    assert.ok(await page.getByText('Проверка интерфейса', {exact:true}).isVisible());
    await page.getByRole('button', {name:'Продолжить задачу', exact:true}).click();
    await page.getByRole('button', {name:'Приостановить задачу', exact:true}).waitFor();
    assert.ok(writes.some(w=>w.path==='/api/tasks/ui-task/' && w.data.status==='running'));
    await page.goto(base+'/proxies/');
    await page.getByLabel('Ссылка смены IP 192.0.2.10:8080',{exact:true}).waitFor();
    assert.equal(await page.getByLabel('Ссылка смены IP 192.0.2.10:8080',{exact:true}).innerText(),'https://provider.test/old');
    await page.getByRole('button', {name:'Настроить смену IP 192.0.2.10:8080',exact:true}).click();
    const dialog=page.getByRole('dialog');
    const input=dialog.getByLabel('URL ротации 192.0.2.10:8080',{exact:true});
    assert.equal(await input.getAttribute('type'),'text');
    await input.fill(updatedRotation);
    await dialog.getByRole('button',{name:'Сохранить',exact:true}).click(); await dialog.waitFor({state:'hidden'});
    assert.ok(writes.some(w=>w.path==='/api/proxies/ui-proxy/'&&w.data.rotationUrl===updatedRotation));
    assert.equal(await page.getByLabel('Ссылка смены IP 192.0.2.10:8080',{exact:true}).innerText(),updatedRotation);
    await page.getByRole('button',{name:'Настроить смену IP 192.0.2.10:8080',exact:true}).click();
    assert.equal(await input.inputValue(),updatedRotation);
    await input.fill('https://provider.test/unsaved'); await dialog.getByRole('button',{name:'Отмена',exact:true}).click();
    await dialog.waitFor({state:'hidden'});
    await page.getByRole('button',{name:'Настроить смену IP 192.0.2.10:8080',exact:true}).click();
    assert.equal(await input.inputValue(),updatedRotation); await page.keyboard.press('Escape'); await dialog.waitFor({state:'hidden'});
    await page.getByRole('button',{name:'Отключить прокси 192.0.2.10:8080',exact:true}).click();
    await page.getByRole('button',{name:'Включить прокси 192.0.2.10:8080',exact:true}).waitFor();
    await page.getByLabel('Статус прокси',{exact:true}).selectOption('active');
    assert.ok(await page.getByText('Нет прокси по выбранным условиям.').isVisible());
    await page.getByLabel('Статус прокси',{exact:true}).selectOption('');
    await page.setViewportSize({width:320,height:568});
    await page.getByRole('button',{name:'Добавить прокси',exact:true}).click();
    await page.waitForTimeout(250);
    const dialogBox=await dialog.boundingBox(); assert.ok(dialogBox && dialogBox.y>=0 && dialogBox.y+dialogBox.height<=568);
    assert.ok(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth), "Add proxy dialog must fit horizontally");
    assert.equal(await dialog.locator('[name=host],[name=username],[name=password],#batch-rotation-url').count(),0);
    await page.screenshot({path:process.env.PROXY_FORMAT_SCREENSHOT || '/tmp/orbit-proxy-format-mobile.png'});
    await dialog.locator('#proxy-list').fill('invalid');
    await dialog.getByRole('button',{name:'Добавить прокси',exact:true}).click();
    assert.ok(await dialog.getByRole('alert').isVisible());
    assert.equal(writes.filter(w=>w.path==='/api/proxies/'&&w.method==='POST').length,0);
    await dialog.locator('#proxy-list').fill('198.51.100.20:9000:test:password:with:colons\n198.51.100.21:9001:other:second');
    await dialog.getByRole('button',{name:'Добавить прокси',exact:true}).click();
    await dialog.waitFor({state:'hidden'}); assert.ok(await page.getByText('Сохранено прокси: 2.',{exact:true}).isVisible());
    const imported=writes.find(w=>w.path==='/api/proxies/'&&w.method==='POST'); assert.equal(imported.data.proxies[0].port,9000); assert.equal(imported.data.proxies[0].username,"test"); assert.equal(imported.data.proxies[0].password,"password:with:colons"); assert.equal(imported.data.proxies.length,2); assert.ok(imported.data.proxies.every(proxy=>proxy.rotationUrl===null));
    await page.getByLabel('Поиск прокси',{exact:true}).fill('198.51.100.20');
    assert.equal(await page.locator('.proxy-table tbody tr').count(),1);
    await page.getByLabel('Поиск прокси',{exact:true}).fill('');
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({width,height:900});
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      const link=page.getByLabel('Ссылка смены IP 192.0.2.10:8080',{exact:true});
      assert.equal(await link.innerText(),updatedRotation);
      const cell=link.locator('..'); assert.ok(await cell.evaluate(element=>element.scrollWidth<=element.clientWidth));
      if(width===390||width===1440) await page.screenshot({path:'/tmp/orbit-proxy-links-'+width+'.png',fullPage:true});
      const action=page.getByRole('button',{name:'Удалить прокси 198.51.100.20:9000',exact:true});
      const box=await action.boundingBox(); assert.ok(box && box.x>=0 && box.x+box.width<=width, `Proxy actions clipped at ${width}px: ${JSON.stringify(box)}`);
    }
    assert.deepEqual(errors,[]);
  } finally { await browser.close(); }
});
