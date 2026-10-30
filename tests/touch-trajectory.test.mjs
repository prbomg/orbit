import test from 'node:test';import assert from 'node:assert/strict';import {gestureProfile,dispatchTouchPath,sampleTapDuration,touchCurve,swipeProgress,inertiaProfile,inertiaDistance,MAX_LATERAL_WOBBLE,createTouchContact} from '../worker/touch-trajectory.mjs';
test('distance selects precise, reading and flick profiles with bounded duration',()=>{assert.equal(gestureProfile(40).mode,'precise');assert.equal(gestureProfile(300).mode,'reading');assert.equal(gestureProfile(900).mode,'flick');assert(gestureProfile(80).durationMs>gestureProfile(20).durationMs);assert(gestureProfile(500).maxDistance<=420);assert.throws(()=>gestureProfile(10,{mode:'bad'}));});
test('delayed sends drop obsolete path samples instead of a catch-up burst',async()=>{let time=0;const events=[];const result=await dispatchTouchPath(async p=>{events.push({time,...p});time+=90;},{fromX:10,fromY:500,toX:10,toY:200,durationMs:300,now:()=>time,wait:async ms=>{time+=ms;}});assert(events.length<=4);assert.equal(events.at(-1).y,200);assert.equal(events.filter(p=>p.y===200).length,1);assert(events.every((e,i)=>!i||e.time-events[i-1].time>=90));assert.equal(result.moves,events.length);});
test('cancellation stops moves before the final endpoint',async()=>{let time=0;const controller=new AbortController(),points=[];await assert.rejects(dispatchTouchPath(async p=>{points.push(p);controller.abort();},{fromX:0,fromY:500,toX:0,toY:0,durationMs:300,signal:controller.signal,now:()=>time,wait:async ms=>{time+=ms;}}),{name:'AbortError'});assert.equal(points.length,1);assert(points[0].y>0);});

function seededRandom(seed=12345){return ()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};}

test('swipe contacts vary between gestures and stay elliptical, smooth and bounded during movement',()=>{
 const random=seededRandom(),starts=[];
 for(let gesture=0;gesture<1000;gesture++){
  const contact=createTouchContact(random),start=contact(10,100);starts.push(start);
  assert(start.radiusX>=11&&start.radiusX<=15.5);assert(start.radiusY>=12&&start.radiusY<=17);assert(start.force>=.42&&start.force<=.78);
  let previous=start;const shapes=new Set();
  for(let i=0;i<100;i++){
   const point=contact(10+i,100-i);
   assert.equal(point.x,10+i);assert.equal(point.y,100-i);assert.equal(point.id,start.id);
   assert(point.radiusY>point.radiusX);assert(point.force>=0&&point.force<=1);
   assert(Math.abs(point.radiusX-start.radiusX)<=.300001);assert(Math.abs(point.radiusY-start.radiusY)<=.300001);assert(Math.abs(point.force-start.force)<=.020001);
   assert(Math.abs(point.radiusX-previous.radiusX)<=.300001);assert(Math.abs(point.radiusY-previous.radiusY)<=.300001);assert(Math.abs(point.force-previous.force)<=.020001);
   shapes.add(JSON.stringify([point.radiusX,point.radiusY,point.force]));previous=point;
  }
  assert(shapes.size>1);
 }
 assert.equal(new Set(starts.map(p=>JSON.stringify([p.radiusX,p.radiusY,p.force]))).size,starts.length);
 for(const value of [0,1]){const contact=createTouchContact(()=>value);for(let i=0;i<1000;i++){const p=contact(0,i);assert(p.radiusY>p.radiusX&&p.force>=0&&p.force<=1);}}
});

test('tap durations have a 90 ms median, positive holds and a bounded long tail',()=>{
 const random=seededRandom();const durations=Array.from({length:20000},()=>sampleTapDuration(random)).sort((a,b)=>a-b);
 assert(durations[0]>=50);assert(durations.at(-1)<=350);
 assert(Math.abs(durations[10000]-90)<=2);
 const tail=durations.filter(ms=>ms>200).length/durations.length;
 assert(tail>.025&&tail<.07);assert(durations.filter(ms=>ms<=200).length/durations.length>.9);
 assert.equal(sampleTapDuration(()=>0),350);
});

test('reading and flick durations use their own ranges while explicit durations stay usable',()=>{
 const random=seededRandom();
 for(const pixels of [300,900,-300,-900]){
  const durations=Array.from({length:1000},()=>gestureProfile(pixels,{random}).durationMs);
  const [minimum,maximum]=Math.abs(pixels)>740*.8?[95,190]:[180,420];
  assert(Math.min(...durations)>=minimum);assert(Math.max(...durations)<=maximum);
  assert(Math.max(...durations)-Math.min(...durations)>(maximum-minimum)*.9);
 }
 assert.equal(gestureProfile(300,{durationMs:160}).durationMs,160);
 for(const durationMs of [NaN,Infinity,0,-1])assert.throws(()=>gestureProfile(300,{durationMs}),RangeError);
});

test('cubic touch paths wobble on both sides inside the corridor and keep exact endpoints',async()=>{
 for(const [fromY,toY] of [[600,200],[200,600]]){
  let time=0;const points=[];
  const result=await dispatchTouchPath(async p=>points.push(p),{fromX:100,fromY,toX:100,toY,durationMs:1000,random:()=>.5,now:()=>time,wait:async ms=>{time+=ms;}});
  assert(points.some(p=>p.x>100.5));assert(points.some(p=>p.x<99.5));
  assert(points.every(p=>Math.abs(p.x-100)<=MAX_LATERAL_WOBBLE));
  assert(points.every((p,i)=>!i||(p.y-points[i-1].y)*Math.sign(toY-fromY)>0));
  assert.deepEqual(points.at(-1),{x:100,y:toY});
  assert.equal(Math.sign(result.releaseVelocityY),Math.sign(toY-fromY));
 }
 const zero=touchCurve({fromX:10,fromY:20,toX:10,toY:20});assert(zero.every(p=>p.x===10&&p.y===20));
});

test('every swipe mode accelerates and decelerates, with residual energy only outside precise mode',()=>{
 for(const mode of ['precise','reading','flick']){
  const delta=t=>swipeProgress(t+.01,mode)-swipeProgress(t,mode);
  assert(delta(.5)>delta(0));assert(delta(.5)>delta(.99));
  assert.equal(swipeProgress(0,mode),0);assert(Math.abs(swipeProgress(1,mode)-1)<1e-12);
 }
 assert(swipeProgress(1,'reading')-swipeProgress(.999,'reading')>.0005);
 assert(swipeProgress(1,'precise')-swipeProgress(.999,'precise')<.00001);
});

test('inertia scales with squared release speed and decays exponentially in either direction',()=>{
 const slow=inertiaProfile(200),fast=inertiaProfile(400);
 assert.equal(fast.distance,slow.distance*4);
 assert.equal(inertiaProfile(-200).distance,-slow.distance);
 assert.equal(inertiaDistance(slow,0),0);assert.equal(inertiaDistance(inertiaProfile(0),100),0);
 const first=inertiaDistance(slow,slow.tauMs),second=inertiaDistance(slow,2*slow.tauMs)-first;
 assert(Math.abs(second/first-Math.exp(-1))<1e-12);
 assert(inertiaDistance(slow,slow.durationMs)>slow.distance*.99);
 assert.equal(inertiaProfile(10000,{maxDistance:120}).distance,120);
 assert.throws(()=>inertiaProfile(NaN),RangeError);
});
