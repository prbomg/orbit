import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { activateElement, scrollPage } from '../worker/mobile-input.mjs';
import { executeActionPlan } from '../worker/action-executor.mjs';

async function fixture(run, { mobile = true, dpr = 1 } = {}) {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH || undefined });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: dpr });
    const page = await context.newPage();
    await page.setContent(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
      <style>body{margin:0}button{width:100px;height:44px;position:fixed;top:30px;left:20px}main{height:8000px;background:linear-gradient(white,gray)}</style>
      <button id="control">Open</button><main></main>
      <script>window.events=[]; for(const type of ['touchstart','touchmove','touchend','touchcancel','pointerdown','pointermove','mousedown','mouseup','click','wheel','scroll']) {
        document.addEventListener(type,e=>events.push({type,time:e.timeStamp,scrollY,trusted:e.isTrusted,pointerType:e.pointerType,x:e.touches?.[0]?.clientX,y:e.touches?.[0]?.clientY,changed:e.changedTouches?.length,touchCount:e.touches?.length,radiusX:e.touches?.[0]?.radiusX,radiusY:e.touches?.[0]?.radiusY,force:e.touches?.[0]?.force,identifier:e.touches?.[0]?.identifier}),{passive:true});
      }</script>`);
    await run(page, context);
  } finally { await browser.close(); }
}

test('mobile tap sends trusted touch events to a small control and an iframe control', async () => {
  await fixture(async page => {
    const button = page.locator('#control');
    await activateElement(button);
    const events = await page.evaluate(() => events);
    assert.deepEqual(events.filter(e=>e.type.startsWith('touch')).map(e=>e.type), ['touchstart','touchend']);
    assert.ok(events.every(e=>e.trusted));
    assert.equal(events.find(e=>e.type==='pointerdown').pointerType,'touch');
    assert.equal(events.find(e=>e.type==='touchend').changed,1);
    assert.ok(events.find(e=>e.type==='touchend').time-events.find(e=>e.type==='touchstart').time>=45);
    const start=events.find(e=>e.type==='touchstart');assert.ok(start.x>=67 && start.x<=73 && start.y>=49 && start.y<=55);
    await page.evaluate(()=>{document.querySelector('#control').style.width='4px';document.querySelector('#control').style.height='4px';});
    await activateElement(button);
    await page.evaluate(()=>{const frame=document.createElement('iframe');frame.style='position:fixed;left:120px;top:20px;width:200px;height:100px';frame.srcdoc='<button onclick="window.tapped=true">Frame button</button>';document.body.append(frame);});
    await activateElement(page.frameLocator('iframe').getByRole('button'));
    assert.equal(await page.frames()[1].evaluate(()=>window.tapped),true);
  });
});

test('a hold over 200 ms is still a single tap and cancelling a hold releases without clicking', async () => {
  await fixture(async page => {
    await activateElement(page.locator('#control'),{durationMs:230});
    const held=await page.evaluate(()=>events);
    assert(held.find(e=>e.type==='touchend').time-held.find(e=>e.type==='touchstart').time>=220);
    assert.equal(held.filter(e=>e.type==='click').length,1);
    await page.evaluate(()=>events=[]);
    const controller=new AbortController();
    await page.exposeFunction('abortHold',()=>controller.abort());
    await page.evaluate(()=>document.addEventListener('touchstart',()=>window.abortHold(),{once:true}));
    await assert.rejects(activateElement(page.locator('#control'),{durationMs:350,signal:controller.signal}),{name:'AbortError'});
    const cancelled=await page.evaluate(()=>events);
    assert(cancelled.some(e=>e.type==='touchcancel'));
    assert(!cancelled.some(e=>e.type==='click'||e.type==='touchend'));
    await activateElement(page.locator('#control'));
    assert.equal(await page.evaluate(()=>events.filter(e=>e.type==='click').length),1);
  });
});

test('reading swipes use short contact durations, wobble and finish inertia before returning', async () => {
  await fixture(async page => {
    const result=await scrollPage(page,250);
    const events=await page.evaluate(()=>window.events);
    const start=events.find(e=>e.type==='touchstart'),end=events.find(e=>e.type==='touchend');
    assert.equal(result.gestureMode,'reading');
    assert(end.time-start.time>=170);assert(end.time-start.time<1000);
    assert(events.some(e=>e.type==='touchmove'&&Math.abs(e.x-start.x)>.5));
    assert(result.inertiaMethods.some(method=>['native','exponential'].includes(method)));
    assert(result.movedPixels>end.scrollY,'page continues moving after release');
    assert.equal(result.settled,true);
    const stopped=await page.evaluate(()=>scrollY);
    await page.waitForTimeout(180);assert(Math.abs(await page.evaluate(()=>scrollY)-stopped)<=1);
  });
});

test('mobile taps retain overlay checks and can be cancelled without clicking', async () => {
  await fixture(async page => {
    await page.evaluate(()=>{const overlay=document.createElement('div');overlay.id='overlay';overlay.style='position:fixed;inset:0;z-index:20';document.body.append(overlay);});
    await assert.rejects(activateElement(page.locator('#control'),{timeout:200}),{name:'TimeoutError'});
    const controller=new AbortController();setTimeout(()=>controller.abort(),80);
    await assert.rejects(activateElement(page.locator('#control'),{timeout:5000,signal:controller.signal}));
    assert.equal(await page.evaluate(()=>events.filter(e=>e.type==='click').length),0);
  });
});

test('tap timeouts retain TimeoutError and disabled controls stay untouched', async () => {
  await fixture(async page => {
    await page.locator('#control').evaluate(e=>e.disabled=true);
    await assert.rejects(activateElement(page.locator('#control'),{timeout:200}),{name:'TimeoutError'});
    assert.equal(await page.evaluate(()=>events.filter(e=>e.type==='touchstart').length),0);
    await page.locator('#control').evaluate(e=>e.disabled=false);
    await assert.rejects(activateElement(page.locator('#control'),{durationMs:350,timeout:220}),{name:'TimeoutError'});
    assert.equal(await page.evaluate(()=>events.filter(e=>e.type==='click').length),0);
    await activateElement(page.locator('#control'));
    assert.equal(await page.evaluate(()=>events.filter(e=>e.type==='click').length),1);
  });
});

test('CDP swipes scroll down and up with trusted touchmove and no wheel or mouse pointer input', async () => {
  await fixture(async page => {
    const result=await scrollPage(page,500,{durationMs:200});assert.equal(result.method,'touch');assert.equal(result.gestures,2);assert.equal(result.result,'scrolled');
    await page.waitForFunction(()=>scrollY>100);
    const down=await page.evaluate(()=>scrollY);
    await scrollPage(page,-250,{durationMs:200});
    await page.waitForFunction(before=>scrollY<before,down);
    const events=await page.evaluate(()=>events);
    assert.ok(events.some(e=>e.type==='touchmove'&&e.trusted));
    assert.ok(events.some(e=>e.type==='scroll'));
    assert.ok(!events.some(e=>e.type==='wheel'||e.pointerType==='mouse'));
  });
});

for (const dpr of [1, 3]) test(`swipe contact varies smoothly per gesture in DOM at DPR ${dpr}`, async () => {
  await fixture(async page => {
    await scrollPage(page, 500, { durationMs: 200 });
    const events = await page.evaluate(() => window.events.filter(e => e.type.startsWith('touch')));
    const starts = events.filter(e => e.type === 'touchstart');
    assert.equal(starts.length, 2);
    assert.notDeepEqual(starts.map(e => [e.radiusX, e.radiusY, e.force])[0], starts.map(e => [e.radiusX, e.radiusY, e.force])[1]);
    let start, moves = [];
    const verifyMoves = () => {
      assert.ok(moves.length > 1);
      assert.ok(moves.some(e => Math.abs(e.radiusX - start.radiusX) > .0001));
      assert.ok(moves.some(e => Math.abs(e.force - start.force) > .0001));
    };
    for (const e of events) {
      if (e.type === 'touchstart') {
        start = e; moves = [];
        assert.ok(e.radiusX >= 10.999 && e.radiusX <= 15.501);
        assert.ok(e.radiusY >= 11.999 && e.radiusY <= 17.001);
        assert.ok(e.force >= .419 && e.force <= .781);
      } else if (e.type === 'touchmove') moves.push(e);
      else { verifyMoves(); assert.equal(e.touchCount, 0); continue; }
      assert.equal(e.touchCount, 1); assert.equal(e.identifier, start.identifier);
      assert.ok(e.radiusY > e.radiusX);
      assert.ok(Math.abs(e.radiusX - start.radiusX) <= .301);
      assert.ok(Math.abs(e.radiusY - start.radiusY) <= .301);
      assert.ok(Math.abs(e.force - start.force) <= .021);
      assert.ok(e.force >= 0 && e.force <= 1);
    }
    assert.equal(events.filter(e => e.type === 'touchend').length, 2);
  }, { dpr });
});

test('interrupted gesture releases the finger and the next gesture still scrolls', async () => {
  await fixture(async page => {
    const controller=new AbortController();
    const run=scrollPage(page,500,{durationMs:800,signal:controller.signal});
    await page.waitForFunction(()=>events.some(e=>e.type==='touchmove'));
    controller.abort();await assert.rejects(run,{name:'AbortError'});
    const events=await page.evaluate(()=>events);
    assert.ok(events.some(e=>['touchcancel','touchend'].includes(e.type)));
    const before=await page.evaluate(()=>scrollY);
    await scrollPage(page,250,{durationMs:200});
    await page.waitForFunction(before=>scrollY>before,before);
  });
});

test('mobile action plan maps old cursor actions to a pause and logs touch scrolling', async () => {
  await fixture(async page => {
    const logs=[];
    await executeActionPlan(page,[{type:'move_mouse_randomly',durationMs:100},{type:'scroll_down',pixels:200}],{
      durationMs:100,maxDurationMs:5000,navigationTimeoutMs:1000,origin:'http://example.test',log:(event,data)=>logs.push({event,...data}),
    });
    assert.ok(logs.some(e=>e.event==='action_completed'&&e.inputMethod==='reading_pause'));
    assert.ok(logs.some(e=>e.event==='action_completed'&&e.inputMethod==='touch'));
    assert.ok(!(await page.evaluate(()=>events)).some(e=>e.pointerType==='mouse'));
  });
});

test('desktop contexts retain mouse controls and wheel scrolling', async () => {
  await fixture(async page => {
    await activateElement(page.locator('#control'));
    const result=await scrollPage(page,250);assert.equal(result.method,'wheel');assert.equal(result.gestures,1);assert.equal(result.result,'scrolled');
    const events=await page.evaluate(()=>events);
    assert.ok(events.some(e=>e.type==='mousedown'));
    assert.ok(!events.some(e=>e.type==='touchstart'));
  },{mobile:false});
});

test('wrapped links use a rendered fragment instead of empty bounding-box space', async () => {
  await fixture(async page => {
    await page.evaluate(()=>{const box=document.createElement('div');box.style='position:fixed;top:150px;left:20px;width:110px';box.innerHTML='<a id="wrapped" href="#" onclick="event.preventDefault();window.wrappedTapped=true">An unusually long wrapped mobile navigation label</a>';document.body.append(box);});
    await activateElement(page.locator('#wrapped'));
    assert.equal(await page.evaluate(()=>window.wrappedTapped),true);
  });
});

test('touch gestures scroll nested containers without falling back to wheel input', async () => {
  await fixture(async page => {
    await page.evaluate(()=>{const box=document.createElement('div');box.id='scroller';box.style='position:fixed;inset:120px 0 0;overflow:auto;touch-action:pan-y;background:white';box.innerHTML='<div style="height:4000px">Nested</div>';document.body.append(box);});
    await scrollPage(page,250,{durationMs:200});
    await page.waitForFunction(()=>document.querySelector('#scroller').scrollTop>100);
    assert.equal(await page.evaluate(()=>scrollY),0);
    assert.ok(!(await page.evaluate(()=>events)).some(e=>e.type==='wheel'));
  });
});
