import test from 'node:test';
import assert from 'node:assert/strict';
import { restrictNavigation } from '../worker/action-executor.mjs';
import { sameSite, navigationAllowed } from '../worker/navigation-site.mjs';

test('registrable-domain policy respects public/private suffixes, scheme, port and credentials',()=>{
 assert.equal(sameSite('https://shop.example.co.uk/a','https://www.example.co.uk'),true);
 for(const url of ['https://other.co.uk','https://example.co.uk.evil.com','http://example.co.uk','https://u:p@example.co.uk','https://example.co.uk:8443'])assert.equal(sameSite(url,'https://www.example.co.uk'),false,url);
 assert.equal(sameSite('https://one.github.io','https://two.github.io'),false);
 assert.equal(sameSite('http://127.0.0.1:1234/a','http://127.0.0.1:1234'),true);
 assert.equal(sameSite('http://127.0.0.2:1234','http://127.0.0.1:1234'),false);
 assert.equal(navigationAllowed('https://redirect.example.net/ok','https://example.com',['https://redirect.example.net/ok']),true);
 assert.equal(navigationAllowed('https://redirect.example.net/other','https://example.com',['https://redirect.example.net/ok']),false);
});
test('navigation guard allows same-site GET and only one exact task-origin captcha POST',async()=>{
 let handler;const policy=await restrictNavigation({route:async(_,fn)=>handler=fn,unroute:async()=>{}},'https://www.example.co.uk');
 const outcome=async(url,method='GET')=>{let value;await handler({request:()=>({isNavigationRequest:()=>true,frame:()=>({parentFrame:()=>null}),url:()=>url,method:()=>method}),abort:async()=>value=false,fallback:async()=>value=true});return value;};
 assert.equal(await outcome('https://shop.example.co.uk/a'),true);
 assert.equal(await outcome('https://other.co.uk'),false);
 assert.equal(await outcome('https://shop.example.co.uk/a','POST'),false);
 assert.throws(()=>policy.allowCaptchaPost('https://shop.example.co.uk/captcha'));
 policy.allowCaptchaPost('https://www.example.co.uk/captcha');
 assert.equal(await outcome('https://www.example.co.uk/captcha','POST'),true);
 assert.equal(await outcome('https://www.example.co.uk/captcha','POST'),false);
 await policy.dispose();
});
