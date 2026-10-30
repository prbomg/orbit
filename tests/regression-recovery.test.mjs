import test from 'node:test';
import assert from 'node:assert/strict';
import {createPaginationRecovery,inspectSearchPage,safeSearchLocation} from '../worker/search-recovery.mjs';
const timeout=()=>Object.assign(new Error('timeout'),{code:'search_results_timeout'});
function fixture(options={}) {
 const events=[], calls=[];let waits=0,inspections=0;
 const recover=createPaginationRecovery({
  active:async()=>{if(options.abort)throw options.abort;},
  inspect:async()=>({pageType:options.states?.[Math.min(inspections++,options.states.length-1)]??'home'}),
  document:async()=>{calls.push('document');if(options.documentError)throw options.documentError;},
  waitForResults:async()=>{calls.push('wait');if(++waits<=(options.waitFailures??0))throw timeout();},
  isCurrentSerp:()=>options.matches!==false,
  makeRateLimitError:()=>Object.assign(new Error('429'),{code:'search_rate_limited'}),
  restore:async()=>{calls.push('restore');if(options.restoreError)throw options.restoreError;},
  log:(e,d)=>events.push([e,d]),
 });return{recover,calls,events};
}
test('home after captcha restores once and restarts at first page',async()=>{const f=fixture();assert.deepEqual(await f.recover(timeout(),2),{restarted:true});assert.deepEqual(f.calls,['document','restore','wait']);await assert.rejects(f.recover(timeout(),3));assert.equal(f.calls.filter(x=>x==='restore').length,1);});
test('captcha handling reveals current SERP without another submit',async()=>{const f=fixture({states:['captcha','serp']});assert.deepEqual(await f.recover(timeout(),2),{restarted:false});assert.deepEqual(f.calls,['document','wait']);});
test('stalled SERP gets one restore',async()=>{const f=fixture({states:['serp'],waitFailures:1});assert.deepEqual(await f.recover(timeout(),2),{restarted:true});assert.deepEqual(f.calls,['document','wait','restore','wait']);});
test('wrong query on SERP is restored',async()=>{const f=fixture({states:['serp'],matches:false});await f.recover(timeout(),2);assert.deepEqual(f.calls,['document','restore','wait']);});
test('failed restore propagates and consumes token',async()=>{const err=new Error('home failed');const f=fixture({restoreError:err});await assert.rejects(f.recover(timeout(),2),e=>e===err);await assert.rejects(f.recover(timeout(),2));assert.equal(f.calls.filter(x=>x==='restore').length,1);});
test('failed final wait does not start another cycle',async()=>{const f=fixture({waitFailures:9});await assert.rejects(f.recover(timeout(),2));assert.equal(f.calls.filter(x=>x==='restore').length,1);});
test('first page timeout is outside pagination recovery',async()=>{const f=fixture();await assert.rejects(f.recover(timeout(),1));assert.deepEqual(f.calls,[]);});
test('abort propagates without recovery',async()=>{const err=new Error('stopped');const f=fixture({abort:err});await assert.rejects(f.recover(timeout(),2),e=>e===err);assert.deepEqual(f.calls,[]);});
test('HTTP error from document does not trigger home submit',async()=>{const err=Object.assign(new Error('429'),{code:'search_rate_limited'});const f=fixture({documentError:err});await assert.rejects(f.recover(timeout(),2),e=>e===err);assert.deepEqual(f.calls,['document']);});
test('rate-limited DOM stops recovery',async()=>{const f=fixture({states:['rate_limited']});await assert.rejects(f.recover(timeout(),2),e=>e.code==='search_rate_limited');assert.deepEqual(f.calls,['document']);});
test('closed page does not trigger restore',async()=>{const f=fixture({states:['closed']});await assert.rejects(f.recover(timeout(),2));assert.deepEqual(f.calls,['document']);});
test('sensitive URL components are excluded',()=>{assert.deepEqual(safeSearchLocation('https://user:secret@ya.ru/search/touch?text=private&token=secret#fragment'),{url:'https://ya.ru/search/touch',pagePath:'/search/touch'});assert.equal(safeSearchLocation('https://ya.ru/token/private?q=secret').url,'https://ya.ru/[redacted]');assert.equal(safeSearchLocation('data:text/plain,secret').url,null);});
test('inspection failure reports unknown, not successful SERP',async()=>{const p={url:()=> 'https://ya.ru/?text=secret',isClosed:()=>false,evaluate:async()=>{throw Error('context destroyed');}};assert.deepEqual(await inspectSearchPage(p),{url:'https://ya.ru/',pagePath:'/',pageType:'unknown'});});
test('changed URL during inspection is detected',async()=>{let url='https://ya.ru/search';const p={url:()=>url,isClosed:()=>false,evaluate:async()=>{url='https://ya.ru/';return 'serp';}};assert.equal((await inspectSearchPage(p)).pageType,'changing');});
