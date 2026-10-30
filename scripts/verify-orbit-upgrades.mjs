#!/usr/bin/env node
// Read-only verification: failures are reported, never hidden by reseeding or rewriting passports.
import {randomBytes, createHash} from 'node:crypto';
import {readFileSync, readdirSync, mkdirSync, writeFileSync} from 'node:fs';
import {resolve, dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import fp from '../utils/fingerprint.js';
import catalog from '../utils/deviceCatalog.js';
import readiness from '../utils/profileReadiness.js';
import {passportValidation} from '../worker/passport-validation.mjs';
import {buildHttpClientHints, buildCdpUserAgentOverride, formatBrandList} from '../worker/client-hints.mjs';
import {mobileContextOptions} from '../worker/profiles.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2), option=name=>{const i=args.indexOf(name);return i<0?null:args[i+1];};
for(let i=0;i<args.length;i+=2)if(!['--report','--seeds'].includes(args[i])||!args[i+1])throw Error('Usage: node scripts/verify-orbit-upgrades.mjs [--report file.json] [--seeds previous-report.json]');
const json=file=>JSON.parse(readFileSync(resolve(root,file),'utf8'));
const seeds=option('--seeds')?json(option('--seeds')).seeds:Array.from({length:1000},()=>randomBytes(16).toString('hex'));
assert.equal(seeds.length,1000);assert.ok(seeds.every(s=>/^[a-f0-9]{32}$/.test(s)));assert.equal(new Set(seeds).size,1000);
const report={createdAt:new Date().toISOString(),catalogVersion:catalog.DEVICE_CATALOG.version,count:1000,seeds,checks:[],failures:[],models:{},themes:{light:0,dark:0},validationErrors:0};
const failures=new Map();
function check(name,action,detail){try{action();return true;}catch(error){const item=failures.get(name)||{check:name,count:0,examples:[]};item.count++;if(item.examples.length<5)item.examples.push({detail,error:error.message});failures.set(name,item);return false;}}
function section(name,action){const size=Array.from(failures.values()).reduce((n,x)=>n+x.count,0);action();report.checks.push({name,passed:size===Array.from(failures.values()).reduce((n,x)=>n+x.count,0)});}
const ua=/^Mozilla\/5\.0 \(Linux; Android 10; K\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\/\d+\.0\.0\.0 Mobile Safari\/537\.36$/;
const settings={fingerprintMode:'local',fingerprintDevicePreset:'mixed',fingerprintDeviceWeights:catalog.DEFAULT_WEIGHTS};
section('archive and catalog',()=>{
 check('immutable v1 archive',()=>assert.equal(createHash('sha256').update(readFileSync(resolve(root,'utils/device-catalog-archive/android-catalog-2026-10-v1.json'))).digest('hex'),'b8a4d825669ff4b8d1246cb609e22f55d304e810ee6c39e489836b7fbc7f2497'));
 check('v2 version and archived copy',()=>{assert.equal(catalog.DEVICE_CATALOG.version,'android-catalog-2026-10-v2');assert.deepEqual(json('utils/device-catalog.json'),json('utils/device-catalog-archive/android-catalog-2026-10-v2.json'));assert.equal(Object.values(catalog.DEFAULT_WEIGHTS).reduce((a,b)=>a+b,0),1000);assert.equal(catalog.DEFAULT_WEIGHTS.pixel7_android13,10);});
 for(const t of catalog.DEVICE_CATALOG.templates)check('template geometry/GPU',()=>{
  for(const dimension of ['width','height'])assert.ok(Math.abs(Math.round(t.browser[dimension]*t.browser.dpr)-t.renderScreen[dimension])<=2);
  assert.match(t.browser.renderer,t.browser.vendor==='Qualcomm'?/^Adreno\b/:/^Mali-/);assert.ok(['Qualcomm','ARM'].includes(t.browser.vendor));assert.equal(t.bitness,'64');assert.ok(t.webglLimits.maxTextureSize);assert.equal(t.webglLimits.maxViewportDims.length,2);
 },t.id);
});
section('1000 random mixed passports',()=>{
 seeds.forEach((seed,index)=>{
  const p=fp.localPassport(settings,{seed}),n=p.fingerprint.navigator,h=n.userAgentData,t=catalog.findTemplate(p.deviceTemplate.id);
  report.models[t.id]=(report.models[t.id]||0)+1;report.themes[p.fingerprint.preferences.colorScheme]++;
  const validation=passportValidation(p);report.validationErrors+=validation.errors.length;
  check('passport validation',()=>assert.deepEqual(validation.errors,[]),index);
  check('platform/UA/generation',()=>{assert.equal(n.platform,'Linux armv81');assert.equal(h.platform,'Android');assert.match(n.userAgent,ua);assert.equal(h.architecture,'');assert.equal(h.bitness,t.bitness);assert.equal(p.generation.version,'6');assert.equal(p.generation.adapter,'local-v7');assert.deepEqual(p.fingerprint.canvas,{version:1,mode:'native'});},index);
  check('HTTP and CDP',()=>{const http=buildHttpClientHints(p,true),cdp=buildCdpUserAgentOverride(p);assert.equal(http['Sec-CH-UA-Platform'],'"Android"');assert.equal(http['Sec-CH-UA-Bitness'],'"64"');assert.equal(http['Sec-CH-UA-Arch'],'""');assert.equal(http['Sec-CH-UA'],p.headers['sec-ch-ua']);assert.equal(http['Sec-CH-UA-Full-Version-List'],formatBrandList(h.fullVersionList));assert.equal(cdp.platform,'Linux armv81');assert.equal(cdp.userAgent,n.userAgent);assert.deepEqual(cdp.userAgentMetadata.brands,h.brands);assert.deepEqual(cdp.userAgentMetadata.fullVersionList,h.fullVersionList);assert.equal(cdp.userAgentMetadata.bitness,'64');},index);
  check('template GPU propagation',()=>{assert.deepEqual(p.fingerprint.webglLimits,t.webglLimits);assert.equal(p.fingerprint.gpu?.vendor,t.browser.vendor);assert.equal(p.fingerprint.gpu?.renderer,t.browser.renderer);assert.equal(p.fingerprint.gpu?.maxTextureSize,t.webglLimits.maxTextureSize);assert.deepEqual(p.fingerprint.gpu?.maxViewportDims,t.webglLimits.maxViewportDims);},t.id);
  check('seed/theme/hash reproducibility',()=>{const copy=fp.localPassport(settings,{seed});assert.equal(fp.deriveColorSchemeFromSeed(seed),p.fingerprint.preferences.colorScheme);assert.deepEqual(p.fingerprint,copy.fingerprint);assert.equal(fp.identityHash('audit',p),fp.identityHash('audit',copy));assert.match(fp.identityHash('audit',p),/^[a-f0-9]{64}$/);},index);
  check('context preferences and Service Workers',()=>{const options=mobileContextOptions(fp.profileFromPassport('audit',p));assert.equal(options.colorScheme,p.fingerprint.preferences.colorScheme);assert.equal(options.serviceWorkers,'allow');},index);
 });
});
section('population',()=>{
 report.lightPercent=report.themes.light/10;report.pixelPercent=(report.models.pixel7_android13||0)/10;
 check('light share 60–70%',()=>assert.ok(report.lightPercent>=60&&report.lightPercent<=70,String(report.lightPercent)));
 check('Pixel share <=2%',()=>assert.ok(report.pixelPercent<=2,String(report.pixelPercent)));
});
section('GREASE and native brands',()=>{
 for(const major of [84,86,134,153,154,155])check('dynamic GREASE',()=>{const p=fp.localPassport(settings,{seed:seeds[0],runtimeVersion:`${major}.0.0.1`});assert.ok(p.fingerprint.navigator.userAgentData.brands.some(b=>JSON.stringify(b)===JSON.stringify(fp.getChromiumGreaseBrand(major))));},major);
 check('native brand escaping and preservation',()=>{
  const nativeBrands=[{brand:'Chromium',version:'154'},{brand:'Not"A\\Brand',version:'24'}];
  const p=fp.localPassport(settings,{seed:seeds[0],runtimeVersion:'154.0.0.1',nativeBrands});
  assert.deepEqual(p.fingerprint.navigator.userAgentData.brands,nativeBrands);assert.equal(p.headers['sec-ch-ua'],buildHttpClientHints(p)['Sec-CH-UA']);assert.equal(passportValidation(p).status,'passed');
 });
 check('no static legacy GREASE generation',()=>assert.ok(!/brand:\s*['"]Not_A Brand['"]\s*,\s*version:\s*['"]99/.test(readFileSync(resolve(root,'utils/fingerprint.js'),'utf8')),'static GREASE remains'));
});
section('legacy identities and malformed passports',()=>{
 for(const fixture of json('tests/fixtures/device-catalog-v1-passports.json'))check('v1 saved identity',()=>{const p=fixture.passport,before=JSON.stringify(p);assert.equal(passportValidation(p).status,'passed');assert.equal(fp.legacyIdentityHash(fixture.profileId,p),fixture.identityHash);assert.equal(fp.matchesIdentityHash(fixture.profileId,p,fixture.identityHash),true);assert.equal(JSON.stringify(p),before);},fixture.profileId);
 const savedV6=json('tests/fixtures/local-v6-pre-audit-passport.json');check('saved local-v6 without GPU alias',()=>{const before=JSON.stringify(savedV6.passport);assert.equal(passportValidation(savedV6.passport).status,'passed');assert.equal(fp.legacyIdentityHash(savedV6.profileId,savedV6.passport),savedV6.identityHash);assert.equal(JSON.stringify(savedV6.passport),before);});
 const old=json('tests/fixtures/local-v5-passport.json');check('v4/v2 saved identity',()=>{assert.equal(passportValidation(old.passport).status,'passed');assert.equal(fp.legacyIdentityHash('saved-v5',old.passport),old.identityHash);});
 for(const mutate of [p=>{p.fingerprint.navigator.userAgent='not-a-browser';p.headers['user-agent']='not-a-browser';},p=>p.fingerprint.navigator.platform='Linux armv8l',p=>{p.fingerprint.navigator.userAgent='junk '+p.fingerprint.navigator.userAgent;p.headers['user-agent']=p.fingerprint.navigator.userAgent;},p=>p.fingerprint.navigator.language={},p=>p.fingerprint.navigator.userAgentData.brands=[null],p=>p.fingerprint.preferences.colorScheme='invalid',p=>{if(p.fingerprint.gpu)p.fingerprint.gpu.maxTextureSize=1;}])check('malformed passport returns failed, not exception',()=>{const p=fp.localPassport(settings,{seed:seeds[0]});mutate(p);assert.equal(passportValidation(p).status,'failed');},String(mutate));
});
section('malformed JSON field types',()=>{
 for(const field of ['userAgent','languages','language','userAgentData','platform'])for(const value of [null,42,{},[],true])check('malformed navigator field',()=>{const p=fp.localPassport(settings,{seed:seeds[0]});p.fingerprint.navigator[field]=value;assert.equal(passportValidation(p).status,'failed');},{field,value});
 for(const field of ['vendor','renderer'])for(const value of [null,42,{},[],true])check('malformed GPU field',()=>{const p=fp.localPassport(settings,{seed:seeds[0]});p.fingerprint.videoCard[field]=value;assert.equal(passportValidation(p).status,'failed');},{field,value});
});
section('readiness and removed generator',()=>{
 const now=Date.now(),savedAt=new Date(now-1000).toISOString(),evidence={status:'passed',verificationVersion:readiness.VERIFICATION_VERSION,processRestartVerified:true,sourceSnapshotId:'audit-snapshot',runtimeVersion:'154.0.0.1',passportHash:'a'.repeat(64),checkedAt:new Date(now).toISOString(),sourceSavedAt:savedAt};
 const profile={status:'ready',isEnabled:true,deletedAt:null,warmedAt:savedAt,fingerprintState:'verified',readinessVersion:readiness.VERIFICATION_VERSION,readinessVerifiedAt:savedAt,readinessValidUntil:new Date(now+60000),snapshotId:'audit-snapshot',sessionCheck:evidence};
 check('readiness exact evidence',()=>{assert.equal(readiness.confirmed(profile,now),true);for(const patch of [{isEnabled:false},{snapshotId:'other'},{deletedAt:new Date()},{readinessValidUntil:new Date(now-1)},{sessionCheck:{...evidence,processRestartVerified:false}}])assert.equal(readiness.confirmed({...profile,...patch},now),false);});
 check('readiness rejects non-SHA256 hash',()=>assert.equal(readiness.confirmed({...profile,sessionCheck:{...evidence,passportHash:'z'.repeat(64)}},now),false));
 const obsolete=['generate','MobileProfile'].join('');
 const walk=dir=>readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(join(dir,e.name)):/\.(?:[cm]?js|tsx?)$/.test(e.name)?[join(dir,e.name)]:[]);
 const matches=['utils','worker','app','lib','components','scripts','tests'].flatMap(d=>walk(resolve(root,d))).filter(f=>readFileSync(f,'utf8').includes(obsolete));
 check('obsolete generator absent from source',()=>assert.deepEqual(matches,[]));
});
report.failures=[...failures.values()];report.passed=report.failures.length===0;
console.table(catalog.DEVICE_CATALOG.templates.map(t=>({model:t.id,count:report.models[t.id]||0,percent:(report.models[t.id]||0)/10,expected:t.defaultWeight/10})));
console.log(`Themes: light ${report.lightPercent}% / dark ${report.themes.dark/10}%; Pixel ${report.pixelPercent}%; validation errors ${report.validationErrors}`);
for(const item of report.checks)console.log(`${item.passed?'PASS':'FAIL'} ${item.name}`);
if(!report.passed)console.error(JSON.stringify(report.failures,null,2));
const output=resolve(root,option('--report')||'prepared/orbit-upgrades-audit.json');mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2)+'\n');
console.log(`Report: ${output}\n${report.passed?'PASS':'FAIL'}`);process.exitCode=report.passed?0:1;
