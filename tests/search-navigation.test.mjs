import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { openSearchHome } from '../worker/search-navigation.mjs';
import { TaskStoppedError } from '../worker/behavior.mjs';

const allowedHost = host => host === 'search.test' || host === 'sso.search.test';
async function fixture(run) {
  const server=createServer();
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const home='http://search.test:'+server.address().port+'/';
  const sso='http://sso.search.test:'+server.address().port+'/push';
  const route = handler => server.on('request',(request,response)=>{
    const value={request:()=>({url:()=>new URL(request.url,'http://'+request.headers.host).href}),fulfill:async({status=200,headers={},contentType,body=''})=>{response.writeHead(status,{...headers,...(contentType?{'Content-Type':contentType}:{})});response.end(body);}};
    Promise.resolve(handler(value)).catch(()=>{response.destroy();});
  });
  const browser = await chromium.launch({ headless: true, args:['--host-resolver-rules=MAP search.test 127.0.0.1, MAP *.search.test 127.0.0.1, MAP outside.test 127.0.0.1','--no-proxy-server'], ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  try { const context = await browser.newContext(); await run(await context.newPage(), context, {home,sso,route,server}); }
  finally { await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve)); }
}

test('home waits for resources after DOMContentLoaded before returning the editable field', async () => {
  await fixture(async (page, context, {home,route}) => {
    let domParsed = false, imageFinished = false;
    await page.exposeFunction('parsed', () => { domParsed = true; });
    route(async route => {
      if (route.request().url().endsWith('/slow.png')) {
        await new Promise(resolve => setTimeout(resolve, 250));
        assert.equal(domParsed, true);
        imageFinished = true;
        return route.fulfill({ status: 204 });
      }
      return route.fulfill({ contentType: 'text/html', body: '<input name="text"><img src="/slow.png"><script>document.addEventListener("DOMContentLoaded",()=>window.parsed())</script>' });
    });
    await openSearchHome(page, home, { allowedHost, timeout: 2000 });
    assert.equal(imageFinished, true);
    assert.equal(await page.evaluate(() => document.readyState), 'complete');
  });
});

test('a stalled image cannot be mistaken for a ready home page', async () => {
  await fixture(async (page, context, {home,route}) => {
    route(async route => {
      if (route.request().url().endsWith('/slow.png')) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        return route.fulfill({ status: 204 }).catch(() => {});
      }
      return route.fulfill({ contentType: 'text/html', body: '<input name="text"><img src="/slow.png">' });
    });
    await assert.rejects(openSearchHome(page, home, { allowedHost, timeout: 200 }), error => error.name === 'TimeoutError');
  });
});

test('a slow session redirect finishes in the same navigation and preserves the browser session', async () => {
  await fixture(async (page, context, {home,sso,route,server}) => {
    let homes = 0; const events = [];
    await context.addCookies([{ name: 'retained', value: 'yes', url: home }]);
    route(async route => {
      const url = new URL(route.request().url());
      if (url.hostname === 'search.test' && url.pathname === '/') {
        homes++; return route.fulfill({ status: 302, headers: { location: sso } });
      }
      if (url.pathname === '/push') return route.fulfill({ contentType: 'text/html', body: '<script src="/sync.js"></script>' });
      if (url.pathname === '/sync.js') {
        await new Promise(resolve => setTimeout(resolve, 650));
        return route.fulfill({ contentType: 'text/javascript', body: `location.replace(${JSON.stringify(home+'ready')})` }).catch(() => {});
      }
      return route.fulfill({ contentType: 'text/html', body: '<form><input name="text"></form>' });
    });
    await openSearchHome(page, home, { allowedHost, timeout: 500, log: event => events.push(event) });
    assert.equal(page.url(), home + 'ready'); assert.equal(homes, 1);
    assert.ok(await page.locator('input').isVisible());
    assert.equal((await context.cookies(home)).find(c => c.name === 'retained').value, 'yes');
    assert.deepEqual(events, ['search_home_waiting', 'search_home_recovered']);
  });
});

test('loaded session intermediary still waits for its final search document', async () => {
  await fixture(async (page, context, {home,sso,route,server}) => {
    route(route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/') return route.fulfill({ status: 302, headers: { location: sso } });
      return route.fulfill({ contentType: 'text/html', body: url.pathname === '/push' ? `<script>setTimeout(()=>location.replace(${JSON.stringify(home+'ready')}),100)</script>` : '<input name="text">' });
    });
    await openSearchHome(page, home, { allowedHost, timeout: 500 });
    assert.equal(page.url(), home + 'ready');
  });
});

test('a stalled document gets one bounded extension and cannot silently continue', async () => {
  await fixture(async (page, context, {home,sso,route,server}) => {
    route(async route => {
      if (route.request().url().endsWith('block.js')) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        return route.fulfill({ contentType: 'text/javascript', body: '' }).catch(() => {});
      }
      return route.fulfill({ contentType: 'text/html', body: '<input name="text"><script src="/block.js"></script>' });
    });
    const events = [], started = performance.now();
    await assert.rejects(openSearchHome(page, home, { allowedHost, timeout: 200, log: event => events.push(event) }), e => e.name === 'TimeoutError');
    assert.ok(performance.now() - started < 800);
    assert.deepEqual(events, ['search_home_waiting']);
  });
});

test('a timeout before any response fails without extending the navigation', async () => {
  await fixture(async (page, context, {home,sso,route,server}) => {
    route(async route => { await new Promise(resolve => setTimeout(resolve, 500)); await route.fulfill({ body: 'late' }).catch(() => {}); });
    const events = [];
    await assert.rejects(openSearchHome(page, home, { allowedHost, timeout: 100, log: event => events.push(event) }), e => e.name === 'TimeoutError');
    assert.deepEqual(events, []);
  });
});

test('a previously loaded input is not reused while the new redirect has not committed', async () => {
  await fixture(async (page, context, {home,sso,route,server}) => {
    route(async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/old') return route.fulfill({ contentType: 'text/html', body: '<input name="text" value="old">' });
      if (url.hostname === 'search.test') return route.fulfill({ status: 302, headers: { location: sso } });
      await new Promise(resolve => setTimeout(resolve, 1000));
      return route.fulfill({ contentType: 'text/html', body: '<input name="text">' }).catch(() => {});
    });
    await page.goto(home + 'old');
    await assert.rejects(openSearchHome(page, home, { allowedHost, timeout: 200 }), e => e.name === 'TimeoutError');
    assert.equal(page.url(), home + 'old');
  });
});

test('pausing during session redirect stops waiting; no retry request or outside redirect is accepted', async () => {
  await fixture(async (page, context, {home,sso,route,server}) => {
    route(route => route.fulfill({ contentType: 'text/html', body: '<p>Session</p>' }));
    let continuing = true;
    await assert.rejects(openSearchHome(page, sso, { allowedHost, timeout: 200, shouldContinue: async () => continuing, log: () => { continuing = false; } }), e => e instanceof TaskStoppedError);
    server.removeAllListeners('request');
    route(route => new URL(route.request().url()).hostname==='outside.test' ? route.fulfill({body:'outside'}) : route.fulfill({status:302,headers:{location:'http://outside.test:'+server.address().port+'/final'}}));
    await assert.rejects(openSearchHome(page, home, { allowedHost, timeout: 200 }), /outside the allowed host/);
  });
});
