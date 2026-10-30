import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { join } from 'node:path';
import { poolFixture } from './helpers/pool-fixture.mjs';
import { runTask } from '../worker/runner.mjs';
const listen=s=>new Promise(r=>s.listen(0,'127.0.0.1',r));
const close=s=>new Promise(r=>{s.closeAllConnections();s.close(r);});
test('successful browser IP observation validates warmup connectivity; failed/off probes retain checks', {timeout:120000},async()=>{
 const f=await poolFixture();let donor,proxy;
 try {
  await f.db.settings.update({where:{id:1},data:{fingerprintMode:'local'}});let checks=0;
  donor=createServer((req,res)=>{
   if(req.url.startsWith('/ip')){res.writeHead(200,{'Content-Type':'application/json'});res.end('{"ip":"198.51.100.7"}');return;}
   if(req.url.startsWith('/unavailable')){checks++;res.writeHead(503);res.end('Diagnostic website unavailable');return;}
   res.writeHead(200,{'Content-Type':'text/html','Set-Cookie':'fixture=state; Path=/; Max-Age=3600'});res.end('<main>Configured local donor</main><script>localStorage.setItem("fixture","state")</script>');
  });await listen(donor);
  proxy=createServer((req,res)=>{const url=new URL(req.url);if(url.hostname!=='127.0.0.1'||Number(url.port)!==donor.address().port){res.writeHead(502);res.end();return;}const headers={...req.headers};delete headers['proxy-authorization'];const upstream=request(url,{method:req.method,headers},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res);});res.once('close',()=>upstream.destroy());upstream.on('error',()=>{res.writeHead(502);res.end();});req.pipe(upstream);});await listen(proxy);
  const origin=`http://127.0.0.1:${donor.address().port}`,row=await f.db.proxy.update({where:{id:f.proxy.id},data:{port:proxy.address().port}});
  const config={profilesDirectory:join(f.dir,'profiles'),chromiumExecutablePath:process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH,headless:true,motionMode:'off',navigationTimeoutMs:3000,proxyScheme:'http',proxyCheckUrl:origin+'/unavailable',proxyIPCheckMode:'required',proxyIPCheckUrl:origin+'/ip',proxyIPCheckTimeoutMs:3000};
  async function task(){return f.db.task.create({data:{project:{connect:{id:f.project.id}},taskType:'warmup',url:'',targetExecutions:1,profile:{create:{name:'Connectivity fixture'}}}});}
  let warmups=0;const warmupRunner=async page=>{warmups++;await page.goto(origin+'/donor');};
  assert.equal(await runTask({prisma:f.db,task:await task(),proxy:row,config,warmupRunner}),true);assert.equal(warmups,1);assert.equal(checks,0);
  await assert.rejects(runTask({prisma:f.db,task:await task(),proxy:row,config:{...config,proxyIPCheckMode:'off'},warmupRunner}),{code:'proxy_check_failed'});assert.equal(checks,1);assert.equal(warmups,1);
  await assert.rejects(runTask({prisma:f.db,task:await task(),proxy:row,config:{...config,proxyIPCheckUrl:origin+'/unavailable'},warmupRunner}),{code:'proxy_ip_check_failed'});assert.equal(warmups,1);
 }finally{if(proxy)await close(proxy);if(donor)await close(donor);await f.cleanup();}
});
