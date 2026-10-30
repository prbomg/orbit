import {poolFixture} from '../tests/helpers/pool-fixture.mjs';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {createHash,randomBytes} from 'node:crypto';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const f=await poolFixture({wal:true});let server,browser;
try{
 const reservation=createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));const base=`http://127.0.0.1:${port}`;
 const user=await f.db.authUser.create({data:{email:'seo@uniofweb.ru',passwordHash:'synthetic-disabled'}}),token=randomBytes(32).toString('hex');
 await f.db.authSession.create({data:{tokenHash:createHash('sha256').update(token).digest('hex'),userId:user.id,expiresAt:new Date(Date.now()+300000)}});
 server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port',String(port)],{env:{...process.env,DATABASE_URL:`file:${f.dir}/test.db`,APP_ORIGIN:base,AUTH_EMAIL:'seo@uniofweb.ru',WORKER_PROFILES_DIR:f.dir,ORBIT_NETWORK_PROBE_URL:'https://collector.invalid/api/all'},stdio:'ignore'});
 for(let i=0;i<100;i++){try{if((await fetch(base+'/login/')).status===200)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 const path=`${base}/api/proxies/${f.proxy.id}/transport/`,headers={Cookie:`orbit_session=${token}`,'Content-Type':'application/json'},body=JSON.stringify({action:'measure'});
 assert.equal((await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body})).status,401);
 assert.equal((await fetch(path,{method:'POST',headers:{...headers,Origin:'https://untrusted.invalid'},body})).status,403);
 assert.equal((await fetch(path,{method:'POST',headers,body:JSON.stringify({action:'measure',endpoint:'https://untrusted.invalid'})})).status,400);
 await f.db.workflowLease.create({data:{key:'proxy:endpoint:127.0.0.1:8000',owner:'test-proxy-busy',expiresAt:new Date(Date.now()+300000)}});
 const busy=await fetch(path,{method:'POST',headers,body});assert.equal(busy.status,409,await busy.text());
 await f.db.proxy.update({where:{id:f.proxy.id},data:{isActive:false}});
 assert.equal((await fetch(path,{method:'POST',headers,body})).status,409);
 assert.equal(await f.db.profile.count(),0);assert.equal(await f.db.workflowLease.count({where:{owner:{startsWith:'network-diagnostic:'}}}),0);
 browser=await chromium.launch({headless:true,executablePath:process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH});const context=await browser.newContext({viewport:{width:390,height:844}});await context.addCookies([{name:'orbit_session',value:token,url:base}]);const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.name));
 await page.goto(base+'/proxies/');await page.getByRole('button',{name:'TCP-пресет прокси 127.0.0.1:8000'}).click();await page.getByRole('button',{name:'Проверить TLS / HTTP2 / HTTP3'}).waitFor();assert.equal(await page.getByRole('button',{name:'Проверить TLS / HTTP2 / HTTP3'}).isDisabled(),true);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);
 console.log('PASS authenticated network API, origin/body validation, proxy busy/inactive protection, no profile persistence, mobile UI');
}finally{await browser?.close();if(server){server.kill('SIGTERM');await new Promise(r=>server.once('close',r));}await f.cleanup();}
