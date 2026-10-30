import {performance} from 'node:perf_hooks';
import {sleep} from './behavior.mjs';
import {activateAtSafePoint} from './tap-target.mjs';
import {gestureProfile,dispatchTouchPath,createTouchContact,dispatchTouchEvent} from './touch-trajectory.mjs';
import {planScrollSurface} from './scroll-surface.mjs';
import {finishTouchScroll} from './scroll-inertia.mjs';
import {getPageSession} from './page-session.mjs';
const inputModes=new WeakMap();
export async function usesTouch(page){
 if(!inputModes.has(page))inputModes.set(page,await page.evaluate(()=>navigator.maxTouchPoints>0&&matchMedia('(pointer: coarse)').matches));
 return inputModes.get(page);
}
export async function activateElement(locator,options={}){
 return activateAtSafePoint(locator,{...options,touch:await usesTouch(locator.page())});
}
const summary=handle=>handle.evaluate(s=>({ready:s.ready,reason:s.reason,x:s.x,fromY:s.fromY,toY:s.toY,maxDistance:s.maxDistance,lateralWobble:s.lateralWobble,pixels:s.pixels,surfaceKey:s.surfaceKey,scrollTarget:s.scrollTarget,canMove:s.canMove,height:s.box?s.box.bottom-s.box.top:0}));

/** Native gestures; each start and its entire corridor are revalidated before contact. */
async function dispatchScroll(page,pixels,options,initial){
 const {signal,check=async()=>{}}=options;signal?.throwIfAborted();await check();
 if(!(await usesTouch(page))){await page.mouse.move(initial.x,initial.fromY);await page.mouse.wheel(0,pixels);return {method:'wheel',gestures:1,gestureMode:'wheel'};}
 const profile=gestureProfile(pixels,{mode:options.mode||'auto',height:initial.height,durationMs:options.durationMs,random:options.random});
 const distance=Math.min(profile.maxDistance,initial.maxDistance),count=Math.max(1,Math.ceil(Math.abs(pixels)/distance)),length=Math.abs(pixels)/count,direction=Math.sign(pixels);
 const cdp=await getPageSession(page);let touching=false,gestures=0;const inertiaMethods=[];
 try{
  for(let index=0;index<count;index++){
   signal?.throwIfAborted();await check();
   const plan=await planScrollSurface(page,{...options,pixels:direction*length});
   try{
    const next=await summary(plan);
    if(!next.ready||next.surfaceKey!==initial.surfaceKey||Math.sign(next.pixels)!==direction)break;
    const actualLength=Math.min(length,next.maxDistance),toY=next.fromY-direction*actualLength;
    // Every contact gets its own duration, even in a multi-swipe sequence.
    const gesture=gestureProfile(pixels,{mode:profile.mode,height:initial.height,durationMs:options.durationMs,random:options.random});
    const touch=createTouchContact(options.random);
    touching=true;await dispatchTouchEvent(page,cdp,'touchStart',[touch(next.x,next.fromY)]);
    const path=await dispatchTouchPath(p=>dispatchTouchEvent(page,cdp,'touchMove',[touch(p.x,p.y)]),{fromX:next.x,fromY:next.fromY,toX:next.x,toY,durationMs:gesture.durationMs,mode:profile.mode,lateralWobble:next.lateralWobble,signal,random:options.random});
    signal?.throwIfAborted();
    // Release before reading the scroll position to preserve native fling momentum.
    await dispatchTouchEvent(page,cdp,'touchEnd',[]);touching=false;gestures++;
    const releasePosition=await plan.evaluate(s=>s.node===document.scrollingElement?scrollY:s.node.scrollTop);
    const inertia=await finishTouchScroll(plan,{releasePosition,velocity:-path.releaseVelocityY,maxDistance:actualLength,signal,check,settleTimeoutMs:options.settleTimeoutMs});
    inertiaMethods.push(inertia.method);
    if(!inertia.settled)break;
   }finally{await plan.dispose().catch(()=>{});}
  }
  return {method:'touch',gestures,gestureMode:profile.mode,inertiaMethods};
 }finally{if(touching)await dispatchTouchEvent(page,cdp,'touchCancel',[]).catch(()=>{});}
}

/** Report movement of the intended surface, never movement of an unrelated panel. */
export async function scrollPage(page,pixels,options={}){
 if(!Number.isFinite(pixels)||Math.abs(pixels)>5000)throw new RangeError('Invalid scroll distance');
 options.signal?.throwIfAborted();await options.check?.();
 if(!pixels)return {method:'none',gestures:0,result:'boundary',movedPixels:0,scrollTarget:'none'};
 const state=await planScrollSurface(page,{...options,pixels});
 try{
  const plan=await summary(state);
  if(!plan.ready)return {method:'none',gestures:0,result:plan.reason==='boundary'?'boundary':'blocked',movedPixels:0,scrollTarget:plan.scrollTarget||'none',surfaceKey:plan.surfaceKey,reason:plan.reason,settled:true};
  const requestedPixels=Math.round(plan.pixels);
  const input=await dispatchScroll(page,requestedPixels,options,plan);
  if(plan.canMove){try{await page.waitForFunction(s=>Math.abs((s.node===document.scrollingElement?scrollY:s.node.scrollTop)-s.nodes[0].top)>.5,state,{timeout:300});}catch(error){if(error.name!=='TimeoutError')throw error;}}
  const deadline=performance.now()+(options.settleTimeoutMs??400);let positions=null,stableSince=performance.now(),settled=false;
  while(performance.now()<deadline){
   options.signal?.throwIfAborted();
   const next=await state.evaluate(s=>s.nodes.map(n=>n.root?scrollY:n.el.scrollTop));
   if(!positions||next.some((value,index)=>Math.abs(value-positions[index])>1))stableSince=performance.now();positions=next;
   if(performance.now()-stableSince>=100){settled=true;break;}
   await sleep(Math.min(40,Math.max(1,deadline-performance.now())),options.signal);
  }
  options.signal?.throwIfAborted();await options.check?.();
  const movement=await state.evaluate(s=>{const intended=s.nodes[0];return {movedPixels:Math.round((intended.root?scrollY:intended.el.scrollTop)-intended.top),unrelatedMovement:s.nodes.slice(1).some(n=>Math.abs((n.root?scrollY:n.el.scrollTop)-n.top)>.5)};});
  return {...input,...movement,settled,requestedPixels,surfaceKey:plan.surfaceKey,scrollTarget:plan.scrollTarget,result:movement.movedPixels?'scrolled':plan.canMove?'blocked':'boundary'};
 }finally{await state.dispose().catch(()=>{});}
}
