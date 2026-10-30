import {mobileProfileFixture} from './helpers/mobile-profile-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {createMobileContext,verifyRestoredSession} from '../worker/profiles.mjs';
async function fixture(run){
 const dir=await mkdtemp(join(tmpdir(),'orbit-persistent-restore-'));let context;
 const launch=async()=>{context=await chromium.launchPersistentContext(dir,{headless:true,executablePath:process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH});return context;};
 try{
  await launch();await context.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><html><body>Fixture</body></html>'}));const page=await context.newPage();await page.goto('https://saved.test/');
  await page.evaluate(async()=>{localStorage.setItem('session-key','fixture');await new Promise((resolve,reject)=>{const request=indexedDB.open('session',1);request.onupgradeneeded=()=>request.result.createObjectStore('records');request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result,tx=db.transaction('records','readwrite');tx.objectStore('records').put({id:1,preference:'saved'},'first');tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>reject(tx.error);};});});
  const stored=await context.storageState({indexedDB:true}),profile={...mobileProfileFixture('persistent-fixture'),...stored,savedAt:new Date().toISOString()};await context.close();context=null;
  await launch();for(const p of context.pages())await p.close();await createMobileContext(context.browser(),profile,undefined,context,false);
  await run({context,profile,reopen:async()=>{await context.close();context=null;await launch();for(const p of context.pages())await p.close();await createMobileContext(context.browser(),profile,undefined,context,false);return context;}});
 }finally{await context?.close();await rm(dir,{recursive:true,force:true});}
}
test('reopened persistent storage is discovered offline before comparing saved localStorage and IndexedDB',async()=>{
 await fixture(async({context,profile})=>{
  assert.equal((await context.storageState({indexedDB:true})).origins.length,0);
  let external=0;await context.route('**/*',r=>{external++;return r.abort();});
  const report=await verifyRestoredSession(context,profile,{discoverOrigins:true});
  assert.equal(report.status,'passed');assert.deepEqual(report.checks,{cookies:true,localStorage:true,indexedDB:true});assert.equal(report.missingLocalStorageEntries,0);assert.equal(report.mismatchedIndexedDBItems,0);assert.equal(external,0);
  assert.equal((await verifyRestoredSession(context,profile,{discoverOrigins:true})).status,'passed');
 });
});
test('origin discovery detects genuinely deleted disk data instead of restoring it from the expected snapshot',async()=>{
 await fixture(async({context,profile,reopen})=>{
  const page=await context.newPage();await page.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<!doctype html>'}));await page.goto('https://saved.test/');await page.evaluate(async()=>{localStorage.clear();await new Promise((resolve,reject)=>{const r=indexedDB.deleteDatabase('session');r.onsuccess=resolve;r.onerror=()=>reject(r.error);});});await page.close();
  context=await reopen();await assert.rejects(verifyRestoredSession(context,profile,{discoverOrigins:true}),e=>e.code==='profile_session_verification_failed'&&e.diagnostics.missingLocalStorageEntries===1&&e.diagnostics.mismatchedIndexedDBItems>0);
 });
});
