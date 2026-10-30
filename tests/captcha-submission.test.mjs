import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {chromium} from 'playwright';
import {createCaptchaHandler} from '../worker/captcha-page.mjs';

const main=readFileSync(new URL('./fixtures/captcha-main.png',import.meta.url)).toString('base64');
const instruction=readFileSync(new URL('./fixtures/captcha-instruction.png',import.meta.url)).toString('base64');
for(const mode of ['background-post','automatic-fetch','pending-response','ignored-button']) {
 test(`captcha submission distinguishes ${mode} and does not buy a solution on transport timeout`,{timeout:20000},async()=>{
  let paid=0,metrics=0,submissions=0,clicks=0;const events=[];
  const provider=createServer((req,res)=>{res.setHeader('content-type','application/json');req.resume();req.on('end',()=>res.end(JSON.stringify(req.url==='/createTask'?{errorId:0,taskId:++paid}:{errorId:0,status:'ready',solution:{coordinates:[{x:80,y:90}]}})));});
  await new Promise(r=>provider.listen(0,'127.0.0.1',r));let browser;
  try{
   browser=await chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
   await context.route('**/*',async route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/metrics'){metrics++;return route.fulfill({body:'ok'});}
    if(path==='/button-click'){clicks++;return route.fulfill({body:'ok'});}
    if(path==='/checkcaptcha'){submissions++;if(mode==='automatic-fetch')await new Promise(r=>setTimeout(r,1100));return route.fulfill({body:'ok'}).catch(()=>{});}
    if(path==='/search/')return route.fulfill({contentType:'text/html; charset=utf-8',body:'<h1>Results</h1>'});
    if(path!=='/showcaptcha')return route.abort();
    const send="fetch('/checkcaptcha',{method:'POST'}).then(()=>"+(mode==='pending-response'?"{}":"location.href='/search/'")+")";
    return route.fulfill({contentType:'text/html; charset=utf-8',body:`<meta name="viewport" content="width=device-width,initial-scale=1"><img id="main" src="data:image/png;base64,${main}" onclick="fetch('/metrics',{method:'POST'});${mode==='automatic-fetch'?send:''}"><img src="data:image/png;base64,${instruction}"><button onclick="fetch('/button-click',{method:'POST'});${mode==='ignored-button'?'':send}">Отправить</button>`});
   });
   const page=await context.newPage();await page.goto('https://ya.ru/showcaptcha');
   const check=createCaptchaHandler({prisma:{settings:{findUnique:async()=>({rucaptchaApiKey:'fixture-key'})}},config:{captchaV2BaseUrl:`http://127.0.0.1:${provider.address().port}`,captchaPollingMs:20,captchaTimeoutMs:3000,captchaWidgetWaitMs:50,captchaMaxSolves:3,navigationTimeoutMs:mode==='automatic-fetch'?2000:500},shouldContinue:async()=>true,taskId:'fixture',log:(event,data)=>events.push({event,...data}),navigationPolicy:{allowCaptchaPost(){},clearCaptchaPost(){}}});
   if(['pending-response','ignored-button'].includes(mode))await assert.rejects(check(page),{code:mode==='ignored-button'?'submission_not_sent':'submission_timeout'});
   else {assert.equal(await check(page),true);assert.equal(page.url(),'https://ya.ru/search/');}
   assert.equal(paid,1);assert.equal(metrics,1);assert.equal(submissions,mode==='ignored-button'?0:1);
   assert.equal(clicks,mode==='automatic-fetch'?0:mode==='ignored-button'?2:1);
   assert.equal(events.filter(e=>e.event==='captcha_submission_started').length,mode==='ignored-button'?0:1);
   assert.ok(!events.some(e=>e.event==='captcha_retrying'));
  }finally{await browser?.close();await new Promise(r=>provider.close(r));}
 });
}
