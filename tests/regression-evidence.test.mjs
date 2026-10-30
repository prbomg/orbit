import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {safeSearchLocation,createPaginationRecovery} from '../worker/search-recovery.mjs';
const src=await readFile(new URL('../worker/live-view.mjs',import.meta.url),'utf8');
const start=src.indexOf('  stop.captureFailure ='),end=src.indexOf('  return stop;',start);
function fixture({fail=false,change=false}={}) {
 const events=[],writes=[];let url='https://ya.ru/search/touch?text=private&token=secret#fragment';
 const stop={};
 const ctx=vm.createContext({stop,safeSearchLocation,displayUrl:v=>v,files:{screenshot:'/runtime/execution.jpg',directory:'/runtime'},runId:'run',taskId:'task',executionId:'execution',
  setTimeout,clearTimeout,Promise,
  liveFiles:{enqueue:async(path,fn)=>{await fn();}},
  replaceLiveFile:async(path,image)=>writes.push({path,image}),
  writeEvent:(run,task,event,details)=>events.push({event,details}),
 });vm.runInContext(src.slice(start,end),ctx);
 const page={url:()=>url,isClosed:()=>false,screenshot:async()=>{if(fail)throw Error('screenshot timeout');if(change)url='https://ya.ru/showcaptcha';return 'image';}};
 return{capture:details=>stop.captureFailure(page,details),events,writes};
}
test('snapshot saved with safe URL, page type, real status and returned filename',async()=>{
 const f=fixture();const result=await f.capture({pageType:'serp',stage:'search_page_scanned',status:429});
 assert.equal(result.screenshotState,'saved');assert.equal(result.screenshotFile,'/runtime/execution.failure.jpg');assert.equal(f.writes.length,1);
 const d=f.events[0].details;assert.equal(d.url,'https://ya.ru/search/touch');assert.equal(d.pageType,'serp');assert.equal(d.status,429);assert.equal(JSON.stringify(d).includes('secret'),false);
});
test('screenshot error still records metadata and unknown HTTP status',async()=>{
 const f=fixture({fail:true});const result=await f.capture({pageType:'unknown',status:null});assert.equal(result.screenshotState,'unavailable');assert.equal(f.events.length,1);assert.equal(f.events[0].details.status,null);
});
test('navigation during screenshot prevents mismatched image persistence',async()=>{
 const f=fixture({change:true});assert.equal((await f.capture({})).screenshotState,'unavailable');assert.equal(f.writes.length,0);
});
test('actual recovery wiring preserves refined query and disables submit recursion',async()=>{
 const search=await readFile(new URL('../worker/search.mjs',import.meta.url),'utf8');const a=search.indexOf('  let recoveryQuery, recoverySuffix;');const b=search.indexOf('  try {\n    await active();\n    if (preSearchWarmup)',a);
 const calls=[];const session={log:()=>{}};const ctx=vm.createContext({createPaginationRecovery,session,active:async()=>{},inspectSearchPage:async()=>({pageType:'home'}),page:{},document:async()=>{},waitForSerpAttached:async()=>{},navigationTimeoutMs:30000,openHomeSafely:async()=>calls.push('home'),submit:async(...args)=>calls.push(args)});
 vm.runInContext(search.slice(a,b)+"\nrecoveryQuery='original'; recoverySuffix='refinement';",ctx);
 await session.recoverPagination(Object.assign(new Error('timeout'),{code:'search_results_timeout'}),2);
 assert.equal(calls[0],'home');assert.deepEqual(calls[1],['original','refinement',true]);
});
