import test from 'node:test';
import assert from 'node:assert/strict';
import { safeLogDetails } from '../worker/log-redaction.mjs';
test('structured logs cannot expose captcha tokens, proxy credentials or URL payloads',()=>{
 const result=safeLogDetails({event:'captcha_document_failed',status:429,token:'captcha-fixture-secret',proxyUrl:'http://fixture:password@proxy.test:8000',proxyHost:'private-proxy.test',proxyPort:12345,proxy:{host:'private-nested.test',password:'secret'},nested:{apiKey:'provider-fixture-key',url:'https://search.test/secret-in-path?token=secret#private'},message:'failed https://user:pass@proxy.test:8000/path?key=value'});
 const json=JSON.stringify(result);
 for(const secret of ['captcha-fixture-secret','fixture:password','provider-fixture-key','secret-in-path','token=secret','user:pass','key=value','private-proxy.test','private-nested.test','12345'])assert.ok(!json.includes(secret));
 assert.equal(result.event,'captcha_document_failed');assert.equal(result.status,429);
 const cyclic={};cyclic.self=cyclic;assert.doesNotThrow(()=>safeLogDetails(cyclic));
});
