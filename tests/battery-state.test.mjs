import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { chromium } from 'playwright';
import fp from '../utils/fingerprint.js';
import state from '../utils/batteryState.js';
import { createMobileContext, createMobilePage, stageMobileProfile, loadMobileProfile } from '../worker/profiles.mjs';
import { inspectFingerprint } from '../worker/fingerprint-check.mjs';
import { normalizeDeviceIdentities } from '../scripts/normalize-device-identity.mjs';
import { poolFixture } from './helpers/pool-fixture.mjs';
import { batteryRuntimeScript } from '../worker/battery-runtime.mjs';

test('identity excludes battery and provider diagnostics, but still detects changed hardware', () => {
  const p=fp.localPassport({fingerprintMode:'local'}), changed=structuredClone(p);
  assert.equal(p.fingerprint.battery,undefined);
  changed.fingerprint.battery={level:0.01,charging:true};changed.providerScore=10;changed.createdAt='2026-01-01T00:00:00.000Z';changed.fallbackReason='other';
  assert.equal(fp.identityHash('profile',p),fp.identityHash('profile',changed));
  changed.fingerprint.navigator.userAgentData.model='Another model';
  assert.notEqual(fp.identityHash('profile',p),fp.identityHash('profile',changed));
  assert.notEqual(fp.identityHash('another-profile',p),fp.identityHash('profile',p));
});

test('battery follows elapsed time across sessions, preserving a legacy starting value', () => {
  const profile=fp.profileFromPassport('battery',fp.localPassport());
  profile.fingerprint.battery={level:0.7,charging:false};
  const model=state.createBatteryModel(profile), created=Date.parse(profile.createdAt);
  assert.equal(state.batteryAtTime(model,created).level,0.7);
  assert.ok(state.batteryAtTime(model,created+600000).level<0.7);
  assert.deepEqual(state.createBatteryModel({...profile,runtime:{battery:model}}),model);
  const empty=model.cycleStartedAt+model.dischargeSeconds*1000;
  assert.equal(state.batteryAtTime(model,empty).level,model.minLevel);
  assert.equal(state.batteryAtTime(model,empty).charging,true);
  const full=empty+model.chargeSeconds*1000;
  assert.equal(state.batteryAtTime(model,full).level,1);
  assert.equal(state.batteryAtTime(model,full).charging,false);
  for(let hour=0;hour<72;hour++) {
    const b=state.batteryAtTime(model,created+hour*3600000);
    assert.ok(b.level>=model.minLevel&&b.level<=1);
    assert.ok(b.charging ? Number.isFinite(b.chargingTime)&&b.chargingTime>0 : b.chargingTime===Infinity);
  }
});

test('battery events follow simulated changes and repeated reads return the same manager', async () => {
  let now=Date.parse('2026-01-01T00:00:00.000Z'), tick;
  const model={version:1,mode:'simulated',cycleStartedAt:now,dischargeSeconds:28800,chargeSeconds:7200,minLevel:0.15};
  const navigator={getBattery:async()=>({})};
  runInNewContext(batteryRuntimeScript(model),{navigator,Date:{now:()=>now},EventTarget,Event,setInterval:fn=>{tick=fn;}});
  const battery=await navigator.getBattery();assert.equal(await navigator.getBattery(),battery);
  let listeners=0,handlers=0;battery.addEventListener('levelchange',()=>listeners++);battery.onlevelchange=()=>handlers++;
  tick();assert.equal(listeners,0);
  now+=600000;tick();assert.equal(listeners,1);assert.equal(handlers,1);assert.ok(battery.level<1);
  tick();assert.equal(listeners,1);
});

test('browser battery changes with time, persists outside the fingerprint, and never gates readiness', async () => {
  const browser=await chromium.launch({headless:true,executablePath:process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH});
  const dir=await mkdtemp(join(tmpdir(),'orbit-battery-'));
  try {
    const passport=fp.localPassport({fingerprintMode:'local'});
    fp.chromeMetadata(passport.fingerprint,passport.headers,browser.version(),passport.fingerprint.navigator.userAgentData.model,passport.fingerprint.navigator.userAgentData.platformVersion);
    const profile=fp.profileFromPassport('battery-browser',passport);
    const start=Date.parse('2026-01-01T00:00:00.000Z');
    profile.fingerprint.battery={level:0.01,charging:true}; // Old snapshot must not be used for verification.
    profile.runtime={battery:{version:1,mode:'simulated',cycleStartedAt:start,dischargeSeconds:28800,chargeSeconds:7200,minLevel:0.15}};
    const context=await createMobileContext(browser,profile);
    await context.route('https://battery.invalid/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><main>Battery fixture</main>'}));
    const page=await createMobilePage(context,profile);await page.clock.install({time:new Date(start+3600000)});
    await page.goto('https://battery.invalid/');
    const readBattery=()=>page.evaluate(async()=>{const b=await navigator.getBattery();return{level:b.level,charging:b.charging,same:b===await navigator.getBattery()};});
    const before=await readBattery();assert.equal(before.same,true);assert.equal(before.charging,false);
    await page.evaluate(()=>{document.cookie='state=preserved; path=/';localStorage.setItem('state','preserved');});
    await page.clock.runFor(600000);
    const after=await readBattery();assert.ok(after.level<before.level);
    const previous=await inspectFingerprint(page,profile,null,browser.version());
    assert.equal(previous.status,'passed');assert.equal(previous.checks.battery,undefined);assert.equal(previous.dynamic.battery.mode,'simulated');
    await page.goto('https://battery.invalid/again');assert.equal((await readBattery()).level,after.level,'navigation must not reset the battery');
    const staged=await stageMobileProfile(dir,profile,context);await staged.publish();await context.close();
    const file=JSON.parse(await readFile(join(dir,'battery-browser.json'),'utf8'));
    assert.equal(file.fingerprint.battery,undefined);assert.deepEqual(file.runtime,profile.runtime);
    assert.equal(file.cookies.find(c=>c.name==='state').value,'preserved');
    const restored=(await loadMobileProfile(dir,'battery-browser')).profile;
    const second=await createMobileContext(browser,restored);const next=await createMobilePage(second,restored);
    await next.clock.install({time:new Date(start+4200000)});
    const result=await inspectFingerprint(next,restored,previous,browser.version());
    assert.equal(result.status,'passed');assert.equal(result.observed.battery.level,after.level);
    const evaluate=next.evaluate.bind(next);next.evaluate=async(...args)=>({...await evaluate(...args),battery:null});
    const missing=await inspectFingerprint(next,restored,result,browser.version());
    assert.equal(missing.status,'passed');assert.equal(missing.dynamic.battery.supported,false);assert.equal(missing.checks.battery,undefined);
    await second.close();
  } finally {await browser.close();await rm(dir,{recursive:true,force:true});}
});

test('existing identity normalization preserves device parameters, warmup progress and readiness status', async () => {
  const f=await poolFixture();
  try {
    const passport=fp.localPassport();passport.fingerprint.battery={level:0.8,charging:false};
    const row=await f.db.profile.create({data:{name:'Legacy battery',status:'queued',fingerprint:passport,fingerprintHash:'old',fingerprintState:'verified',fingerprintCheck:{status:'passed',checkedAt:new Date().toISOString(),checks:{cpu:true,screen:true,battery:true},warnings:[],observed:{battery:{level:0.8,charging:false}}},warmupJob:{create:{status:'waiting_stage',currentStage:3,totalStages:4,stage:'stage_3_waiting',nextStageAt:new Date(Date.now()+3600000)}}},include:{warmupJob:true}});
    assert.equal((await normalizeDeviceIdentities(f.db)).updated,1);
    assert.equal((await f.db.profile.findUnique({where:{id:row.id}})).fingerprintHash,'old','dry run must not write');
    await normalizeDeviceIdentities(f.db,{apply:true});
    const updated=await f.db.profile.findUnique({where:{id:row.id},include:{warmupJob:true}});
    assert.deepEqual(updated.fingerprint.fingerprint,fp.deviceFingerprint(passport.fingerprint));
    assert.equal(updated.fingerprintHash,fp.identityHash(row.id,passport));assert.equal(updated.fingerprintCheck.checks.battery,undefined);
    assert.equal(updated.fingerprintState,'verified');assert.equal(updated.status,'queued');assert.equal(updated.warmedAt,null);
    assert.deepEqual(updated.warmupJob,row.warmupJob);
    assert.equal((await normalizeDeviceIdentities(f.db,{apply:true})).updated,0);
  } finally {await f.cleanup();}
});
