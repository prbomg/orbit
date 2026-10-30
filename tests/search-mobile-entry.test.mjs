import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { typeTextHumanLike } from '../worker/search.mjs';

async function fixture(run) {
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  try {
    const context = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await run({ page, context });
  } finally { await browser.close(); }
}
const form = `<meta name="viewport" content="width=device-width,initial-scale=1"><input id="query" value="old"><input id="other"><script>
window.events=[];
for(const type of ['touchstart','touchend','keydown','keyup','keypress','beforeinput','input'])document.addEventListener(type,e=>events.push({type:e.type,data:e.data,trusted:e.isTrusted,at:performance.now()}));
</script>`;

test('mobile entry taps the field before text input, including iframe editors', async () => {
  await fixture(async ({ page, context }) => {
    await context.route('http://search.test/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: route.request().url().endsWith('/frame') ? form : '<iframe src="/frame" width="350" height="300"></iframe>' }));
    for (const iframe of [false, true]) {
      await page.goto('http://search.test/' + (iframe ? '' : 'frame'));
      const input = iframe ? page.frameLocator('iframe').locator('#query') : page.locator('#query');
      const text = 'Я qa 🙂';
      await typeTextHumanLike(input, text, { check: async () => {}, timeout: 2000 });
      assert.equal(await input.inputValue(), text);
      const events = await input.evaluate(() => window.events);
      assert.equal(events[0].type, 'touchstart');
      assert.ok(events.findIndex(e => e.type === 'touchend') < events.findIndex(e => e.type === 'input'));
      assert.ok(!events.some(e => ['keydown','keyup','keypress'].includes(e.type)));
      assert.deepEqual(events.filter(e => e.type === 'input').map(e => e.data), [...text].flatMap(character=>[character,character]));
      assert.ok(events.filter(e => e.type === 'input').every(e => e.trusted));
    }
  });
});

test('appending text preserves the original query without End or desktop shortcuts', async () => {
  await fixture(async ({ page }) => {
    await page.setContent(form);
    const input = page.locator('#query');
    await typeTextHumanLike(input, ' бренд', { append: true, check: async () => {}, timeout: 2000 });
    assert.equal(await input.inputValue(), 'old бренд');
    assert.ok(!(await page.evaluate(() => window.events)).some(e => e.type === 'keydown'));
  });
});

test('focus loss restores the intended field with a tap without typing in another field', async () => {
  await fixture(async ({ page }) => {
    await page.setContent(form);
    let checks = 0;
    await typeTextHumanLike(page.locator('#query'), 'ab', { timeout: 2000, check: async () => {
      if (++checks === 3) await page.locator('#other').focus();
    } });
    assert.equal(await page.locator('#other').inputValue(), '');
    assert.equal(await page.locator('#query').inputValue(), 'ab');
    assert.equal((await page.evaluate(() => window.events)).filter(e => e.type === 'touchstart').length, 2);
  });
});

test('mobile correction retries individual characters after transient space normalization', async () => {
  await fixture(async ({ page }) => {
    await page.setContent(form);
    await page.locator('#query').evaluate(el => { let changed=false; el.addEventListener('compositionend', e => { if (e.data === ' ' && !changed) { changed=true;el.value = el.value.replaceAll(' ', ''); } }); });
    const logs=[];
    const result = await typeTextHumanLike(page.locator('#query'), 'a b', { timeout: 2000, check: async () => {},log:(event,data)=>logs.push({event,...data}) });
    assert.equal(result.corrected, true);
    assert.equal(await page.locator('#query').inputValue(), 'a b');
    const events=await page.evaluate(() => window.events);
    assert.deepEqual(events.filter(e=>e.type==='input'&&e.data!==null).map(e=>e.data),['a',' ','b','a',' ','b'].flatMap(character=>[character,character]));
    assert.deepEqual(events.filter(e=>e.type==='input').map(e=>e.data),['a','a',' ',' ','b','b',null,'a','a',' ',' ','b','b']);
    assert.equal(events.filter(e=>e.type==='keydown').length,1);
    const repairInputs=events.filter(e=>e.type==='input'&&e.data!==null).filter((_,index)=>index%2===1).slice(3);
    assert.ok(repairInputs.slice(1).every((e,i)=>e.at-repairInputs[i].at>=40));
    assert.equal(logs.find(e=>e.event==='search_input_repair_started').method,'retype_char_by_char');
    assert.equal(logs.find(e=>e.event==='search_input_metrics').intervalCount,5);
  });
});

test('persistent normalization fails after one repair without bulk input',async()=>{
  await fixture(async({page})=>{
    await page.setContent(form);
    await page.locator('#query').evaluate(el=>el.addEventListener('input',e=>{if(e.data===' ')el.value=el.value.replaceAll(' ','');}));
    const logs=[];
    await assert.rejects(typeTextHumanLike(page.locator('#query'),'a b',{timeout:2000,check:async()=>{},log:(event,data)=>logs.push({event,...data})}),e=>e.code==='search_query_mismatch');
    assert.equal(logs.filter(e=>e.event==='search_input_repair_started').length,1);
    assert.ok((await page.evaluate(()=>window.events)).filter(e=>e.type==='input'&&e.data).every(e=>[...e.data].length===1));
  });
});

for(const mode of ['focus','stop'])test(`repair stops on ${mode} before sending text to another editor`,async()=>{
  await fixture(async({page})=>{
    await page.setContent(form);
    await page.locator('#query').evaluate(el=>el.addEventListener('input',e=>{if(e.data===' ')el.value=el.value.replaceAll(' ','');}));
    let repairing=false,repairChecks=0;
    const work=typeTextHumanLike(page.locator('#query'),'a b',{timeout:2000,log:event=>{if(event==='search_input_repair_started')repairing=true;},check:async()=>{
      if(repairing&&++repairChecks===3){if(mode==='stop')throw Object.assign(new Error('stopped'),{code:'test_stopped'});await page.locator('#other').focus();}
    }});
    await assert.rejects(work,e=>e.code===(mode==='stop'?'test_stopped':'search_input_typing_timeout'));
    assert.equal(await page.locator('#other').inputValue(),'');
    assert.deepEqual((await page.evaluate(()=>window.events)).filter(e=>e.type==='input'&&e.data).map(e=>e.data),['a',' ','b','a'].flatMap(character=>[character,character]));
  });
});

test('repair rejects focus moving from an iframe editor to its parent document',async()=>{
  await fixture(async({page,context})=>{
    await context.route('http://search.test/**',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:route.request().url().endsWith('/editor')?form:'<input id="other"><iframe src="/editor" width="350" height="300"></iframe>'}));
    await page.goto('http://search.test/');
    const input=page.frameLocator('iframe').locator('#query');
    await input.evaluate(el=>el.addEventListener('input',e=>{if(e.data===' ')el.value=el.value.replaceAll(' ','');}));
    let repairing=false,repairChecks=0;
    await assert.rejects(typeTextHumanLike(input,'a b',{timeout:2000,log:event=>{if(event==='search_input_repair_started')repairing=true;},check:async()=>{
      if(repairing&&++repairChecks===3)await page.locator('#other').focus();
    }}),e=>e.code==='search_input_typing_timeout');
    assert.equal(await page.locator('#other').inputValue(),'');
    assert.deepEqual(await input.evaluate(()=>window.events.filter(e=>e.type==='input'&&e.data).map(e=>e.data)),['a',' ','b','a'].flatMap(character=>[character,character]));
  });
});
