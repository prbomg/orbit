import test from 'node:test';
import assert from 'node:assert/strict';
import policy from '../utils/cookieAge.js';
import {observeCookies} from '../worker/cookie-observation.mjs';
const cookies={...policy,observeCookies};
const hour=3600000,t=Date.parse('2026-10-14T00:00:00Z');
const pair=()=>[{name:'_ym_d',value:'1',domain:'example.test',path:'/',expires:-1},{name:'yandexuid',value:'opaque-id',domain:'.yandex.ru',path:'/',expires:-1}];
test('cookie age uses observed time, preserves unchanged identities and resets replacements',()=>{
 const first=cookies.observeCookies(pair(),[],t);assert.equal(cookies.assessCookieAge(first,72,t).status,'waiting');
 assert.equal(cookies.assessCookieAge(first,72,t+72*hour).status,'passed');assert.equal(cookies.assessCookieAge(first,96,t+72*hour).status,'waiting');
 assert.deepEqual(cookies.observeCookies(pair(),first,t+hour),first);
 const replaced=pair();replaced[1].value='replacement';const next=cookies.observeCookies(replaced,first,t+72*hour);
 assert.equal(cookies.assessCookieAge(next,72,t+72*hour).status,'waiting');assert.equal(next[0].firstSeenAt,first[0].firstSeenAt);assert.doesNotMatch(JSON.stringify(next),/replacement|opaque-id/);
 assert.equal(cookies.assessCookieAge([],72,t).status,'missing');assert.equal(cookies.assessCookieAge([],0,t).status,'disabled');
 const expired=pair();expired[0].expires=t/1000-1;assert.equal(cookies.assessCookieAge(cookies.observeCookies(expired,first,t),72,t).status,'missing');
 const future=first.map(c=>({...c,firstSeenAt:new Date(t+hour).toISOString()}));assert.equal(cookies.assessCookieAge(future,72,t).status,'missing');
});

test('final warmup publishes young cookies and waits without consuming retries or holding a proxy',async()=>{
 const {poolFixture}=await import('./helpers/pool-fixture.mjs'),{default:pool}=await import('../utils/profilePool.js');
 const {claimWarmup}=await import('../worker/pool-scheduler.mjs'),{executeWarmup}=await import('../worker/warmup-service.mjs');
 const old=process.env.ORBIT_COOKIE_MIN_AGE_HOURS,dir=process.env.WORKER_PROFILES_DIR;process.env.ORBIT_COOKIE_MIN_AGE_HOURS='72';process.env.WORKER_PROFILES_DIR='';
 const f=await poolFixture();let published=0;
 try{
  await f.db.settings.update({where:{id:1},data:{warmupPlanPreset:'storage'}});
  await f.db.$transaction(tx=>pool.createProfileBatch(tx,{count:1}));const claim=await claimWarmup(f.db);assert.ok(claim);
  const evidence=cookies.observeCookies(pair());
  await executeWarmup({prisma:f.db,claim,config:{},signal:new AbortController().signal,log:()=>{},runner:async({commitRun,beforeCommit})=>{await beforeCommit();const r=await f.db.$transaction(tx=>commitRun(tx,async()=>{published++},{sessionCheck:{cookieObservations:evidence},cookiesCount:2}));return r.count===1;}});
  const job=await f.db.warmupJob.findUnique({where:{id:claim.job.id}});assert.equal(published,1);assert.equal(job.status,'waiting_stage');assert.equal(job.stage,'cookie_age_wait');assert.equal(job.attempts,0);assert.equal(job.owner,null);assert.ok(job.nextStageAt.getTime()>Date.now()+71*hour);assert.equal(await f.db.workflowLease.count({where:{owner:claim.owner}}),0);
  const profile=await f.db.profile.findUnique({where:{id:claim.job.profileId}});assert.equal(profile.status,'needs_check');assert.equal(profile.readinessVersion,0);
 }finally{await f.cleanup();if(old===undefined)delete process.env.ORBIT_COOKIE_MIN_AGE_HOURS;else process.env.ORBIT_COOKIE_MIN_AGE_HOURS=old;if(dir===undefined)delete process.env.WORKER_PROFILES_DIR;else process.env.WORKER_PROFILES_DIR=dir;}
});
