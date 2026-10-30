import {performance} from 'node:perf_hooks';
import {sleep} from './behavior.mjs';
export async function actionSnapshot(page){
 return page.evaluate(()=>{
  const main=document.querySelector('main,[role="main"]');
  // Generic dialogs, navigation counters and body animations are not proof of a page change.
  const content=main?`${main.querySelector('h1,h2')?.textContent||''}\n${main.innerText}`.replace(/\b\d[\d:.,/-]*\b/g,'#').replace(/\s+/g,' ').trim().slice(0,8000):null;
  return {url:location.href,content};
 });
}
export function changedContent(before,after){return Boolean(before.content&&after.content&&before.content!==after.content);}
export async function waitActionResult(page,before,{timeout=3000,signal,check=async()=>{}}={}){
 const end=performance.now()+timeout;let candidate=null,since=0,last=before;
 const snapshot=async()=>{
  let timer;
  try{return await Promise.race([actionSnapshot(page),new Promise(resolve=>{timer=setTimeout(()=>resolve(null),Math.max(1,end-performance.now()));})]);}
  finally{clearTimeout(timer);}
 };
 while(performance.now()<end){
  signal?.throwIfAborted();await check();
  if(page.url().split('#')[0]!==before.url.split('#')[0])return {result:'url_changed',after:{url:page.url()}};
  let after;try{after=await snapshot();}catch(error){if(!/Execution context was destroyed|Cannot find context/.test(error.message))throw error;await sleep(Math.min(50,Math.max(1,end-performance.now())),signal);continue;}
  if(!after)break;
  last=after;
  if(after.url.split('#')[0]!==before.url.split('#')[0])return {result:'url_changed',after};
  if(changedContent(before,after)){
   if(candidate!==after.content){candidate=after.content;since=performance.now();}
   else if(performance.now()-since>=150)return {result:'content_changed',after};
  }else candidate=null;
  await sleep(Math.min(75,Math.max(1,end-performance.now())),signal);
 }
 return {result:'no_change',after:last};
}
