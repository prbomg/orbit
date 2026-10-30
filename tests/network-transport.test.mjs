import test from 'node:test';
import assert from 'node:assert/strict';
import {createSecureServer} from 'node:http2';
import {createServer} from 'node:http';
import {connect} from 'node:net';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {chromium} from 'playwright';
import {PrismaClient} from '@prisma/client';
import fp from '../utils/fingerprint.js';
import {createMobileContext,mobileContextOptions} from '../worker/profiles.mjs';
import {poolFixture} from './helpers/pool-fixture.mjs';
import {parseTransportObservation,compareTransportReference,observeNetworkTransport,observeHttp3,networkProbeUrl,reserveTransportProbe} from '../worker/network-transport.mjs';
const fixture=()=>({http_version:'h2',user_agent:'fixture-agent',ip:'198.51.100.1:443',tls:{ja4:'t13d1516h2_8daaf6152771_e5627efa2ab1',session_id:'private-session',client_random:'private-random'},http2:{sent_frames:[{frame_type:'SETTINGS',settings:['HEADER_TABLE_SIZE = 65536','UNKNOWN_SETTING_27 = 4321','INITIAL_WINDOW_SIZE = 6291456']},{frame_type:'WINDOW_UPDATE',increment:15663105},{frame_type:'HEADERS',headers:[':method: GET',':authority: fixture.invalid',':scheme: https',':path: /?secret=private','cookie: private-cookie','authorization: private-key','accept-language: ru-RU']}]}});

test('protocol measurements preserve SETTINGS order but exclude GREASE and all header/cookie values',()=>{
 const raw=fixture(),r=parseTransportObservation(raw,{userAgent:'fixture-agent',protocol:'h2'});
 assert.equal(r.tls.status,'measured');assert.equal(r.http2.status,'measured');assert.equal(r.observedIp,'198.51.100.1');assert.deepEqual(r.http2.pseudoHeaderOrder,[':method',':authority',':scheme',':path']);
 assert.doesNotMatch(JSON.stringify(r),/private|session_id|client_random|UNKNOWN_SETTING/);
 const changed=fixture();changed.http2.sent_frames[0].settings.reverse();assert.notEqual(parseTransportObservation(changed,{userAgent:'fixture-agent'}).http2.fingerprint,r.http2.fingerprint);
 const grease=fixture();grease.http2.sent_frames[0].settings[1]='UNKNOWN_SETTING_123 = 8';assert.equal(parseTransportObservation(grease,{userAgent:'fixture-agent'}).http2.fingerprint,r.http2.fingerprint);
 assert.throws(()=>parseTransportObservation(raw,{userAgent:'other'}),/identity/);assert.throws(()=>parseTransportObservation(raw,{userAgent:'fixture-agent',protocol:'h3'}),/protocol/);
 assert.equal(compareTransportReference(r,null,{}).status,'reference_missing');
 const reference={version:1,platform:'Android',source:'physical-device',browserVersion:'153.0.0.1',locale:'ru-RU',collectorHost:'fixture.invalid',requestKind:'document-navigation',measuredAt:'2026-10-14T12:00:00Z',ja4:r.tls.ja4,http2Fingerprint:r.http2.fingerprint};
 const scope={runtimeVersion:'153.0.0.1',locale:'ru-RU',endpointHost:'fixture.invalid'};
 assert.equal(compareTransportReference(r,reference,scope).status,'matched');assert.equal(compareTransportReference(r,reference,{...scope,runtimeVersion:'154.0.0.1'}).status,'reference_inapplicable');
 assert.equal(compareTransportReference(r,{...reference,http2Fingerprint:'a'.repeat(64)},scope).status,'different');
 for(const url of ['http://example.test/','https://user:secret@example.test/','https://example.test/?secret=1'])assert.throws(()=>networkProbeUrl(url));
});

test('shared probe cooldown is atomic between independent Prisma clients in WAL',async()=>{
 const f=await poolFixture({wal:true}),other=new PrismaClient({datasources:{db:{url:`file:${f.dir}/test.db`}}});
 try{
  const results=await Promise.all([reserveTransportProbe(f.db,'https://collector.invalid/api/all',100000),reserveTransportProbe(other,'https://collector.invalid/api/all',100000)]);
  assert.deepEqual(results.sort(),[false,true]);assert.equal(await reserveTransportProbe(f.db,'https://collector.invalid/api/all',160001),true);
 }finally{await other.$disconnect();await f.cleanup();}
});

test('real Chromium profile navigates through CONNECT; unavailable collector and TCP-only HTTP3 fallback do not become Android approval', {timeout:30000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'orbit-transport-'));let browser,server,proxy;const sockets=new Set();let upstreams=0;
 try{
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(dir,'key.pem'),'-out',join(dir,'cert.pem'),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost'],{stdio:'ignore'});
 server=createSecureServer({key:await readFile(join(dir,'key.pem')),cert:await readFile(join(dir,'cert.pem'))});
 server.on('session',session=>{sockets.add(session);session.on('close',()=>sockets.delete(session));});
 server.on('stream',(stream,headers)=>{
  const data=fixture();data.user_agent=headers['user-agent'];stream.respond({':status':200,'content-type':'application/json','alt-svc':'h3=":443"; ma=60'});stream.end(JSON.stringify(data));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 proxy=createServer();proxy.on('connect',(req,client,head)=>{
  if(req.url!==`localhost:${server.address().port}`){client.end('HTTP/1.1 403 Forbidden\r\n\r\n');return;}upstreams++;
  const remote=connect(server.address().port,'127.0.0.1',()=>{client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)remote.write(head);client.pipe(remote);remote.pipe(client);});
  for(const s of [remote,client]){sockets.add(s);s.on('error',()=>s.destroy());s.on('close',()=>sockets.delete(s));}
 });await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
 browser=await chromium.launch({headless:true,executablePath:process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH,args:['--proxy-bypass-list=<-loopback>'],proxy:{server:`http://127.0.0.1:${proxy.address().port}`}});
 const passport=fp.localPassport({fingerprintMode:'local'},{runtimeVersion:browser.version()}),profile=fp.profileFromPassport('network-fixture',passport);
 const context=await browser.newContext({...mobileContextOptions(profile),ignoreHTTPSErrors:true});await createMobileContext(browser,profile,undefined,context);const endpoint=`https://localhost:${server.address().port}/api/all`;
 const actual=await observeNetworkTransport(context,profile,{endpoint,runtimeVersion:browser.version(),proxyScheme:'http'});
 assert.equal(actual.status,'measured',JSON.stringify(actual));assert.equal(actual.samples.length,2);assert.equal(actual.comparison.status,'reference_missing');assert.equal(actual.androidDeviceConfirmed,false);assert.ok(upstreams>0);
 const h3=await observeHttp3(context,{endpoint});assert.equal(h3.status,'not_observed');assert.equal(h3.reason,'tcp_fallback_observed');
 const failed=await observeNetworkTransport(context,profile,{endpoint:'https://localhost:1/api/all',timeoutMs:300});assert.equal(failed.status,'unavailable');assert.equal(failed.androidDeviceConfirmed,false);
 assert.doesNotMatch(JSON.stringify(actual),/private/);await context.close();
 const cancelled=new AbortController();cancelled.abort();const c=await browser.newContext();assert.equal((await observeNetworkTransport(c,profile,{endpoint,signal:cancelled.signal})).reason,'cancelled');await c.close();
 }finally{await browser?.close();for(const s of sockets)s.destroy();if(proxy)await new Promise(r=>proxy.close(r));if(server)await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
