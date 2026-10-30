import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { performWarmup, selectAvailableDonorSites } from '../worker/warmup.mjs';

test('donor availability prioritizes recent success, explores unknown sites and defers recent failures', () => {
 const now=Date.now();const sites=Array.from({length:16},(_,i)=>`https://donor${i}.example.org/`);
 const event=(i,event,age)=>({event,createdAt:new Date(now-age),details:{domain:`donor${i}.example.org`}});
 const history=[event(0,'warmup_site_completed',1000),event(1,'warmup_site_completed',1000),event(2,'warmup_site_completed',1000),event(3,'warmup_site_skipped',1000),event(3,'warmup_site_completed',2000),event(4,'warmup_site_skipped',1000),event(99,'warmup_site_completed',1000)];
 for(let sample=0;sample<20;sample++){
  const selected=selectAvailableDonorSites(sites,12,history,now);
  assert.equal(selected.length,12);assert.equal(new Set(selected).size,12);
  assert(selected.every(site=>sites.includes(site)));
  assert(selected.slice(0,2).every(site=>sites.slice(0,3).includes(site)));
  assert(!sites.slice(0,5).includes(selected[2]),'one untested site is explored');
  assert(!selected.includes(sites[3]));assert(!selected.includes(sites[4]));
 }
 const onlyThree=sites.slice(0,3);
 const deferred=selectAvailableDonorSites(onlyThree,3,[event(0,'warmup_site_skipped',1000)],now);
 assert.equal(deferred.at(-1),sites[0],'failed sites remain a fallback when the pool is small');
 const expired=selectAvailableDonorSites(onlyThree,3,[event(0,'warmup_site_completed',25*60*60_000)],now);
 assert.deepEqual(new Set(expired),new Set(onlyThree));
});

test('warmup can replace nine failed donors and still requires three successful visits',async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH});
 try{
  const context=await browser.newContext();const page=await context.newPage();const events=[];
  const sites=Array.from({length:12},(_,i)=>`http://127.0.0.1:${19200+i}/`);
  await context.route('**/*',route=>route.fulfill({status:Number(new URL(route.request().url()).port)<19209?503:200,contentType:'text/html',body:'<!doctype html><main style="height:3000px">Local fixture</main>'}));
  await performWarmup(page,{sites,navigationTimeoutMs:3000,chooseSites:(pool,count)=>{assert.equal(count,12);return pool.slice(0,count);},waitFor:async()=>{},log:(event,data)=>events.push({event,...data})});
  assert.equal(events.filter(e=>e.event==='warmup_site_skipped').length,9);
  assert.equal(events.filter(e=>e.event==='warmup_site_completed').length,3);
 }finally{await browser.close();}
});
test('unavailable donor sites are replaced, and success still requires three visited sites',async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH});
 try{
  const sites=Array.from({length:6},(_,index)=>`http://127.0.0.1:${19000+index}/`);
  for(const available of [3,2]){
   const context=await browser.newContext();const page=await context.newPage();const events=[];
   await context.route('**/*',route=>{
    const index=Number(new URL(route.request().url()).port)-19000;
    return route.fulfill({status:index<6-available?503:200,contentType:'text/html',body:'<!doctype html><main style="height:3000px">Local fixture</main>'});
   });
   const options={sites,navigationTimeoutMs:3000,chooseSites:()=>sites,waitFor:async()=>{},log:(event,data)=>events.push({event,...data})};
   if(available===3){await performWarmup(page,options);assert.equal(events.filter(e=>e.event==='warmup_site_completed').length,3);}
   else await assert.rejects(performWarmup(page,options),error=>error.code==='warmup_sites_unavailable');
   assert.equal(events.filter(e=>e.event==='warmup_site_skipped').length,6-available);
   assert.ok(events.every(e=>!('url' in e)));
   await context.close();
  }
 }finally{await browser.close();}
});

test('an error-page navigation is settled before visiting the next donor', async () => {
 const browser=await chromium.launch({headless:true,executablePath:process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH});
 try {
  const context=await browser.newContext();const page=await context.newPage();const events=[];
  const sites=Array.from({length:4},(_,index)=>`http://127.0.0.1:${19100+index}/`);
  await context.route('**/*',route=>route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><main style="height:3000px">Local fixture</main>'}));
  const originalGoto=page.goto.bind(page);let blankAttempts=0;let pendingErrorPage=false;
  page.goto=async (url,options)=>{
   if(url===sites[0]){pendingErrorPage=true;throw new Error('page.goto: net::ERR_CERT_AUTHORITY_INVALID');}
   if(url==='about:blank'){
    blankAttempts++;
    if(blankAttempts===1) throw new Error('Navigation is interrupted by another navigation to chrome-error://chromewebdata/');
    pendingErrorPage=false;
   } else assert.equal(pendingErrorPage,false,'the previous error navigation must be settled');
   return originalGoto(url,options);
  };
  await performWarmup(page,{sites,chooseSites:()=>sites,navigationTimeoutMs:3000,waitFor:async()=>{},log:(event,data)=>events.push({event,...data})});
  assert.equal(blankAttempts,2);
  assert.equal(events.filter(e=>e.event==='warmup_site_skipped').length,1);
  assert.equal(events.filter(e=>e.event==='warmup_site_completed').length,3);
 } finally {await browser.close();}
});

test('a donor link with a blocked external redirect is replaced without failing the profile session',async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH});
 try{
  const context=await browser.newContext({isMobile:true,hasTouch:true,viewport:{width:390,height:844}}),page=await context.newPage(),events=[],served=[];
  const sites=['https://redirect.test/','https://one.test/','https://two.test/','https://three.test/'];
  await context.route('**/*',async route=>{
   const url=new URL(route.request().url());served.push(url.hostname);
   if(url.hostname==='redirect.test'&&url.pathname==='/redirect')return route.fulfill({status:302,headers:{location:'https://outside.test/'}});
   return route.fulfill({contentType:'text/html',body:'<meta name="viewport" content="width=device-width,initial-scale=1">'+(url.hostname==='redirect.test'?'<a href="/redirect">Read more</a>':'')+'<main style="height:2200px">Contents</main>'});
  });
  await performWarmup(page,{sites,chooseSites:()=>sites,navigationTimeoutMs:3000,waitFor:async()=>{},log:(event,data)=>events.push({event,...data})});
  assert(events.some(e=>e.event==='warmup_site_skipped'&&e.domain==='redirect.test'&&e.reason==='site_navigation'));
  assert.equal(events.filter(e=>e.event==='warmup_site_completed').length,3);assert(!served.includes('outside.test'));
 }finally{await browser.close();}
});
