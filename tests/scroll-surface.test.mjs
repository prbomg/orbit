import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {scrollPage} from '../worker/mobile-input.mjs';
import {planScrollSurface} from '../worker/scroll-surface.mjs';
import {prepareSearchReferences} from '../worker/search-dom.mjs';
import {inspectSite} from '../worker/site-behavior.mjs';
async function fixture(html,run){const browser=await chromium.launch({headless:true,executablePath:process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH||undefined});try{const context=await browser.newContext({isMobile:true,hasTouch:true,viewport:{width:390,height:844}});const page=await context.newPage();await page.setContent('<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}a{display:block;padding:12px}</style>'+html);await prepareSearchReferences(page);await page.evaluate(()=>{const el=document.querySelector('#goal');if(el)window[Symbol.for('__ OrbitSearchRefs')].set('goal',el);});await run(page);}finally{await browser.close();}}
const target={attribute:'data-worker-internal',value:'goal'};
test('surface identities are stable across planners without DOM attributes and are not copied to replacement elements',async()=>{
 await fixture('<main style="display:flex"><section id="left" style="width:50%;height:600px;overflow:auto"><p style="height:1800px">Left content</p></section><section id="right" style="width:50%;height:600px;overflow:auto"><p style="height:900px">Right content</p><a id="goal">Target</a><div style="height:1500px"></div></section></main>',async page=>{
  const before=await page.evaluate(()=>{window.scrollAttributeMutations=[];const observer=new MutationObserver(records=>scrollAttributeMutations.push(...records.map(record=>record.attributeName)));observer.observe(document.documentElement,{attributes:true,subtree:true});return document.documentElement.outerHTML;});
  const surface=async()=>{const plan=await planScrollSurface(page,{pixels:250,target});try{return await plan.evaluate(s=>({key:s.surfaceKey,ready:s.ready}));}finally{await plan.dispose();}};
  const first=await surface();assert.equal(first.ready,true);assert.match(first.key,/^surface-/);
  assert.equal((await surface()).key,first.key);
  assert.equal(await page.evaluate(()=>document.documentElement.outerHTML),before);
  const view=await inspectSite(page,{marker:'surface-check',domain:'example.test'});
  const blockId=await page.locator('#right p').evaluate(el=>window[Symbol.for('__ OrbitSiteIds')].elements.get(el));
  assert.equal(view.blocks.find(block=>block.id===blockId).scrollKey,first.key);
  assert.equal((await surface()).key,first.key);
  assert.equal(await page.locator('[data-orbit-scroll-id]').count(),0);
  assert.equal(await page.evaluate(()=>scrollAttributeMutations.includes('data-orbit-scroll-id')),false);
  assert.equal(await page.evaluate(()=>Object.getOwnPropertyDescriptor(window,Symbol.for('__ WeakSurfaceIds')).enumerable),false);
  await page.locator('#right').evaluate(el=>el.replaceWith(el.cloneNode(true)));
  assert.equal((await surface()).ready,false);await page.evaluate(()=>window[Symbol.for('__ OrbitSearchRefs')].set('goal',document.querySelector('#goal')));const replacement=await surface();assert.equal(replacement.ready,true);assert.notEqual(replacement.key,first.key);
 });
});
test('target scroll moves its panel while another panel and outer page stay still',async()=>{
 await fixture('<main style="display:flex"><section id="left" style="width:50%;height:600px;overflow:auto"><div style="height:3000px">Left</div></section><section id="right" style="width:50%;height:600px;overflow:auto"><div style="height:1000px">Right</div><a id="goal">Target</a><div style="height:2000px"></div></section></main>',async page=>{
  const result=await scrollPage(page,300,{target,durationMs:160});assert.equal(result.result,'scrolled');assert.equal(result.scrollTarget,'container');assert(await page.locator('#right').evaluate(e=>e.scrollTop)>0);assert.equal(await page.locator('#left').evaluate(e=>e.scrollTop),0);assert.equal(await page.evaluate(()=>scrollY),0);
 });
});
test('an offscreen nested box is first revealed by the outer page, then scrolls internally',async()=>{
 await fixture('<div style="height:1100px"></div><section id="box" style="height:400px;overflow:auto"><div style="height:700px"></div><a id="goal">Target</a><div style="height:1200px"></div></section><div style="height:1300px"></div>',async page=>{
  const first=await scrollPage(page,300,{target,durationMs:140});assert.equal(first.scrollTarget,'page');assert.equal(first.result,'scrolled');assert.equal(await page.locator('#box').evaluate(e=>e.scrollTop),0);
  let inner=false;for(let n=0;n<8;n++){const result=await scrollPage(page,300,{target,durationMs:140});if(result.scrollTarget==='container'&&result.result==='scrolled'){inner=true;break;}}
  assert(inner);assert(await page.locator('#box').evaluate(e=>e.scrollTop)>0);
 });
});
test('native swipes avoid video, slider, map and carousel capture zones',async()=>{
 for(const surface of ['<video></video>','<input type="range">','<div class="mapboxgl-map">Map</div>','<div class="swiper">Carousel</div>']){
  await fixture('<main style="height:6000px"></main><div id="hazard" style="position:fixed;left:110px;top:100px;width:160px;height:650px;background:gray">'+surface+'</div><style>#hazard>*{width:100%;height:100%}</style><script>window.starts=[];document.addEventListener("touchstart",e=>starts.push(e.target.closest("#hazard")!==null),{passive:true})</script>',async page=>{const result=await scrollPage(page,250,{durationMs:140});assert.equal(result.result,'scrolled');assert((await page.evaluate(()=>starts)).every(v=>!v));});
 }
});
test('all-capture overlay causes a bounded blocked result without input',async()=>{
 await fixture('<main style="height:6000px"></main><div class="swiper" style="position:fixed;inset:0"><video style="width:100%;height:100%"></video></div><script>window.touches=0;document.addEventListener("touchstart",()=>touches++)</script>',async page=>{const result=await scrollPage(page,250);assert.equal(result.result,'blocked');assert.equal(result.gestures,0);assert.equal(await page.evaluate(()=>touches),0);assert.equal(await page.evaluate(()=>scrollY),0);});
});
test('a narrow hazard beside the straight line excludes the entire wobble corridor',async()=>{
 await fixture('<main style="height:6000px"></main><div class="swiper" style="position:fixed;left:196px;top:250px;width:3px;height:450px"></div>',async page=>{
  const state=await planScrollSurface(page,{pixels:250});
  try{
   const plan=await state.evaluate(s=>({ready:s.ready,x:s.x,lateralWobble:s.lateralWobble}));
   assert.equal(plan.ready,true);assert(plan.lateralWobble>0);
   assert(plan.x+plan.lateralWobble+4<196||plan.x-plan.lateralWobble-4>199);
  }finally{await state.dispose();}
 });
});
test('touch-action pan-x and overscroll containment are respected',async()=>{
 await fixture('<main style="height:6000px"></main><div style="position:fixed;inset:0;touch-action:pan-x"></div>',async page=>{assert.equal((await scrollPage(page,250)).result,'blocked');assert.equal(await page.evaluate(()=>scrollY),0);});
 await fixture('<main style="height:6000px"></main><section id="box" style="position:fixed;inset:0;overflow:auto;overscroll-behavior:contain"><div style="height:2000px"></div></section>',async page=>{await page.locator('#box').evaluate(e=>e.scrollTop=e.scrollHeight);const result=await scrollPage(page,250);assert.equal(result.result,'blocked');assert.equal(await page.evaluate(()=>scrollY),0);});
});
test('gesture corridor avoids a fixed footer even when the center of the page is clear',async()=>{
 await fixture('<main style="height:6000px"></main><footer style="position:fixed;bottom:0;height:250px;width:100%;background:gray"><button style="width:100%;height:100%">Footer</button></footer><script>window.bad=false;document.addEventListener("touchstart",e=>{if(e.target.closest("footer"))bad=true;},{passive:true})</script>',async page=>{const result=await scrollPage(page,250,{durationMs:140});assert.equal(result.result,'scrolled');assert.equal(await page.evaluate(()=>bad),false);});
});
test('surface is recomputed after moving the target to another panel',async()=>{
 await fixture('<main style="display:flex"><section id="a" style="width:50%;height:600px;overflow:auto"><div style="height:900px"></div><a id="goal">Target</a><div style="height:1500px"></div></section><section id="b" style="width:50%;height:600px;overflow:auto"><div style="height:1000px"></div></section></main>',async page=>{
  const before=await planScrollSurface(page,{pixels:250,target});const first=await before.evaluate(s=>s.surfaceKey);await before.dispose();await page.locator('#b').evaluate(e=>{e.append(document.querySelector('#goal'));const spacer=document.createElement('div');spacer.style.height='1500px';e.append(spacer);});const result=await scrollPage(page,250,{target,durationMs:140});assert.notEqual(result.surfaceKey,first);assert.equal(await page.locator('#a').evaluate(e=>e.scrollTop),0);assert(await page.locator('#b').evaluate(e=>e.scrollTop)>0);
 });
});
test('a target moved above the viewport between gestures ends the old swipe sequence',async()=>{
 await fixture('<section style="height:600px;overflow:auto"><div style="height:900px"></div><a id="goal">Target</a><div style="height:1500px"></div></section><script>document.addEventListener("touchend",()=>{const goal=document.querySelector("#goal");goal.style.position="fixed";goal.style.top="0px";},{once:true})</script>',async page=>{
  const result=await scrollPage(page,300,{target,mode:'precise',durationMs:140});assert.equal(result.gestures,1);assert.equal(result.result,'scrolled');
 });
});
