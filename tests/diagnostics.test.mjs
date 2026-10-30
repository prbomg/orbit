import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,appendFile,rm,mkdir,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import diagnostics from '../utils/attemptDiagnostics.js';
import logs from '../utils/diagnosticLogs.js';
const base=Date.parse('2026-10-13T10:00:00Z');
const event=(seconds,event,details={})=>({time:new Date(base+seconds*1000).toISOString(),event,...details});
const execution={id:'attempt-1',status:'failed',proxyId:'proxy-1',startedAt:new Date(base).toISOString(),completedAt:new Date(base+120000).toISOString(),errorCode:'search_rate_limited',profile:{name:'Профиль'},task:{project:{id:'project-1',name:'Проект'}}};
const log=events=>({events,available:true,truncated:false,invalidLines:0});
const scenario=[event(1,'proxy_configured',{proxyId:'proxy-1',proxyHost:'proxy.example',proxyPort:8000}),event(2,'proxy_ip_check_started'),event(3,'proxy_ip_observed',{browserIp:'198.51.100.1',workerIp:'198.51.100.2',routeComparison:'differs_from_worker'}),event(4,'search_started'),event(5,'captcha_requested'),event(6,'captcha_service_selected',{service:'rucaptcha'}),event(30,'captcha_coordinates_received'),event(32,'captcha_submitted'),event(33,'captcha_page_load_failed',{status:429,retryAfterMs:600000}),event(34,'captcha_document_failed',{status:429}),event(35,'search_http_failed',{status:429}),event(119,'session_failed',{code:'search_rate_limited'})];
test('a received captcha solution followed by HTTP 429 is separate from a provider error and duplicate HTTP markers count once',()=>{
 const d=diagnostics.attemptDiagnostics(execution,log(scenario),null,null,base+200000),summary=diagnostics.aggregateDiagnostics([{execution,diagnostic:d}]),p=summary.providers[0];
 assert.equal(p.requests,1);assert.equal(p.solutions,1);assert.equal(p.providerErrors,0);assert.equal(p.submissionErrors,0);assert.equal(p.httpFailures,1);assert.equal(p.http429,1);assert.equal(p.verified,0);assert.equal(p.medianMs,24000);assert.equal(summary.errors[0].code,'search_rate_limited');assert.equal(d.retryAfterMs,600000);assert.equal(d.network.proxyHost,'proxy.example');assert.equal(d.network.browserIp,'198.51.100.1');assert(d.stages.some(s=>s.kind==='captcha'));assert(d.stages.every(s=>s.durationMs===null||s.durationMs>=0));
});
test('provider retries, fallback, successful document and later application errors use distinct counters',()=>{
 const events=[event(1,'captcha_requested'),event(2,'captcha_service_selected',{service:'rucaptcha'}),event(4,'captcha_service_failed',{service:'rucaptcha',code:'ERROR_SUBMIT_TIMEOUT'}),event(5,'captcha_service_selected',{service:'rucaptcha'}),event(7,'captcha_service_failed',{service:'rucaptcha',code:'ERROR_CAPTCHA_UNSOLVABLE'}),event(8,'captcha_service_switched',{previousService:'rucaptcha',service:'capguru'}),event(9,'captcha_service_selected',{service:'capguru'}),event(15,'captcha_coordinates_received'),event(16,'captcha_page_loaded',{status:200}),event(17,'captcha_document_verified',{status:200})];
 const d=diagnostics.attemptDiagnostics({...execution,status:'completed',errorCode:null},log(events),null,null,base+200000),s=diagnostics.aggregateDiagnostics([{execution:{...execution,status:'completed',errorCode:null},diagnostic:d}]);
 assert.deepEqual(s.providers.map(p=>[p.service,p.requests,p.solutions,p.providerErrors,p.verified]),[['rucaptcha',2,0,2,0],['capguru',1,1,0,1]]);assert.equal(s.switches[0].count,1);
 const rejected=diagnostics.captchaRequests([event(1,'captcha_requested'),event(2,'captcha_service_selected',{service:'capguru'}),event(3,'captcha_coordinates_received'),event(4,'captcha_service_failed',{service:'capguru',code:'submission_rejected'}),event(5,'captcha_failed',{code:'submission_rejected'})]);assert.equal(rejected.requests[0].providerError,null);assert.equal(rejected.requests[0].submissionError,'submission_rejected');
});
test('legacy service stays unknown; missing journals and IP do not become success and stale or foreign snapshots are ignored',()=>{
 const events=[event(-1,'proxy_ip_observed',{browserIp:'198.51.100.8'}),event(1,'captcha_requested'),event(3,'captcha_coordinates_received'),event(5,'captcha_submitted'),event(200,'captcha_requested')];
 const d=diagnostics.attemptDiagnostics(execution,log(events),{executionId:'foreign',checkedAt:event(1,'x').time,browserIp:'198.51.100.9'},null,base+150000);assert.equal(d.network,null);assert.equal(d.captcha.requests.length,1);assert.equal(d.captcha.requests[0].service,'unknown');assert.equal(d.captcha.requests[0].verified,false);
 const missing=diagnostics.attemptDiagnostics(execution,{...log([]),available:false},{executionId:execution.id,browserIp:'198.51.100.9',checkedAt:event(-1,'x').time},null,base+200000);assert.equal(missing.network,null);assert.deepEqual(missing.stages,[]);assert.equal(missing.coverage.available,false);
});
test('network identity warnings and stopped attempts remain separate from failures; clearing checks removes an old IP',()=>{
 const d=diagnostics.attemptDiagnostics(execution,log([event(1,'proxy_configured',{proxyId:'proxy-2',proxyHost:'new.example',proxyPort:8000}),event(2,'proxy_ip_observed',{browserIp:'198.51.100.1',workerIp:'198.51.100.1',routeComparison:'matches_worker'}),event(3,'proxy_ip_check_started'),event(4,'proxy_ip_check_failed')]),null,{id:'proxy-1',host:'old.example',port:8000},base+200000);
 assert.equal(d.network.browserIp,undefined);assert.equal(d.network.proxyHost,'new.example');assert(d.warnings.some(w=>w.includes('отличается от назначенного')));assert(d.warnings.some(w=>w.includes('от текущих настроек')));
 const stopped={...execution,errorCode:'stopped'};const summary=diagnostics.aggregateDiagnostics([{execution:stopped,diagnostic:d}]);assert.equal(summary.counts.stopped,1);assert.equal(summary.counts.failed,0);assert.deepEqual(summary.errors,[]);
});
test('failure snapshot remains scoped to this attempt and survives sanitized log projection',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'orbit-evidence-'));try{
 const path=join(dir,'events.jsonl');await writeFile(path,[event(-1,'search_failure_snapshot',{stage:'old'}),event(10,'search_failure_snapshot',{stage:'search_submit_completed',elapsedMs:1500,screenshotState:'saved',status:200,url:'https://example.test/search?token=private'})].map(e=>JSON.stringify(e)).join('\n')+'\n');
 const d=diagnostics.attemptDiagnostics(execution,await logs.readDiagnosticLog(path),null,null,base+200000);
 assert.equal(d.failureSnapshot.stage,'search_submit_completed');assert.equal(d.failureSnapshot.elapsedMs,1500);assert.equal(d.failureSnapshot.screenshotState,'saved');assert.equal(d.failureSnapshot.url,'https://example.test/search');assert.equal(d.failureSnapshot.status,200);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('full-log reader preserves Unicode offsets, handles corruption, refreshes after append and strips URL credentials and queries',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'orbit-diagnostics-'));try{const path=join(dir,'events.jsonl'),rows=Array.from({length:350},(_,i)=>event(i/10,'navigation_response',{url:'https://user:secret@example.test/путь?apiKey=secret#token',status:200,proxyHost:'user:secret@proxy.example'}));await writeFile(path,rows.map(row=>JSON.stringify(row)).join('\n')+'\ninvalid\n');const first=await logs.readDiagnosticLog(path);assert.equal(first.events.length,350);assert.equal(first.invalidLines,1);assert.equal(first.events[0].url,'https://example.test/%D0%BF%D1%83%D1%82%D1%8C');assert.equal(first.events[0].proxyHost,undefined);assert(first.events[349]._offset>first.events[0]._offset);
 await appendFile(path,JSON.stringify(event(40,'captcha_requested'))+'\n');assert.equal((await logs.readDiagnosticLog(path)).events.length,351);const partial=await logs.readDiagnosticLog(path,{maxBytes:500});assert.equal(partial.truncated,true);assert(partial.events.length<350);assert.equal(partial.events.at(-1).event,'captcha_requested');assert.equal((await logs.readDiagnosticLog(join(dir,'missing'))).available,false);
 await mkdir(join(dir,'live','run-1'),{recursive:true});await writeFile(join(dir,'live','run-1','attempt-1.jsonl'),'');await symlink(path,join(dir,'live','run-1','attempt-secret.jsonl'));const index=await logs.diagnosticFileIndex(dir);assert(index.has('attempt-1'));assert(!index.has('attempt-secret'));
 }finally{await rm(dir,{recursive:true,force:true});}
});
