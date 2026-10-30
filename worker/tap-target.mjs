import {performance} from 'node:perf_hooks';
import {sleep} from './behavior.mjs';
import {touchTap} from './touch-tap.mjs';
import {sampleTapDuration} from './touch-trajectory.mjs';

/** Hit-tested fragment coordinates in the locator's own frame, without bypassing actionability. */
export async function safeTapPoint(locator,timeout=1000){
 return locator.evaluate(el=>{
  const bounds=el.getBoundingClientRect(),style=getComputedStyle(el);
  const borderX=parseFloat(style.borderLeftWidth)||0,borderY=parseFloat(style.borderTopWidth)||0;
  let clip={left:0,right:innerWidth,top:0,bottom:innerHeight};
  for(let p=el.parentElement;p;p=p.parentElement){const s=getComputedStyle(p),r=p.getBoundingClientRect();if(/auto|scroll|hidden|clip/.test(s.overflowX)){clip.left=Math.max(clip.left,r.left+p.clientLeft);clip.right=Math.min(clip.right,r.left+p.clientLeft+p.clientWidth);}if(/auto|scroll|hidden|clip/.test(s.overflowY)){clip.top=Math.max(clip.top,r.top+p.clientTop);clip.bottom=Math.min(clip.bottom,r.top+p.clientTop+p.clientHeight);}}
  const interactive='a[href],button,input,select,textarea,[role="button"],[role="slider"],[contenteditable="true"]';
  const hits=(x,y)=>{const hit=document.elementFromPoint(x,y);if(!hit||!el.contains(hit))return false;const nested=hit.closest(interactive);return !nested||nested===el||!el.contains(nested);};
  const candidates=[];
  for(const r of [...el.getClientRects()].slice(0,40)){
   const left=Math.max(r.left,clip.left),right=Math.min(r.right,clip.right),top=Math.max(r.top,clip.top),bottom=Math.min(r.bottom,clip.bottom);
   if(right-left<.5||bottom-top<.5)continue;
   const mx=Math.min(3,(right-left)/5),my=Math.min(3,(bottom-top)/5);
   for(const ry of [.5,.25,.75,.1,.9])for(const rx of [.5,.25,.75,.1,.9]){
    const x=Math.max(left+mx,Math.min(right-mx,left+(right-left)*rx)),y=Math.max(top+my,Math.min(bottom-my,top+(bottom-top)*ry));
    if(!hits(x,y))continue;
    const clearance=Math.min(5,x-left,right-x,y-top,bottom-y);
    if(![[x-clearance,y],[x+clearance,y],[x,y-clearance],[x,y+clearance]].every(([px,py])=>hits(px,py)))continue;
    candidates.push({x:x-bounds.left-borderX,y:y-bounds.top-borderY,score:clearance*10-Math.abs(rx-.5)-Math.abs(ry-.5)});
   }
  }
  candidates.sort((a,b)=>b.score-a.score);return candidates[0]||null;
 },undefined,{timeout:Math.max(1,timeout)});
}
export async function activateAtSafePoint(locator,{timeout=15000,signal,touch=true,random,durationMs=sampleTapDuration(random),beforeInput}={}){
 const end=performance.now()+timeout,left=()=>Math.max(1,end-performance.now());let revealed=false;
 const timeoutSignal=AbortSignal.timeout(Math.max(1,Math.ceil(timeout)));
 const inputSignal=signal?AbortSignal.any([signal,timeoutSignal]):timeoutSignal;
 while(performance.now()<end){
  signal?.throwIfAborted();
  try{
   await locator.waitFor({state:'visible',timeout:Math.min(200,left())});
   let point=await safeTapPoint(locator,left());
   if(!point&&!revealed){
    const offscreen=await locator.evaluate(el=>{const r=el.getBoundingClientRect();return r.bottom<=0||r.top>=innerHeight||r.right<=0||r.left>=innerWidth;},undefined,{timeout:left()});
    if(offscreen){await locator.scrollIntoViewIfNeeded({timeout:Math.min(1000,left())});revealed=true;point=await safeTapPoint(locator,left());}
   }
   if(point){
    signal?.throwIfAborted();
    // Refresh hit testing immediately before input; actionability still checks stability/coverage.
    point=await safeTapPoint(locator,left());
    if(point){
     const options={timeout:left(),position:{x:point.x,y:point.y},scroll:'none',signal:inputSignal};
     if(!touch){await beforeInput?.(locator);await locator.click({...options,delay:durationMs});return;}
     // Retain Playwright's enabled/stable/coverage checks, including ancestor frames.
     // Pin the element so a replacement cannot receive the tap.
     const element=await locator.elementHandle({timeout:left()});
     if(!element)continue;
     try{
      await element.tap({...options,trial:true});
      point=await safeTapPoint(element,left());
      if(!point)continue;
      const box=await element.boundingBox();
      const border=await element.evaluate(el=>{const s=getComputedStyle(el);return {x:parseFloat(s.borderLeftWidth)||0,y:parseFloat(s.borderTopWidth)||0};});
      if(!box)continue;
      await beforeInput?.(element);
      // boundingBox uses the main viewport, including for elements inside iframes.
      await touchTap(locator.page(),box.x+border.x+point.x,box.y+border.y+point.y,{signal:inputSignal,durationMs,random});
      return;
     }finally{await element.dispose();}
    }
   }
  }catch(error){signal?.throwIfAborted();if(timeoutSignal.aborted)break;if(error.name!=='TimeoutError')throw error;}
  await sleep(Math.min(50,left()),signal);
 }
 const error=new Error('No accessible point for element input within the action timeout');error.name='TimeoutError';throw error;
}
