import test from 'node:test';
import assert from 'node:assert/strict';
import { createBehaviorRandom, behaviorRandom, withBehaviorRandom } from '../worker/behavior-random.mjs';
import { sampleKeystrokeDelay } from '../worker/keystroke-cadence.mjs';

test('seeded behavior is reproducible and session streams are isolated across awaits', async () => {
 const sample = seed => { const random = createBehaviorRandom(seed); return Array.from({length:100}, random); };
 assert.deepEqual(sample('same'), sample('same'));
 assert.notDeepEqual(sample('same'), sample('different'));
 const runs = await Promise.all(['a','a','b'].map(seed => withBehaviorRandom(createBehaviorRandom(seed), async () => { const first=behaviorRandom(); await Promise.resolve(); return [first,behaviorRandom()]; })));
 assert.deepEqual(runs[0], runs[1]); assert.notDeepEqual(runs[0], runs[2]);
 assert.throws(() => createBehaviorRandom(''), /invalid_behavior_seed/);
});
test('seeded cadence retains 45–380 bounds and median near 110 ms', () => {
 const random=createBehaviorRandom('cadence'), samples=Array.from({length:20000},()=>sampleKeystrokeDelay('a','b',random)).sort((a,b)=>a-b);
 assert.ok(samples[0]>=45 && samples.at(-1)<=380);
 assert.ok(samples[10000]>=105 && samples[10000]<=115);
});

test('production behavior modules have no global Math.random fallback',async()=>{
 const {readFile}=await import('node:fs/promises');
 for(const name of ['behavior','touch-tap','touch-trajectory','tap-target','mobile-input','scroll-surface','site-behavior','search','search-preview-policy','keystroke-cadence','warmup']){
  assert.doesNotMatch(await readFile(new URL(`../worker/${name}.mjs`,import.meta.url),'utf8'),/Math\.random/);
 }
});

test('target visits use their session generator before drawing duration and retain scope across callbacks', async () => {
 const {interactWithTargetSite}=await import('../worker/search.mjs');
 const run=async(seed, explicit=false)=>{
  let time=0;const values=[], random=createBehaviorRandom(seed);
  const session={random:explicit?undefined:random,now:()=>time+=10000,log:()=>{},document:async()=>{await Promise.resolve();values.push(behaviorRandom());}};
  const result=await interactWithTargetSite({url:()=> 'https://fixture.test/'},{targetDomain:'fixture.test',visitSettings:{minSeconds:1,maxSeconds:2,maxInternalTransitions:0}},session,explicit?{random}:{});
  return {...result,values};
 };
 await withBehaviorRandom(()=>.99,async()=>{
  assert.deepEqual(await run('session'),await run('session',true));
  assert.notDeepEqual(await run('session'),await run('another'));
  assert.equal(behaviorRandom(),.99,'nested session restores its caller scope');
 });
});

test('search entry preserves an explicit or inherited random scope across cancellation and cleanup', async () => {
 const {performSearchAndClick}=await import('../worker/search.mjs');
 const context={pages:()=>[],on(){},off(){},route:async()=>{},unroute:async()=>{await Promise.resolve();seen.push(behaviorRandom());}};
 const page={context:()=>context,on(){},off(){}};let seen=[];
 const task={id:'random-fixture',taskType:'search',searchEngine:'yandex',targetDomain:'fixture.test',searchQueries:['fixture'],vitalPhrases:[]};
 for(const supplied of [()=>.25,undefined,behaviorRandom]){
  seen=[];
  await withBehaviorRandom(()=>.75,async()=>{
   await assert.rejects(performSearchAndClick(page,task,{random:supplied,shouldContinue:async()=>{await Promise.resolve();seen.push(behaviorRandom());return false;},log:()=>{seen.push(behaviorRandom());}}));
   assert.ok(seen.length>=2);assert.ok(seen.every(value=>value===(supplied && supplied !== behaviorRandom ? .25 : .75)));
   assert.equal(behaviorRandom(),.75);
  });
 }
});
