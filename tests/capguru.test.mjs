import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {CaptchaError, requestCaptchaSolution} from '../worker/captcha-provider.mjs';
import {createImageCaptchaRouter} from '../worker/captcha-routing.mjs';
import api from '../utils/capguruApi.js';
for(const primary of ['rucaptcha','capguru']) test(`fallback after exactly two failures from ${primary}`,async()=>{
 const used=[],events=[];let budget=0;
 const router=createImageCaptchaRouter({rucaptchaApiKey:'ru',capguruApiKey:'cap',captchaPrimary:primary,captchaFallbackAfter:2},{log:(event,data)=>events.push({event,...data}),request:async options=>{used.push(options.service);if(options.service===primary)throw new CaptchaError('ERROR_CAPTCHA_UNSOLVABLE');return {coordinates:[{x:1,y:2}]};}});
 const result=await router.solve({},()=>{budget++;});assert.equal(result.coordinates.length,1);
 assert.deepEqual(used,[primary,primary,primary==='capguru'?'rucaptcha':'capguru']);assert.equal(budget,3);
 assert.equal(events.filter(e=>e.event==='captcha_service_switched').length,1);
});
test('rejected solutions count, success resets, site 429 and cancellation do not switch',async()=>{
 const events=[];const router=createImageCaptchaRouter({rucaptchaApiKey:'ru',capguruApiKey:'cap',captchaFallbackAfter:2},{log:(event,data)=>events.push({event,...data})});
 assert.equal(router.failed(new CaptchaError('submission_rejected')),false);router.accepted();
 assert.equal(router.failed(new CaptchaError('search_rate_limited')),false);
 assert.equal(router.failed(new CaptchaError('aborted')),false);
 assert.equal(router.failed(new CaptchaError('submission_rejected')),false);
 assert.equal(router.failed(new CaptchaError('submission_rejected')),true);
 assert.equal(events.filter(e=>e.event==='captcha_service_switched').length,1);
});
test('missing primary key uses backup and budget stops further paid submissions',async()=>{
 let calls=0;const router=createImageCaptchaRouter({capguruApiKey:'cap'},{request:async options=>{calls++;assert.equal(options.service,'capguru');return {coordinates:[]};}});
 await router.solve({},()=>{});assert.equal(calls,1);
 await assert.rejects(router.solve({},()=>{throw new CaptchaError('solve_limit');}),e=>e.code==='solve_limit');assert.equal(calls,1);
});
test('Cap.Guru two-image request, polling, coordinate order, balance and invalid output',async()=>{
 const requests=[];let bad=false,polls=0;
 const server=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://fixture');res.setHeader('Content-Type','text/plain');
  if(url.searchParams.get('action')==='getbalance'){assert.equal(url.searchParams.get('key'),'fake-key');res.end('12.345');return;}
  if(req.url==='/in.php'){let raw='';for await(const chunk of req)raw+=chunk;requests.push(JSON.parse(raw));res.end('OK|123');return;}
  polls++;res.end(polls===1?'CAPCHA_NOT_READY':bad?'OK|coordinates:x=400,y=1':'OK|coordinates:x=90,y=60;x=10,y=20');
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const baseUrl=`http://127.0.0.1:${server.address().port}`;
 const options={apiKey:'fake-key',service:'capguru',type:'smartcaptcha_image',params:{image:'main',imgInstructions:'instruction'},config:{capguruBaseUrl:baseUrl,captchaPollingMs:1,captchaTimeoutMs:5000}};
 try{
  assert.deepEqual((await requestCaptchaSolution(options)).coordinates,[{x:90,y:60},{x:10,y:20}]);
  assert.equal(requests[0].body0,'main');assert.equal(requests[0].body1,'instruction');assert.equal(requests[0].textinstructions,'oth|yandex');
  assert.equal((await api.getBalance('fake-key',{baseUrl})).balance,12.345);
  bad=true;await assert.rejects(requestCaptchaSolution(options),e=>e.code==='INVALID_COORDINATES');
 }finally{await new Promise(resolve=>server.close(resolve));}
});
test('request diagnostics distinguish timeout, DNS, network and invalid JSON without leaking details', async () => {
 const cases = [
  [async () => { throw new DOMException('sensitive URL', 'TimeoutError'); }, 'ERROR_REQUEST_TIMEOUT'],
  [async () => { throw new TypeError('sensitive URL', {cause:{code:'ENOTFOUND'}}); }, 'ERROR_DNS'],
  [async () => { throw new TypeError('sensitive URL', {cause:{code:'ECONNRESET'}}); }, 'ERROR_NETWORK'],
  [async () => new Response('{broken sensitive response'), 'ERROR_INVALID_JSON_RESPONSE'],
 ];
 for (const [fetchImpl, code] of cases) {
  await assert.rejects(api.request('https://api2.cap.guru', '/in.php', {key:'secret'}, {fetchImpl}), error => error.code === code && !error.message.includes('sensitive'));
 }
});
test('Cap.Guru retains the failing request phase', async () => {
 const {solveCapGuru} = await import('../worker/capguru-client.mjs');
 const original = api.request; let stage='submit';
 api.request = async (_base,path,_params,options) => {
  if (path === '/in.php') { assert.equal(options.timeoutMs,30000); if(stage==='poll')return 'OK|123'; }
  const error=new Error('timeout');error.code='ERROR_REQUEST_TIMEOUT';throw error;
 };
 try {
  await assert.rejects(solveCapGuru('fake','http://127.0.0.1',1,{}), e=>e.code==='ERROR_SUBMIT_TIMEOUT');
  stage='poll';await assert.rejects(solveCapGuru('fake','http://127.0.0.1',1,{}), e=>e.code==='ERROR_POLL_TIMEOUT');
 } finally {api.request=original;}
});
