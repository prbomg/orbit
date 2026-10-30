import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {inspectSite,chooseSiteAction,createPageBehavior,observeScroll,canonicalVisitUrl,waitForSiteReady} from '../worker/site-behavior.mjs';
import {scrollPage} from '../worker/mobile-input.mjs';
async function fixture(html,run){const browser=await chromium.launch({headless:true,executablePath:process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH||undefined});try{const context=await browser.newContext({isMobile:true,hasTouch:true,viewport:{width:390,height:844}});await context.route('**/*',r=>r.fulfill({contentType:'text/html',body:`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}a{display:block;min-height:40px}</style>${html}`}));const page=await context.newPage();await page.goto('http://target.test/start');const inspect=()=>inspectSite(page,{marker:'fixture',domain:'target.test',intent:'промышленный насос',visited:[canonicalVisitUrl(page.url())]});await run({page,inspect});}finally{await browser.close();}}
test('catalog inspection prefers a query-related visible product over unrelated cards and footer links',async()=>{
 await fixture('<main><div data-product><a href="/pump">Промышленный насос</a></div><div data-product><a href="/valve">Клапан</a></div><div data-product><a href="/hose">Шланг</a></div></main><footer><a href="/contacts">Промышленный насос — контакты</a></footer>',async({inspect})=>{const view=await inspect();assert.equal(view.type,'catalog');const state=createPageBehavior(0,90000,2);const action=chooseSiteAction(view,state,{now:30000,remaining:60000,canNavigate:true});assert.equal(action.type,'navigate');assert.equal(action.link.canonical,'http://target.test/pump');assert.equal(action.link.zone,'main');});
});
test('legal and consent links in a page-builder footer are excluded while content and contact links remain',async()=>{
 await fixture('<main><h1>Услуги центра</h1><a href="/services">Все услуги</a></main><div><a href="/politika/">Подробнее</a><a href="/privacy-policy/">Privacy</a><a href="/document-123/">Политика конфиденциальности</a><a href="/agreement/">Согласие на обработку персональных данных</a><a href="/contacts/">Контакты</a><a href="/blog/politika-tsen/">Политика цен на оборудование</a></div>',async({inspect})=>{
  assert.deepEqual((await inspect()).links.map(link=>new URL(link.href).pathname),['/services','/contacts/','/blog/politika-tsen/']);
 });
});
test('page budgets retain initial reading time and visible blocks produce content-based pauses',async()=>{
 await fixture('<main><article><h1>Промышленное оборудование</h1><p>'+('Описание оборудования. '.repeat(30))+'</p><a href="/next">Следующая статья</a></article></main>',async({inspect})=>{const view=await inspect(),state=createPageBehavior(0,90000,2);assert.equal(state.due,30000);const action=chooseSiteAction(view,state,{now:0,remaining:90000,canNavigate:true});assert.equal(action.type,'read');assert.equal(action.block.kind,'heading');state.seen.add(action.block.id);const paragraph=chooseSiteAction(view,state,{now:1000,remaining:89000,canNavigate:true});assert.equal(paragraph.type,'read');assert.equal(paragraph.block.kind,'text');assert.ok(paragraph.pauseMs>action.pauseMs);const next=createPageBehavior(30000,60000,1);assert.equal(next.due,60000);});
});
test('offscreen link is revealed by native input before it can be chosen for navigation',async()=>{
 await fixture('<main><p>Введение</p><div style="height:1050px"></div><a href="/catalog/next">Каталог насосов</a><div style="height:1000px"></div></main>',async({page,inspect})=>{const state=createPageBehavior(0,15000,1);let view=await inspect(),action=chooseSiteAction(view,state,{now:8000,remaining:7000,canNavigate:true});assert.equal(action.type,'reveal');assert.equal(action.link.visible,false);let moves=0;while(action.type==='reveal'&&moves<6){const input=await scrollPage(page,Math.round(action.pixels),{point:view.points[0],durationMs:150});assert.equal(input.result,'scrolled');moves++;view=await inspect();action=chooseSiteAction(view,state,{now:8000,remaining:7000,canNavigate:true});}assert.ok(moves>0);assert.equal(action.type,'navigate');assert.equal(action.link.accessible,true);});
});
test('covered page diagnoses overlay and stops futile swipes, then recovers when the overlay disappears',async()=>{
 await fixture('<main style="height:4000px"><p>Текст</p><a href="/next">Next</a></main><div id="cover" style="position:fixed;inset:0;z-index:100">Overlay</div>',async({page,inspect})=>{const view=await inspect();assert.equal(view.obstruction,'overlay');assert.equal(view.points.length,0);assert.ok(view.links.every(l=>!l.accessible));const state=createPageBehavior(0,15000,1);chooseSiteAction(view,state,{now:0,remaining:15000,canNavigate:false});observeScroll(state,{result:'blocked'},view);assert.equal(state.scrollDisabled,true);await page.locator('#cover').evaluate(el=>el.remove());const clear=await inspect();chooseSiteAction(clear,state,{now:1000,remaining:14000,canNavigate:false});assert.equal(state.scrollDisabled,false);});
});
test('boundary feedback reverses toward unviewed content and repeated failures disable gestures',()=>{
 const state=createPageBehavior(0,15000,1),view={canUp:true,obstruction:'none'};observeScroll(state,{result:'boundary'},view);assert.equal(state.direction,-1);observeScroll(state,{result:'blocked'},view);assert.equal(state.scrollDisabled,true);assert.equal(canonicalVisitUrl('https://target.test/item?page=2&utm_source=x#top'),'https://target.test/item?page=2');
});

test('nearby relevant offscreen product beats an unrelated visible link',async()=>{
 await fixture('<main><a href="/contacts">Контакты</a><div style="height:950px"></div><div data-product><a href="/pump">Промышленный насос</a></div><div style="height:1600px"></div></main>',async({inspect})=>{
  const state=createPageBehavior(0,30000,1),view=await inspect(),action=chooseSiteAction(view,state,{now:16000,remaining:14000,canNavigate:true});
  assert.equal(action.type,'reveal');assert.equal(action.link.canonical,'http://target.test/pump');assert.ok(action.pixels>0);
 });
});
test('distant relevant link cannot consume the remaining budget when a visible alternative exists',async()=>{
 await fixture('<main><a href="/contacts">Контакты</a><div style="height:20000px"></div><div data-product><a href="/pump">Промышленный насос</a></div></main>',async({inspect})=>{
  const state=createPageBehavior(0,15000,1),action=chooseSiteAction(await inspect(),state,{now:11000,remaining:4000,canNavigate:true});
  assert.equal(action.type,'navigate');assert.equal(action.link.canonical,'http://target.test/contacts');
 });
});
test('readiness waits for skeleton removal and reselects the loaded card',async()=>{
 await fixture('<main aria-busy="true"><div class="skeleton" style="height:300px"></div></main>',async({page,inspect})=>{
  await page.evaluate(()=>setTimeout(()=>{const main=document.querySelector('main');main.removeAttribute('aria-busy');main.innerHTML='<h1>Каталог</h1><div data-product><a href="/pump">Промышленный насос</a></div>';},220));
  const state=createPageBehavior(0,15000,1),start=performance.now(),result=await waitForSiteReady(inspect,state,{timeout:1500});
  assert(result.ready);assert(performance.now()-start>=220);assert(result.view.links.some(l=>l.canonical==='http://target.test/pump'));
  assert.equal(chooseSiteAction(result.view,state,{now:8000,remaining:7000,canNavigate:true}).link.canonical,'http://target.test/pump');
 });
});
test('hidden loading indicators do not block a ready page',async()=>{
 await fixture('<main><h1>Каталог</h1><div aria-busy="true" hidden><span class="skeleton">Loading</span></div><a href="/pump">Насос</a></main>',async({inspect})=>{
  const result=await waitForSiteReady(inspect,createPageBehavior(0,15000,1),{timeout:600});assert(result.ready);assert.equal(result.view.readiness.busy,false);
 });
});
test('layout stabilization waits through a late displacement and invalidates cached candidates',async()=>{
 await fixture('<main><h1>Каталог</h1><a id="choice" href="/old">Клапан</a><div style="height:2000px"></div></main>',async({page,inspect})=>{
  const state=createPageBehavior(0,15000,1);assert((await waitForSiteReady(inspect,state,{timeout:1000})).ready);
  await page.evaluate(()=>{const a=document.querySelector('#choice');a.href='/pump';a.textContent='Промышленный насос';a.style.transform='translateY(20px)';setTimeout(()=>a.style.transform='translateY(160px)',100);});
  const start=performance.now(),result=await waitForSiteReady(inspect,state,{timeout:1000});assert(result.ready);assert(performance.now()-start>=260);
  const action=chooseSiteAction(result.view,state,{now:8000,remaining:7000,canNavigate:true});assert.equal(action.link.canonical,'http://target.test/pump');assert(action.link.top>150);
 });
});
test('continuous movement and stuck loading have bounded readiness waits',async()=>{
 for(const markup of ['<main aria-busy="true"><div class="skeleton">Загрузка</div></main>','<main><h1>Каталог</h1><a id="moving" href="/pump">Насос</a></main><script>setInterval(()=>document.querySelector("a").style.transform=`translateY(${Date.now()%100}px)`,35)</script>']){
  await fixture(markup,async({inspect})=>{const start=performance.now();const result=await waitForSiteReady(inspect,createPageBehavior(0,15000,1),{timeout:350});assert.equal(result.ready,false);assert(performance.now()-start<800);});
 }
});
test('readiness cancellation aborts promptly without performing an action',async()=>{
 await fixture('<main aria-busy="true"><p>Загрузка</p></main>',async({inspect})=>{const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),100);try{await assert.rejects(waitForSiteReady(inspect,createPageBehavior(0,15000,1),{timeout:2000,signal:controller.signal}),{name:'AbortError'});}finally{clearTimeout(timer);}});
});
test('scroll feedback calibrates displacement and corrects an overshot unread block',async()=>{
 await fixture('<main><h1>Введение</h1><div style="height:1100px"></div><p id="goal">Характеристики промышленного насоса</p><div style="height:2000px"></div></main>',async({page,inspect})=>{
  const state=createPageBehavior(0,30000,0),initial=await inspect();initial.blocks.filter(b=>b.visible).forEach(b=>state.seen.add(b.id));
  const intended=chooseSiteAction(initial,state,{now:1000,remaining:29000,canNavigate:false});assert.equal(intended.type,'scroll');assert(intended.block);
  observeScroll(state,{result:'scrolled',movedPixels:200,scrollTarget:'page',settled:true},initial,{pixels:100});assert.equal(state.scrollGains.page,1.5);
  await page.locator('#goal').evaluate(el=>scrollTo(0,el.offsetTop+90));let view=await inspect();const correction=chooseSiteAction(view,state,{now:2000,remaining:28000,canNavigate:false});assert.equal(correction.reason,'correct_scroll_position');assert(correction.pixels<0);
  const result=await scrollPage(page,Math.round(correction.pixels),{point:view.points[0],durationMs:150});assert.equal(result.result,'scrolled');assert.equal(result.settled,true);observeScroll(state,result,view,correction);
  view=await inspect();const next=chooseSiteAction(view,state,{now:3000,remaining:27000,canNavigate:false});assert.equal(next.type,'read');assert.equal(next.block.id,intended.block.id);
 });
});
test('nested link reveal uses the container viewport and leaves the outer page stationary',async()=>{
 await fixture('<main style="height:400px;margin-top:70px;overflow:auto"><p>Каталог</p><div style="height:600px"></div><div data-product><a href="/pump">Промышленный насос</a></div><div style="height:1200px"></div></main>',async({page,inspect})=>{
  const state=createPageBehavior(0,30000,1);let view=await inspect(),action=chooseSiteAction(view,state,{now:16000,remaining:14000,canNavigate:true});assert.equal(view.scroller,'container');assert.equal(action.type,'reveal');assert(action.pixels<=160);
  for(let n=0;n<8&&action.type==='reveal';n++){const result=await scrollPage(page,Math.round(action.pixels),{point:view.points[0],durationMs:150});observeScroll(state,result,view,action);view=await inspect();action=chooseSiteAction(view,state,{now:16000,remaining:14000,canNavigate:true});}
  assert.equal(action.type,'navigate');assert.equal(action.link.canonical,'http://target.test/pump');assert.equal(await page.evaluate(()=>scrollY),0);
 });
});

test('the visible alias of the same relevant URL avoids unnecessary scrolling',async()=>{
 await fixture('<header><a href="/pump">Подробнее</a></header><main><div style="height:1000px"></div><div data-product><a href="/pump">Промышленный насос</a></div><div style="height:2000px"></div></main>',async({inspect})=>{
  const state=createPageBehavior(0,30000,1),action=chooseSiteAction(await inspect(),state,{now:16000,remaining:14000,canNavigate:true});assert.equal(action.type,'navigate');assert.equal(action.link.zone,'navigation');assert.equal(action.link.canonical,'http://target.test/pump');
 });
});
test('a fixed offscreen target is abandoned when gestures do not bring it closer',async()=>{
 await fixture('<main><a href="/other">Контакты</a><a style="position:fixed;top:-100px" href="/pump">Промышленный насос</a><div style="height:3000px"></div></main>',async({inspect})=>{
  const state=createPageBehavior(0,30000,1);let view=await inspect();let action=chooseSiteAction(view,state,{now:16000,remaining:14000,canNavigate:true});assert.equal(action.type,'reveal');
  for(let n=0;n<2;n++){observeScroll(state,{result:'scrolled',movedPixels:action.pixels,settled:true,scrollTarget:'page'},view,action);action=chooseSiteAction(view,state,{now:16000,remaining:14000,canNavigate:true});}
  assert.equal(state.reveals.get('http://target.test/pump'),2);action=chooseSiteAction(view,state,{now:16000,remaining:14000,canNavigate:true});assert.equal(action.type,'navigate');assert.equal(action.link.canonical,'http://target.test/other');
 });
});
