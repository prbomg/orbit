import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { checkProxyIP, observeBrowserIP, parsePublicIP, ipCheckURL, ProxyIPCheckError } from '../worker/proxy-ip.mjs';
import { appendTaskLiveEvent, flushLiveView } from '../worker/live-view.mjs';
import journal from '../utils/warmupJournal.js';
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const close=server=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);});

test('IP parsing accepts IPv4/IPv6, canonicalizes IPv6 and rejects raw HTML or oversized responses',()=>{
 assert.equal(parsePublicIP('{"ip":"198.51.100.7"}'),'198.51.100.7');
 assert.equal(parsePublicIP('  2001:db8::1\n'),'2001:db8::1');
 assert.equal(parsePublicIP('{"ip":"2001:0db8:0:0:0:0:0:1"}'),'2001:db8::1');
 for(const value of ['<html>198.51.100.7</html>','{"ip":123}','{"ip":"secret"}','{"ip":null}','x'.repeat(4097)])assert.throws(()=>parsePublicIP(value),ProxyIPCheckError);
 assert.throws(()=>ipCheckURL('http://example.org/'));
 assert.throws(()=>ipCheckURL('https://user:secret@example.org/'));
 assert.equal(ipCheckURL('http://127.0.0.1:1234/ip').hostname,'127.0.0.1');
});

async function proxyFixture(run,{persistent=false}={}){
 let directHits=0,proxyHits=0,targetViaProxy=0,ip='198.51.100.7';
 const username='fixture-user',password='fixture-password',auth='Basic '+Buffer.from(`${username}:${password}`).toString('base64');
 const target=createServer((req,res)=>{
  if(req.url.startsWith('/ip')){directHits++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ip:'203.0.113.10'}));return;}
  if(req.headers['x-fixture-proxy'])targetViaProxy++;
  res.end('<h1>Task page</h1>');
 });await listen(target);const url=`http://127.0.0.1:${target.address().port}`;
 const proxy=createServer((req,res)=>{
  if(req.headers['proxy-authorization']!==auth){res.writeHead(407,{'Proxy-Authenticate':'Basic realm="fixture"'});res.end();return;}
  const dest=new URL(req.url);if(dest.host!==new URL(url).host){res.writeHead(403);res.end();return;}
  if(dest.pathname==='/ip'){proxyHits++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ip}));return;}
  const headers={...req.headers,'x-fixture-proxy':'1'};delete headers['proxy-authorization'];
  const upstream=request(dest,{method:req.method,headers},response=>{res.writeHead(response.statusCode,response.headers);response.pipe(res);});
  upstream.on('error',()=>{res.writeHead(502);res.end();});req.pipe(upstream);
 });proxy.on('connect',(_req,socket)=>{socket.on('error',()=>{});socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');});await listen(proxy);
 const proxyData={id:randomUUID(),host:'127.0.0.1',port:proxy.address().port,username,password};
 const options={headless:true,executablePath:process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH||undefined,args:['--proxy-bypass-list=<-loopback>'],proxy:{server:`http://127.0.0.1:${proxyData.port}`,username,password}};
 const directory=await mkdtemp(join(tmpdir(),'orbit-proxy-ip-'));let browser,context;
 try{
  if(persistent){context=await chromium.launchPersistentContext(directory,options);browser=context.browser();}else{browser=await chromium.launch(options);context=await browser.newContext();}
  await run({context,url,proxyData,counts:()=>({directHits,proxyHits,targetViaProxy}),changeIP:next=>{ip=next;},stopProxy:()=>close(proxy)});
 }finally{await browser?.close();await close(proxy);await close(target);await rm(directory,{recursive:true,force:true});}
}

for(const persistent of [false,true])test(`actual task context uses authenticated proxy (${persistent?'persistent':'ordinary'}) and detects repeated/changed IP`,async()=>{
 await proxyFixture(async({context,url,proxyData,counts,changeIP})=>{
  const page=await context.newPage();await page.goto(url+'/task');assert.equal(await page.locator('h1').innerText(),'Task page');
  const history=new Map(),logs=[],options={proxy:proxyData,config:{proxyIPCheckMode:'required',proxyIPCheckUrl:url+'/ip'},history,log:(event,data)=>logs.push({event,...data})};
  const first=await checkProxyIP(context,options);assert.equal(first.browserIp,'198.51.100.7');assert.equal(first.workerIp,'203.0.113.10');assert.equal(first.routeComparison,'differs_from_worker');assert.equal(first.ipComparison,'first_observation');
  assert.equal((await checkProxyIP(context,options)).ipComparison,'unchanged');changeIP('198.51.100.8');
  const last=await checkProxyIP(context,options);assert.equal(last.ipComparison,'changed');assert.equal(last.previousIp,'198.51.100.7');
  assert.equal(page.url(),url+'/task');assert(counts().targetViaProxy>=1);assert.equal(counts().proxyHits,3);assert.equal(counts().directHits,3);
  assert(!JSON.stringify(logs).includes(proxyData.password));assert.equal(context.pages().filter(p=>p.url().includes('/ip')).length,0);
 },{persistent});
});

test('unavailable proxy never silently falls back to a direct browser request; required mode fails',async()=>{
 await proxyFixture(async({context,url,proxyData,counts,stopProxy})=>{
  await stopProxy();const logs=[],options={proxy:proxyData,config:{proxyIPCheckMode:'warn',proxyIPCheckUrl:url+'/ip',proxyIPCheckTimeoutMs:1000},log:(event,data)=>logs.push({event,...data})};
  assert.equal(await checkProxyIP(context,options),null);assert(logs.some(e=>e.event==='proxy_ip_check_failed'));
  await assert.rejects(checkProxyIP(context,{...options,config:{...options.config,proxyIPCheckMode:'required'}}),ProxyIPCheckError);
  // Only the TWO intentionally direct worker comparisons reach the origin.
  assert.equal(counts().directHits,2);assert.equal(counts().proxyHits,0);
 });
});

test('probe timeout/cancellation releases the diagnostic page, including late page creation',async()=>{
 let release,closed=0;const context={newPage:()=>new Promise(resolve=>{release=resolve;})};
 await assert.rejects(observeBrowserIP(context,{timeoutMs:20}),e=>e.reason==='timeout');
 release({close:async()=>{closed++;}});await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,1);
 const controller=new AbortController();const page={goto:()=>new Promise(()=>{}),close:async()=>{closed++;}};
 const pending=observeBrowserIP({newPage:async()=>page},{signal:controller.signal,timeoutMs:1000});controller.abort();
 await assert.rejects(pending,{name:'AbortError'});assert(closed>=2);
});

test('matching worker/browser IP is recorded as ambiguous, not diagnosed as bypass',async()=>{
 const logs=[],fakePage={goto:async()=>({ok:()=>true,text:async()=>'{"ip":"198.51.100.7"}'}),close:async()=>{}};
 const result=await checkProxyIP({newPage:async()=>fakePage},{proxy:{id:'same',host:'proxy.test',port:8000},history:new Map(),log:(event,data)=>logs.push({event,...data}),fetchImpl:async()=>new Response('{"ip":"198.51.100.7"}')});
 assert.equal(result.routeComparison,'matches_worker');assert(logs.some(e=>e.event==='proxy_ip_matches_worker'));
});

test('browser measurement and direct worker comparison can use independent endpoints',async()=>{
 const seen=[];
 const context={newPage:async()=>({goto:async url=>{seen.push(['browser',new URL(url).origin]);return {ok:()=>true,text:async()=>'{"ip":"198.51.100.7"}'};},close:async()=>{}})};
 const result=await checkProxyIP(context,{proxy:{id:'separate-endpoints'},history:new Map(),
  config:{proxyIPCheckUrl:'https://browser-echo.example/ip',directIPCheckUrl:'https://worker-echo.example/ip'},
  fetchImpl:async url=>{seen.push(['worker',new URL(url).origin]);return new Response('{"ip":"203.0.113.10"}');}});
 assert.deepEqual(seen.sort(([a],[b])=>a.localeCompare(b)),[['browser','https://browser-echo.example'],['worker','https://worker-echo.example']]);
 assert.equal(result.browserIp,'198.51.100.7');assert.equal(result.workerIp,'203.0.113.10');assert.equal(result.routeComparison,'differs_from_worker');
});

test('live and warmup journals retain IP diagnostics and exclude credentials',async()=>{
 const runId=randomUUID(),taskId=randomUUID(),executionId=randomUUID(),directory=resolve('.orbit-runtime','live',runId);
 const details={executionId,browserIp:'2001:db8::1',workerIp:'203.0.113.10',previousIp:'198.51.100.7',proxyHost:'proxy.example.test',proxyPort:8000,ipComparison:'changed',routeComparison:'differs_from_worker',password:'fixture-password',username:'fixture-user',rotationUrl:'https://rotation.test/?secret=fixture'};
 try{
  appendTaskLiveEvent(runId,taskId,'proxy_ip_observed',details);
  await flushLiveView(runId);
  const text=await readFile(join(directory,executionId+'.jsonl'),'utf8'),record=JSON.parse(text.trim());
  assert.equal(record.browserIp,details.browserIp);assert.equal(record.previousIp,details.previousIp);assert.equal(record.proxyHost,details.proxyHost);assert(!text.includes('fixture'));
  const warmup=journal.journalEntry({profileId:'fixture'},'proxy_ip_observed',details);
  assert.equal(warmup.details.browserIp,details.browserIp);assert(!JSON.stringify(warmup.details).includes('fixture'));
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('an unavailable IP diagnostic does not consume warmup attempts or quarantine a working proxy',async()=>{
 const {poolFixture}=await import('./helpers/pool-fixture.mjs');
 const {claimWarmup,finishClaim}=await import('../worker/pool-scheduler.mjs');
 const {default:pool}=await import('../utils/profilePool.js');
 const f=await poolFixture();
 try{
  await f.db.$transaction(tx=>pool.createProfileBatch(tx,{count:1}));
  const claim=await claimWarmup(f.db);assert(claim);
  await finishClaim(f.db,claim,{errorCode:'proxy_ip_check_failed'});
  const job=await f.db.warmupJob.findUniqueOrThrow({where:{id:claim.job.id}});
  assert.equal(job.status,'retry_wait');assert.equal(job.attempts,0);assert.equal(job.dependencyRetries,1);
  assert.equal((await f.db.profile.findUniqueOrThrow({where:{id:claim.job.profileId}})).status,'queued');
  assert.equal(await f.db.workflowLease.count({where:{key:{startsWith:'cooldown:'}}}),0);
 }finally{await f.cleanup();}
});

test('disabled IP checks do not create pages or send network requests',async()=>{
 const events=[];
 const result=await checkProxyIP({newPage:()=>{throw Error('Unexpected page');}},{proxy:{id:'disabled'},config:{proxyIPCheckMode:'off'},fetchImpl:()=>{throw Error('Unexpected network');},log:event=>events.push(event)});
 assert.equal(result,null);assert.deepEqual(events,['proxy_ip_check_skipped']);
});

test('network snapshot stays bound to its execution after the IP event leaves the recent log',async()=>{
 const {default:network}=await import('../utils/proxyNetwork.js');
 const runId=randomUUID(),taskId=randomUUID(),first=randomUUID(),second=randomUUID(),directory=resolve('.orbit-runtime','live',runId);
 try{
  appendTaskLiveEvent(runId,taskId,'proxy_configured',{executionId:first,proxyId:'one',proxyHost:'proxy.test',proxyPort:8000,proxyScheme:'http',password:'private'});
  appendTaskLiveEvent(runId,taskId,'proxy_ip_observed',{executionId:first,browserIp:'198.51.100.7',workerIp:'203.0.113.10'});
  appendTaskLiveEvent(runId,taskId,'proxy_ip_observed',{executionId:second,browserIp:'198.51.100.8'});
  for(let i=0;i<150;i++)appendTaskLiveEvent(runId,taskId,'action_started',{executionId:first,step:i});
  await flushLiveView(runId);
  const a=JSON.parse(await readFile(join(directory,first+'.network.json'),'utf8'));
  await flushLiveView(runId);
  const b=JSON.parse(await readFile(join(directory,second+'.network.json'),'utf8'));
  assert.equal(a.executionId,first);assert.equal(a.browserIp,'198.51.100.7');assert.equal(a.proxyHost,'proxy.test');assert.equal(a.proxyScheme,'http');assert.equal(a.password,undefined);
  assert.equal(b.executionId,second);assert.equal(b.browserIp,'198.51.100.8');
  await flushLiveView(runId);
  const recent=(await readFile(join(directory,first+'.jsonl'),'utf8')).trim().split('\n').slice(-120);
  assert(!recent.some(line=>line.includes('198.51.100.7')));
  appendTaskLiveEvent(runId,taskId,'proxy_ip_check_started',{executionId:first});
  await flushLiveView(runId);
  assert.equal(JSON.parse(await readFile(join(directory,first+'.network.json'),'utf8')).browserIp,undefined);
  assert.equal(network.networkSnapshot({browserIp:'invalid',password:'private'}),null);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('transient browser network failure gets one bounded retry without changing proxy',async()=>{
 let pages=0;const events=[];
 const context={newPage:async()=>{pages++;const attempt=pages;return {goto:async()=>{if(attempt===1)throw Error('net::ERR_CONNECTION_RESET at a private URL');return {ok:()=>true,text:async()=>'{"ip":"198.51.100.7"}'};},close:async()=>{}};}};
 const result=await checkProxyIP(context,{proxy:{id:'retry',host:'proxy.test',port:8000},history:new Map(),log:(event,data)=>events.push({event,...data}),fetchImpl:async()=>new Response('{"ip":"203.0.113.10"}')});
 assert.equal(result.browserIp,'198.51.100.7');assert.equal(pages,2);assert(events.some(e=>e.event==='proxy_ip_check_retry'&&e.reason==='err_connection_reset'));assert(!JSON.stringify(events).includes('private URL'));
});
