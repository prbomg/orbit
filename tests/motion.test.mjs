import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chromium } from 'playwright';
import { createMotionModel, motionAtTime, orientationQuaternion, multiplyQuaternion, GRAVITY } from '../worker/motion-model.mjs';
import { startMotionEmulation, motionDiagnostics, MOTION_SENSORS } from '../worker/motion-emulation.mjs';
const norm = v => Math.hypot(v.x,v.y,v.z);
const close = (a,b,tolerance=1e-8)=>assert.ok(Math.abs(a-b)<tolerance,`${a} differs from ${b}`);

test('quiet-held model is smooth, bounded and obeys acceleration and angular-velocity units',()=>{
 for(const seed of ['first','second','third']){
  const model=createMotionModel(seed);let previous;
  for(let i=0;i<2000;i++){
   const t=i/20, r=motionAtTime(model,t);
   close(Math.hypot(r.quaternion.x,r.quaternion.y,r.quaternion.z,r.quaternion.w),1);
   close(norm(r.gravity),GRAVITY);assert.ok(norm(r.gyroscope)<0.03);assert.ok(norm(r.linearAcceleration)<0.18);
   for(const key of ['alpha','beta','gamma']){assert.ok(Math.abs(r.angles[key]-model.base[key])<=0.25);if(previous)assert.ok(Math.abs(r.angles[key]-previous.angles[key])<0.05);}
   for(const key of ['x','y','z'])close(r.accelerometer[key]-r.linearAcceleration[key],r.gravity[key]);
   const step=0.0001,q=r.quaternion,next=motionAtTime(model,t+step).quaternion;
   const dq=multiplyQuaternion({x:-q.x,y:-q.y,z:-q.z,w:q.w},next);
   for(const key of ['x','y','z'])close(dq[key]*2/step,r.gyroscope[key],0.00001);
   previous=r;
  }
 }
 assert.notDeepEqual(createMotionModel('first'),createMotionModel('second'));
 assert.throws(()=>motionAtTime(createMotionModel(),Infinity),RangeError);
});

test('portrait and flat postures use the Device Orientation Z-X-Y convention',()=>{
 const model=createMotionModel('pose');model.angular=model.angular.map(()=>[]);model.translation=model.translation.map(()=>[]);
 model.base={alpha:0,beta:0,gamma:0};let r=motionAtTime(model,0);close(r.gravity.z,GRAVITY);close(r.gravity.y,0);
 model.base.beta=90;r=motionAtTime(model,0);close(r.gravity.y,GRAVITY);close(r.gravity.z,0);
 model.base={alpha:90,beta:0,gamma:90};r=motionAtTime(model,0);close(r.gravity.x,-GRAVITY);
 assert.deepEqual(orientationQuaternion({alpha:0,beta:0,gamma:0}),{x:0,y:0,z:0,w:1});
});

async function fixture(run,{blocked=false}={}){
 const browser=await chromium.launch({headless:true,executablePath:process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH||undefined});
 try{
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  await context.route('https://sensor.test/**',route=>route.fulfill({contentType:'text/html',headers:blocked?{'Permissions-Policy':'accelerometer=(), gyroscope=(), magnetometer=()'}:{},body:'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><h1>Local sensor fixture</h1>'}));
  await run(context);
 }finally{await browser.close();}
}
async function observe(page){
 await page.evaluate(()=>{
  window.readings={orientation:[],motion:[],generic:{},errors:{}};
  addEventListener('deviceorientation',e=>{if(readings.orientation.length<300)readings.orientation.push({alpha:e.alpha,beta:e.beta,gamma:e.gamma,trusted:e.isTrusted});});
  addEventListener('devicemotion',e=>{if(readings.motion.length<300)readings.motion.push({acc:{x:e.acceleration?.x,y:e.acceleration?.y,z:e.acceleration?.z},gravity:{x:e.accelerationIncludingGravity?.x,y:e.accelerationIncludingGravity?.y,z:e.accelerationIncludingGravity?.z},rotation:{alpha:e.rotationRate?.alpha,beta:e.rotationRate?.beta,gamma:e.rotationRate?.gamma},trusted:e.isTrusted});});
  window.activeSensors=[];
  for(const name of ['Accelerometer','Gyroscope','GravitySensor','LinearAccelerationSensor','RelativeOrientationSensor','AbsoluteOrientationSensor']){
   try{const s=new window[name]({frequency:20});activeSensors.push(s);s.addEventListener('reading',e=>readings.generic[name]={x:s.x,y:s.y,z:s.z,q:s.quaternion,trusted:e.isTrusted});s.addEventListener('error',e=>readings.errors[name]=e.error.name);s.start();}catch(e){readings.errors[name]=e.name;}
  }
 });
}

test('CDP supplies native changing orientation, motion and Generic Sensor readings on HTTPS',async()=>{
 await fixture(async context=>{
  const controller=startMotionEmulation(context,{model:createMotionModel('native')});
  try{
   const page=await context.newPage();await controller.prepare(page);assert.equal(motionDiagnostics(page).state,'active');
   await page.goto('https://sensor.test/');await observe(page);
   await page.waitForFunction(()=>readings.orientation.length>10&&readings.motion.length>10&&Object.keys(readings.generic).length===6,{},{timeout:5000});
   await page.waitForFunction(()=>new Set(readings.orientation.map(r=>`${r.alpha},${r.beta},${r.gamma}`)).size>1,{},{timeout:5000});
   const r=await page.evaluate(()=>readings);assert.deepEqual(r.errors,{});
   assert.ok(r.orientation.every(e=>e.trusted&&e.beta>49&&e.beta<76));
   assert.ok(r.motion.every(e=>e.trusted));
   const m=r.motion.at(-1);assert.ok(norm(m.gravity)>9.6&&norm(m.gravity)<10);
   assert.ok(norm(m.acc)<0.3);assert.ok(Math.hypot(m.rotation.alpha,m.rotation.beta,m.rotation.gamma)<2);
   assert.ok(Object.values(r.generic).every(s=>s.trusted));
   assert.ok(norm(r.generic.Gyroscope)>0);
   close(Math.hypot(...r.generic.RelativeOrientationSensor.q),1,1e-6);
   for(const key of ['x','y','z'])close(r.generic.Accelerometer[key]-r.generic.GravitySensor[key],r.generic.LinearAccelerationSensor[key],0.21);
   // CDP sensor values survive a navigation; page constructors are untouched.
   await page.goto('https://sensor.test/next');await observe(page);
   await page.waitForFunction(()=>readings.orientation.length>2&&readings.generic.Gyroscope,{},{timeout:5000});
  }finally{await controller.stop();}
 });
});

test('session motion follows additional pages and abort releases all overrides',async()=>{
 await fixture(async context=>{
  const abort=new AbortController();const controller=startMotionEmulation(context,{signal:abort.signal});
  const first=await context.newPage();await controller.prepare(first);await first.goto('https://sensor.test/');await observe(first);
  const second=await context.newPage();await controller.prepare(second);await second.goto('https://sensor.test/second');await observe(second);
  await second.waitForFunction(()=>readings.orientation.length>2&&readings.generic.Gyroscope,{},{timeout:5000});
  assert.equal(motionDiagnostics(first).state,'active');assert.equal(motionDiagnostics(second).state,'active');
  await first.close();abort.abort();await controller.stop();assert.equal(motionDiagnostics(second).state,'stopped');
  const third=await context.newPage();await controller.prepare(third);assert.equal(motionDiagnostics(third).state,'disabled');
 });
});

test('sensor emulation leaves site Permissions Policy restrictions in force',async()=>{
 await fixture(async context=>{
  const controller=startMotionEmulation(context);
  try{
   const page=await context.newPage();await controller.prepare(page);await page.goto('https://sensor.test/blocked');await observe(page);
   await page.waitForFunction(()=>Object.keys(readings.errors).length===6,{},{timeout:3000});
   const r=await page.evaluate(()=>readings);assert.deepEqual(r.generic,{});assert.ok(Object.values(r.errors).every(e=>e==='SecurityError'));
  }finally{await controller.stop();}
 },{blocked:true});
});

test('off mode makes no CDP changes and unsupported methods degrade without failing the session',async()=>{
 const page=new EventEmitter();page.isClosed=()=>false;const context=new EventEmitter();context.pages=()=>[page];const commands=[];let detached=0;
 context.newCDPSession=async()=>({send:async(name,args)=>{commands.push({name,...args});if(name==='Target.getTargetInfo')return{targetInfo:{browserContextId:'fixture'}};if(args.enabled&&args.type==='gyroscope')throw new Error("Emulation.setSensorOverrideEnabled wasn't found");},detach:async()=>{detached++;}});
 const off=startMotionEmulation(context,{mode:'off'});await off.prepare(page);assert.equal(motionDiagnostics(page).state,'disabled');await off.stop();assert.equal(commands.length,0);
 const controller=startMotionEmulation(context);await controller.prepare(page);assert.equal(motionDiagnostics(page).state,'unavailable');
 assert.equal(motionDiagnostics(page).reason,'motion_cdp_unsupported');
 assert.equal(commands.filter(c=>c.enabled===false).length,MOTION_SENSORS.length-1);assert.equal(detached,1);
 await controller.stop();assert.equal(context.listenerCount('page'),0);
});

test('motion is dynamic and does not alter the passport, fingerprint checks or saved device state',async()=>{
 const {mkdtemp,readFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {createMobileContext,createMobilePage,stageMobileProfile}=await import('../worker/profiles.mjs');
 const {inspectFingerprint}=await import('../worker/fingerprint-check.mjs');const {default:fp}=await import('../utils/fingerprint.js');
 const dir=await mkdtemp(join(tmpdir(),'orbit-motion-'));
 const browser=await chromium.launch({headless:true,executablePath:process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH||undefined});
 try{
  const passport=fp.localPassport({fingerprintMode:'local'});fp.chromeMetadata(passport.fingerprint,passport.headers,browser.version(),passport.fingerprint.navigator.userAgentData.model,passport.fingerprint.navigator.userAgentData.platformVersion);
  const profile=fp.profileFromPassport('motion-identity',passport);const original=structuredClone(passport);const hash=fp.identityHash(profile.profileId,passport);let previous;
  for(const seed of ['session-one','session-two']){
   const context=await createMobileContext(browser,profile);const controller=startMotionEmulation(context,{model:createMotionModel(seed)});
   try{
    const page=await createMobilePage(context,profile);await controller.prepare(page);
    const report=await inspectFingerprint(page,profile,previous,browser.version());assert.equal(report.status,'passed');assert.equal(report.dynamic.motion.state,'active');assert.equal(report.dynamic.motion.mode,'simulated');assert.equal(report.checks.motion,undefined);
    await page.evaluate(()=>{document.cookie='saved=fixture; path=/';});
    const staged=await stageMobileProfile(dir,profile,context);await staged.publish();
    const saved=JSON.parse(await readFile(join(dir,'motion-identity.json'),'utf8'));assert.deepEqual(Object.keys(saved.runtime),['battery']);assert.equal(saved.fingerprint.motion,undefined);assert.equal(saved.fingerprint.gyroscope,undefined);
    assert.equal(fp.identityHash(profile.profileId,passport),hash);assert.deepEqual(passport,original);previous=report;
   }finally{await controller.stop();await context.close();}
  }
 }finally{await browser.close();await rm(dir,{recursive:true,force:true});}
});

test('unsupported sensor emulation does not fail constant fingerprint verification',async()=>{
 const {createMobileContext,createMobilePage}=await import('../worker/profiles.mjs');const {inspectFingerprint}=await import('../worker/fingerprint-check.mjs');const {default:fp}=await import('../utils/fingerprint.js');
 const browser=await chromium.launch({headless:true,executablePath:process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH||undefined});
 try{
  const passport=fp.localPassport({fingerprintMode:'local'});fp.chromeMetadata(passport.fingerprint,passport.headers,browser.version(),passport.fingerprint.navigator.userAgentData.model,passport.fingerprint.navigator.userAgentData.platformVersion);
  const profile=fp.profileFromPassport('motion-unsupported',passport);const context=await createMobileContext(browser,profile);
  const factory=context.newCDPSession.bind(context);context.newCDPSession=async page=>{const cdp=await factory(page),send=cdp.send.bind(cdp);cdp.send=(name,...args)=>name.startsWith('Emulation.setSensor')?Promise.reject(new Error("Emulation.setSensorOverrideEnabled wasn't found")):send(name,...args);return cdp;};
  const controller=startMotionEmulation(context);
  try{
   const page=await createMobilePage(context,profile);await controller.prepare(page);const report=await inspectFingerprint(page,profile,null,browser.version());
   assert.equal(report.status,'passed');assert.equal(report.dynamic.motion.state,'unavailable');assert.equal(report.dynamic.motion.reason,'motion_cdp_unsupported');assert.equal(report.checks.motion,undefined);
  }finally{await controller.stop();await context.close();}
 }finally{await browser.close();}
});

test('missing shutdown replies cannot block sensor cleanup or task termination',async()=>{
 const page=new EventEmitter();page.isClosed=()=>false;const context=new EventEmitter();context.pages=()=>[page];
 context.newCDPSession=async()=>({send:async(name,args)=>{if(name==='Target.getTargetInfo')return{targetInfo:{browserContextId:'cleanup'}};if(args?.enabled===false)return new Promise(()=>{});},detach:()=>new Promise(()=>{})});
 const controller=startMotionEmulation(context);await controller.prepare(page);assert.equal(motionDiagnostics(page).state,'active');
 const start=Date.now();await controller.stop();assert.ok(Date.now()-start<2000);assert.equal(context.listenerCount('page'),0);
});

test('sensor permissions leave camera permissions unchanged and remain unavailable on insecure origins',async()=>{
 await fixture(async context=>{
  const page=await context.newPage();await page.goto('https://sensor.test/permission');
  const before=await page.evaluate(async()=>({camera:(await navigator.permissions.query({name:'camera'})).state,microphone:(await navigator.permissions.query({name:'microphone'})).state}));
  const controller=startMotionEmulation(context);await controller.prepare(page);
  try{
   const after=await page.evaluate(async()=>({camera:(await navigator.permissions.query({name:'camera'})).state,microphone:(await navigator.permissions.query({name:'microphone'})).state}));assert.deepEqual(after,before);
   await context.route('http://insecure.test/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><h1>Insecure fixture</h1>'}));
   await page.goto('http://insecure.test/');assert.equal(await page.evaluate(()=>isSecureContext),false);assert.equal(await page.evaluate(()=>typeof Gyroscope),'undefined');
  }finally{await controller.stop();}
 });
});
