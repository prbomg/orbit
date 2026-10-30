import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {resolve,isAbsolute} from 'node:path';
import {captchaBudgets,captchaTimeout,CAPTCHA_TIMEOUT_MS,CAPTCHA_MAX_SOLVES,CAPTCHA_MAX_INCORRECT} from '../worker/captcha-policy.mjs';
const source=await readFile(new URL('../worker/captcha-image.mjs',import.meta.url),'utf8');
class CaptchaError extends Error {constructor(code){super(code);this.code=code;}}
class TaskStoppedError extends Error {}
const helpers=source.slice(source.indexOf('export async function readCaptchaPresence'),source.indexOf('const capturedImages')).replaceAll('export ','');
function fixture(sequence){let calls=0,waits=0;const controller=new AbortController();let url='https://ya.ru/search';
 const page={url:()=>url,isClosed:()=>false,evaluate:async()=>{const v=sequence[Math.min(calls++,sequence.length-1)];if(v instanceof Error)throw v;if(v==='navigate'){url+='?new';return false;}return v;}};
 const ctx=vm.createContext({CaptchaError,TaskStoppedError,sleep:async()=>{waits++;}});vm.runInContext(helpers,ctx);
 return {ctx,page,controller,get calls(){return calls},get waits(){return waits},options:{signal:controller.signal,shouldContinue:async()=>true}};
}
for(const input of [{}, {captchaMaxSolves:10,captchaMaxIncorrect:3}])test('working defaults and legacy env '+JSON.stringify(input),()=>assert.deepEqual(captchaBudgets(input),{maxSolves:25,maxIncorrect:20}));
for(const n of [20,21,22,23,24,25])test('explicit provider budget '+n,()=>assert.equal(captchaBudgets({captchaMaxSolves:n}).maxSolves,n));
for(const n of [0,26,NaN,1.5])test('reject invalid provider budget '+n,()=>assert.throws(()=>captchaBudgets({captchaMaxSolves:n})));
test('45s default and explicit legacy timeout cap',()=>{assert.deepEqual(captchaTimeout(),{requestedMs:45000,effectiveMs:45000});assert.deepEqual(captchaTimeout({captchaTimeoutMs:180000}),{requestedMs:180000,effectiveMs:45000});assert.equal(captchaTimeout({captchaTimeoutMs:30000}).effectiveMs,30000);});
test('config defaults actually load with isolated filesystem/env',async()=>{
 const src=await readFile(new URL('../worker/config.mjs',import.meta.url),'utf8');
 const ctx=vm.createContext({URL,resolve,isAbsolute,projectRoot:'/audit',existsSync:p=>!p.endsWith('.env'),process:{env:{DATABASE_URL:'file:/audit/db'}},captchaBudgets,CAPTCHA_TIMEOUT_MS,CAPTCHA_MAX_SOLVES,CAPTCHA_MAX_INCORRECT,ipCheckURL:s=>new URL(s),DEFAULT_PROXY_IP_URL:'https://example.com/',networkProbeUrl:s=>s,maxProfileBytes:()=>100000});
 vm.runInContext(src.slice(src.indexOf('export function loadConfig')).replace('export function','function'),ctx);
 const config=ctx.loadConfig();assert.equal(config.captchaMaxSolves,25);assert.equal(config.captchaMaxIncorrect,20);assert.equal(config.captchaTimeoutMs,45000);
});
for(const present of [true,false])test('429 preserves status and retry delay; challenge='+present,()=>{
 const f=fixture([]);assert.throws(()=>f.ctx.checkCaptchaSubmission({captchaStillPresent:present,status:429,retryAfter:12000,log:()=>{}}),e=>e.code===(present?'captcha_rate_limited':'search_rate_limited')&&e.httpStatus===429&&e.retryDelayMs===12000);
});
test('200 with challenge remains incorrect solution',()=>{const f=fixture([]);assert.throws(()=>f.ctx.checkCaptchaSubmission({captchaStillPresent:true,status:200,log:()=>{}}),e=>e.code==='submission_rejected');});
for(const status of [200,null])test('cleared challenge remains successful, status='+status,()=>{fixture([]).ctx.checkCaptchaSubmission({captchaStillPresent:false,status,log:()=>{}});});
for(const present of [true,false])test('stable DOM read adds no delay '+present,async()=>{const f=fixture([present]);assert.equal(await f.ctx.readCaptchaPresence(f.page,f.options),present);assert.equal(f.waits,0);});
test('transient context failure followed by success',async()=>{const f=fixture([new Error('Execution context was destroyed'),false]);assert.equal(await f.ctx.readCaptchaPresence(f.page,f.options),false);assert.equal(f.calls,2);});
test('loading document is retried',async()=>{const f=fixture([null,true]);assert.equal(await f.ctx.readCaptchaPresence(f.page,f.options),true);assert.equal(f.calls,2);});
test('URL change invalidates first read',async()=>{const f=fixture(['navigate',true]);assert.equal(await f.ctx.readCaptchaPresence(f.page,f.options),true);assert.equal(f.calls,2);});
test('persistent DOM failure is not treated as success',async()=>{const f=fixture([new Error('context destroyed')]);await assert.rejects(f.ctx.readCaptchaPresence(f.page,f.options),e=>e.code==='page_changed');assert.equal(f.calls,3);});
test('abort stops DOM checks',async()=>{const f=fixture([false]);f.controller.abort();await assert.rejects(f.ctx.readCaptchaPresence(f.page,f.options));assert.equal(f.calls,0);});
test('router does not blame provider for a challenge rate limit',async()=>{
 const src=await readFile(new URL('../worker/captcha-routing.mjs',import.meta.url),'utf8');const logs=[];
 const ctx=vm.createContext({CaptchaError,requestCaptchaSolution:()=>{}});vm.runInContext(src.replace(/^import .*;\n/,'').replaceAll('export ',''),ctx);
 const router=ctx.createImageCaptchaRouter({rucaptchaApiKey:'test'},{log:e=>logs.push(e)});
 assert.equal(router.failed(new CaptchaError('captcha_rate_limited')),false);assert.equal(logs.length,0);
 router.failed(new CaptchaError('submission_rejected'));assert.deepEqual(logs,['captcha_service_failed']);
});
