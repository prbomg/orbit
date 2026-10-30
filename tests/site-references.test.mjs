import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { inspectSite } from '../worker/site-behavior.mjs';
import { searchReference } from '../worker/search-dom.mjs';
import { scrollPage } from '../worker/mobile-input.mjs';
import { inspectReadingBlock } from '../worker/reading-semantics.mjs';

test('site scan/scroll add no DOM markers, retain identity, and discard old references after AJAX replacement',async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH});
 try {
  const page=await browser.newPage();
  await page.setContent('<main><h1>Equipment</h1><p>Short paragraph.</p><a href="https://example.com/next">Next article</a><div style="height:3000px"></div></main>');
  const inspect=()=>inspectSite(page,{marker:'fixture',domain:'example.com',intent:'equipment'});
  const before=await page.content(),first=await inspect();
  assert.equal((await inspect()).blocks[0].id,first.blocks[0].id);
  assert.equal((await inspectReadingBlock(page)).words,2);
  await scrollPage(page,180);
  assert.equal(await page.content(),before);
  const old=first.links[0].token;
  assert.equal(await searchReference(page,old).count(),1);
  await page.locator('a').evaluate(el=>el.replaceWith(el.cloneNode(true)));
  assert.equal(await searchReference(page,old).count(),0);
  const next=await inspect();assert.notEqual(next.links[0].token,old);
  assert.equal(await page.evaluate(old=>window[Symbol.for('__ OrbitSearchRefs')].has(old),old),false);
  assert.equal(await page.locator('[data-worker-internal],[data-orbit-behavior-block],[data-orbit-scroll-id]').count(),0);
 } finally {await browser.close();}
});

test('overlay and site inspection do not invalidate a pending pagination reference',async()=>{
 const {prepareSearchReferences}=await import('../worker/search-dom.mjs');
 const {dismissSearchOverlays}=await import('../worker/search-overlays.mjs');
 const browser=await chromium.launch({headless:true,executablePath:process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH});
 try {
  const page=await browser.newPage();await page.setContent('<main><p>Article.</p><a id="next" href="https://example.com/next">Next</a></main>');
  await prepareSearchReferences(page);
  await page.evaluate(()=>window[Symbol.for('__ OrbitSearchRefs')].set('next:pending',document.querySelector('#next')));
  await dismissSearchOverlays(page,{allowedHost:()=>true});
  await inspectSite(page,{domain:'example.com'});
  assert.equal(await searchReference(page,'next:pending').count(),1);
 }finally{await browser.close();}
});
