import test from 'node:test';
import assert from 'node:assert/strict';
import account from '../utils/rucaptchaAccount.js';

test('balance uses the saved key in POST, coalesces requests, refreshes, and isolates changed keys',async()=>{
 let calls=[];
 const fetchImpl=async(url,options)=>{calls.push({url,options});await new Promise(r=>setTimeout(r,10));return Response.json({errorId:0,balance:12.34567});};
 const options={baseUrl:'http://127.0.0.1:43210',fetchImpl};
 const values=await Promise.all([account.getBalance('test-key',options),account.getBalance('test-key',options)]);
 assert.equal(calls.length,1);assert.equal(values[0].balance,12.34567);
 assert.equal(calls[0].url,options.baseUrl+'/getBalance');assert.equal(calls[0].options.method,'POST');assert.deepEqual(JSON.parse(calls[0].options.body),{clientKey:'test-key'});assert(calls[0].options.signal);
 await account.getBalance('test-key',options);assert.equal(calls.length,1);
 await account.getBalance('test-key',{...options,refresh:true});assert.equal(calls.length,2);
 await account.getBalance('changed-key',options);assert.equal(calls.length,3);
});
test('balance failures expose only safe codes and accept a zero balance',async()=>{
 const baseUrl='http://127.0.0.1:43211';
 assert.deepEqual(await account.getBalance(null,{baseUrl}),{balance:null,checkedAt:null,errorCode:null});
 const zero=await account.getBalance('zero',{baseUrl,fetchImpl:async()=>Response.json({errorId:0,balance:0})});assert.equal(zero.balance,0);
 const bad=await account.getBalance('bad',{baseUrl,fetchImpl:async()=>Response.json({errorId:1,errorCode:'ERROR_WRONG_USER_KEY',errorDescription:'do not return secret'})});assert.equal(bad.errorCode,'ERROR_WRONG_USER_KEY');assert(!JSON.stringify(bad).includes('secret'));
 const failed=await account.getBalance('network',{baseUrl,fetchImpl:async()=>{throw new Error('private key in error');}});assert.equal(failed.errorCode,'BALANCE_UNAVAILABLE');assert(!JSON.stringify(failed).includes('private'));
});
