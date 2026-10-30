import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,createConnection} from 'node:net';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {EventEmitter} from 'node:events';
import {startBrowserStream,LIVE_FRAMES_PER_SECOND} from '../worker/live-stream.mjs';
import events from '../utils/liveEvents.js';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(condition){for(let i=0;i<50;i++){if(condition())return;await wait(100);}throw Error('Timed out');}
test('seven-frame gate admits frames at 143 ms and rejects earlier paints', async t => {
 const dir=await mkdtemp(join(tmpdir(),'orbit-stream-gate-')),socketPath=join(dir,'view.sock');
 const cdp=new EventEmitter(),page={},frames=[];let ready=false,stop=()=>{},client;
 cdp.send=async method=>{if(method==='Page.startScreencast')ready=true;};cdp.detach=async()=>{};
 try{
  stop=startBrowserStream({newCDPSession:async()=>cdp},{socketPath,getPage:()=>page});
  await wait(50);client=createConnection(socketPath);let buffer='';
  client.on('data',chunk=>{buffer+=chunk;let at;while((at=buffer.indexOf('\n'))>=0){const msg=JSON.parse(buffer.slice(0,at));buffer=buffer.slice(at+1);if(msg.type==='frame')frames.push(msg);}});
  await until(()=>ready);
  let now=1700000000000;t.mock.method(Date,'now',()=>now);
  for(const offset of [0,100,142,143,200,285,286,429]){now=1700000000000+offset;cdp.emit('Page.screencastFrame',{data:'aGVsbG8=',sessionId:offset});}
  await until(()=>frames.length>=4);
  assert.deepEqual(frames.map(f=>f.time-1700000000000),[0,143,286,429]);
 }finally{client?.destroy();stop();t.mock.restoreAll();await rm(dir,{recursive:true,force:true});}
});
test('a CDP attach failure during navigation recovers for the same connected viewer', async () => {
 const dir=await mkdtemp(join(tmpdir(),'orbit-stream-retry-')),socketPath=join(dir,'view.sock');
 const page={},cdp=new EventEmitter();let calls=0,ready=false,stop=()=>{},client;
 cdp.send=async method=>{if(method==='Page.startScreencast')ready=true;};cdp.detach=async()=>{};
 try{
  stop=startBrowserStream({newCDPSession:async()=>{calls++;if(calls===1)throw Error('Document is changing');return cdp;}},{socketPath,getPage:()=>page});
  await wait(50);client=createConnection(socketPath);client.on('data',()=>{});
  await until(()=>ready);assert.equal(calls,2);
 }finally{client?.destroy();stop();await rm(dir,{recursive:true,force:true});}
});
test('one demand-driven CDP capture serves two viewers, throttles frames and stops on last disconnect',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'orbit-stream-')),socketPath=join(dir,'view.sock');let browser,stop=()=>{};const clients=[];
 try{
  browser=await chromium.launch({headless:true,executablePath:process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH});const context=await browser.newContext();const page=await context.newPage();
  await page.setContent('<style>@keyframes move{to{transform:translateX(200px)}}div{width:30px;height:30px;background:red;animation:move .3s infinite alternate}</style><div></div>');
  let starts=0,stops=0;const original=context.newCDPSession.bind(context);context.newCDPSession=async p=>{const cdp=await original(p),send=cdp.send.bind(cdp);cdp.send=(method,args)=>{if(method==='Page.startScreencast')starts++;if(method==='Page.stopScreencast')stops++;return send(method,args);};return cdp;};
  let allowed=true,saved=0;stop=startBrowserStream(context,{socketPath,getPage:()=>allowed?page:null,onFrame:()=>saved++});
  await wait(400);assert.equal(starts,0);assert.equal(saved,0);
  const frames=[[],[]];for(let i=0;i<2;i++){const client=createConnection(socketPath);clients.push(client);let buffer='';client.on('data',chunk=>{buffer+=chunk;let n;while((n=buffer.indexOf('\n'))>=0){const msg=JSON.parse(buffer.slice(0,n));buffer=buffer.slice(n+1);if(msg.type==='frame')frames[i].push(msg);}});}
  await until(()=>frames[0].length>=4&&frames[1].length>=4);assert.equal(starts,1);assert.ok(saved>0);
  assert.equal(LIVE_FRAMES_PER_SECOND,7);
  for(const list of frames){for(let i=1;i<list.length;i++)assert.ok(list[i].time-list[i-1].time>=Math.ceil(1000/7));}
  assert.ok(frames[0].some(f=>frames[1].some(g=>g.time===f.time&&g.data===f.data)));
  allowed=false;await until(()=>stops===1);const before=frames[0].length;await wait(400);assert.equal(frames[0].length,before);
  allowed=true;await until(()=>starts===2);clients[0].destroy();await wait(350);assert.equal(stops,1);clients[1].destroy();await until(()=>stops===2);
  const last=starts;await wait(400);assert.equal(starts,last);
 }finally{for(const client of clients)client.destroy();stop();await browser?.close();await rm(dir,{recursive:true,force:true});}
});
test('SSE retries absent worker socket, forwards fresh frames and releases viewer on abort',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'orbit-sse-')),socketPath=join(dir,'view.sock');let peer,server;const abort=new AbortController();
 try{
  const reader=events.liveEventStream({signal:abort.signal,getSocket:async()=>socketPath,retryDelay:30,lifetime:5000}).getReader();await reader.read();await wait(120);
  server=createServer(client=>{peer=client;client.on('error',()=>{});client.write(JSON.stringify({type:'frame',data:'aGVsbG8=',time:Date.now()})+'\n');});await new Promise(resolve=>server.listen(socketPath,resolve));
  let result='';for(let i=0;i<30&&!result.includes('event: frame');i++){const item=await reader.read();result+=new TextDecoder().decode(item.value);}
  assert.match(result,/event: frame/);abort.abort();await until(()=>peer?.destroyed);let item;do{item=await reader.read();}while(!item.done);assert.equal(item.done,true);
 }finally{abort.abort();if(peer)peer.destroy();if(server)await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
});
