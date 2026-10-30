import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { composeMobileCharacter } from '../worker/mobile-composition.mjs';

async function fixture(run) {
 const browser=await chromium.launch({headless:true,executablePath:process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH});
 try { const page=await browser.newPage({hasTouch:true,isMobile:true});await page.setContent('<input id="a"><input id="b">');await page.locator('#a').focus();await run(page); }
 finally { await browser.close(); }
}
test('native composition events commit Unicode once and leave focus in the editor', async () => fixture(async page => {
 await page.evaluate(()=>{window.events=[];for(const type of ['compositionstart','compositionupdate','compositionend'])document.addEventListener(type,e=>events.push({type,data:e.data,trusted:e.isTrusted}));});
 const focused=()=>page.locator('#a').evaluate(el=>el===document.activeElement);
 for(const text of ['Я','🙂',' ']) await composeMobileCharacter(page,text,{focused});
 assert.equal(await page.locator('#a').inputValue(),'Я🙂 '); assert.equal(await focused(),true);
 const events=await page.evaluate(()=>events);
 assert.deepEqual(events.filter(e=>e.type==='compositionend').map(e=>e.data),['Я','🙂',' ']);
 assert.ok(events.filter(e=>e.type!=='compositionend').every(e=>e.trusted));
 // Chromium CDP's commit currently emits an untrusted compositionend. Do not forge isTrusted.
 assert.ok(events.filter(e=>e.type==='compositionend').every(e=>!e.trusted));
}));
test('cancelled composition sends no text and lost focus is rejected', async () => fixture(async page => {
 const controller=new AbortController();controller.abort(new Error('stopped'));
 await assert.rejects(composeMobileCharacter(page,'x',{signal:controller.signal}),/stopped/);
 await assert.rejects(composeMobileCharacter(page,'x',{focused:async()=>false}),{code:'search_input_typing_timeout'});
 assert.equal(await page.locator('#a').inputValue(),'');
 assert.equal(await page.locator('#b').inputValue(),'');
}));
test('composition handlers stealing focus never commit into another editor',async()=>fixture(async page=>{
 await page.evaluate(()=>document.querySelector('#a').addEventListener('compositionupdate',()=>document.querySelector('#b').focus(),{once:true}));
 await assert.rejects(composeMobileCharacter(page,'x',{focused:()=>page.locator('#a').evaluate(el=>el===document.activeElement)}),{code:'search_input_typing_timeout'});
 assert.equal(await page.locator('#b').inputValue(),'');
}));

test('focus stolen by the final compositionend handler is restored before typing returns',async()=>fixture(async page=>{
 const {typeTextHumanLike}=await import('../worker/search.mjs');
 await page.evaluate(()=>document.querySelector('#a').addEventListener('compositionend',()=>document.querySelector('#b').focus(),{once:true}));
 await typeTextHumanLike(page.locator('#a'),'x',{timeout:2000,check:async()=>{}});
 assert.equal(await page.locator('#a').inputValue(),'x');
 assert.equal(await page.locator('#a').evaluate(el=>el===document.activeElement),true);
 assert.equal(await page.locator('#b').inputValue(),'');
}));
