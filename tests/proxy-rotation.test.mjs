import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rotateProxy } from '../worker/proxy-rotation.mjs';
const proxy = { id: 'fixture', rotationUrl: 'https://changeip.mpsapi.com/?proxy_key=synthetic-private-key' };
test('MobileProxy rotation requests JSON and rejects provider errors before browser startup', async () => {
 for(const body of [JSON.stringify({status:'ERR',message:'synthetic-private-error'}),'not-json','null','{}']){
  let requestUrl,requestHeaders;
  await assert.rejects(rotateProxy({proxy,config:{rotationTimeoutMs:1000},fetchImpl:async(url,options)=>{
   requestUrl=url;requestHeaders=options.headers;
   return new Response(body,{status:200});
  }}),error=>['proxy_rotation_rejected','proxy_rotation_invalid_response'].includes(error.code)&&!error.message.includes('private'));
  assert.equal(requestUrl.searchParams.get('format'),'json');assert.ok(requestHeaders['User-Agent'].includes('Mozilla/5.0'));
 }
});
test('confirmed rotation retains the mandatory wait and respects cancellation',async()=>{
 const controller=new AbortController();let waited=false;
 await assert.rejects(rotateProxy({proxy,config:{rotationTimeoutMs:1000},signal:controller.signal,
  fetchImpl:async()=>new Response(JSON.stringify({status:'OK',new_ip:'192.0.2.1'})),
  log:event=>{if(event==='proxy_rotation_wait'){waited=true;controller.abort();}}
 }),error=>error.name==='AbortError');
 assert.equal(waited,true);
});
