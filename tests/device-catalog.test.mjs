import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import catalog from '../utils/deviceCatalog.js';
import fp from '../utils/fingerprint.js';
import {passportValidation} from '../worker/passport-validation.mjs';
import {compareProfile} from '../utils/profileComparison.js';
const seed=i=>createHash('sha256').update('catalog-fixture:'+i).digest('hex').slice(0,32);
const templates=catalog.DEVICE_CATALOG.templates;
test('all catalog entries generate coherent passports with traceable evidence',()=>{
 for(const template of templates){
  const p=fp.localPassport({fingerprintMode:'local'},{templateId:template.id,seed:seed(1)});
  assert.equal(p.deviceTemplate.id,template.id);assert.equal(passportValidation(p).status,'passed');
  assert.equal(p.generation.distribution.fixedTemplateId,template.id);
  assert.equal(template.evidence.measuredAt,null);assert.ok(template.evidence.sources.length);
 }
});
test('catalog rejects impossible geometry, RAM, duplicate IDs and unexpected fields',()=>{
 for(const mutate of [t=>t.browser.width=0,t=>t.browser.dpr=NaN,t=>t.renderScreen.width+=50,t=>t.browser.memory=6,t=>t.browser.renderer='NVIDIA RTX',t=>t.unexpected=true]){
  const t=structuredClone(templates[0]);mutate(t);assert.equal(catalog.templateSchema.safeParse(t).success,false);
 }
 const duplicate=structuredClone(catalog.DEVICE_CATALOG);duplicate.templates.push(duplicate.templates[0]);assert.equal(catalog.catalogSchema.safeParse(duplicate).success,false);
 assert.equal(catalog.browserMemory(6),4);assert.equal(catalog.browserMemory(12),8);
});
test('weighted selection is reproducible, excludes zero weights and follows configured proportions',()=>{
 const weights=Object.fromEntries(templates.map((t,i)=>[t.id,i===2?0:i+1])),counts=Object.fromEntries(templates.map(t=>[t.id,0]));
 const size=10000;
 for(let i=0;i<size;i++){const a=catalog.selectTemplate(seed(i),weights);assert.equal(a.id,catalog.selectTemplate(seed(i),weights).id);counts[a.id]++;}
 for(const t of templates){const p=weights[t.id]/Object.values(weights).reduce((a,b)=>a+b,0);assert.ok(Math.abs(counts[t.id]-size*p)<=6*Math.sqrt(size*p*(1-p))+1,JSON.stringify(counts));}
 assert.equal(counts[templates[2].id],0);
});
test('invalid distributions are rejected before generation',()=>{
 for(const value of [{...catalog.DEFAULT_WEIGHTS,unknown:1},{},{...catalog.DEFAULT_WEIGHTS,[templates[0].id]:-1},{...catalog.DEFAULT_WEIGHTS,[templates[0].id]:.5},Object.fromEntries(templates.map(t=>[t.id,0]))])assert.equal(catalog.weightsSchema.safeParse(value).success,false);
 assert.throws(()=>fp.localPassport({fingerprintDeviceWeights:{bad:1}}));
 assert.throws(()=>fp.localPassport({},{seed:'invalid'}));
 assert.throws(()=>fp.localPassport({},{templateId:'unknown'}));
});
test('linked validation catches contradictory passports and preserves older generation identities',()=>{
 const mutations=[p=>p.fingerprint.navigator.userAgentData.model='Unknown',p=>p.fingerprint.navigator.userAgentData.platformVersion='99.0.0',p=>p.fingerprint.videoCard.renderer='Other',p=>p.fingerprint.screen.width+=10,p=>p.fingerprint.navigator.deviceMemory=6,p=>p.deviceTemplate.revision=999,p=>p.generation.distribution.weights={bad:1},p=>p.headers['sec-ch-ua-mobile']='?0'];
 for(const mutate of mutations){const p=fp.localPassport();mutate(p);assert.equal(passportValidation(p).status,'failed');}
 const old=fp.localPassport();old.generation.version='3';old.fingerprint.navigator.userAgentData.bitness='';delete old.deviceTemplate;delete old.generation.distribution;
 const before=JSON.stringify(old),hash=fp.identityHash('saved',old);assert.equal(passportValidation(old).status,'passed');assert.equal(JSON.stringify(old),before);assert.equal(fp.identityHash('saved',old),hash);
});
const provider={status:'ok',profile:{os:'android',browser:'chrome',browser_version:'134.0.6998.45',navigator:{language:'ru-RU',hardwareConcurrency:8,deviceMemory:8,maxTouchPoints:5,userAgentData:{model:'SM-S911B',platformVersion:'15.0.0'}},screen:{width:360,height:780,pixelRatio:3},webgl:{vendor:'Qualcomm',renderer:'ANGLE (Qualcomm, Adreno (TM) 740, OpenGL ES)'},fonts:['Roboto'],timezone:{name:'Europe/Moscow'}}};
test('provider profiles retain independent metadata; inconsistent model/GPU and RAM are rejected',()=>{
 const adapted=fp.mobileProxyPassport(fp.localPassport({fingerprintDevicePreset:'s23_android14'}),provider);
 assert.equal(adapted.fingerprint.webglLimits,undefined);
 assert.equal(adapted.deviceTemplate,undefined);assert.equal(adapted.generation.distribution,undefined);assert.equal(adapted.fingerprint.navigator.userAgentData.platformVersion,'15.0.0');assert.equal(passportValidation(adapted).status,'passed');
 for(const mutate of [p=>p.profile.navigator.deviceMemory=6,p=>p.profile.webgl.renderer='Mali-G710']){const bad=structuredClone(provider);mutate(bad);assert.throws(()=>fp.mobileProxyPassport(fp.localPassport(),bad),/provider_invalid_profile/);}
});
test('comparison distinguishes absent measurements, disagreement and empty-string hints',()=>{
 const p=fp.profileFromPassport('test',fp.localPassport()),report=compareProfile(p,{userAgent:'wrong',clientHints:{architecture:'',bitness:''}});
 assert.equal(report.rows.find(r=>r.key==='architecture').status,'matched');assert.equal(report.rows.find(r=>r.key==='memory').status,'unavailable');assert.equal(report.rows.find(r=>r.key==='ua').status,'mismatch');assert.equal(report.basis,'browser_emulation');assert.ok(report.unverified.length);
});
test('every catalog template is applied to real Chromium documents and produces comparison rows',async()=>{
 const {chromium}=await import('playwright');const {createMobileContext,createMobilePage}=await import('../worker/profiles.mjs');const {inspectFingerprint}=await import('../worker/fingerprint-check.mjs');
 const browser=await chromium.launch({headless:true,executablePath:process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH});
 try{for(const template of templates){
  const p=fp.localPassport({fingerprintMode:'local'},{templateId:template.id,seed:seed(4)});fp.chromeMetadata(p.fingerprint,p.headers,browser.version(),template.model,template.os);
  const profile=fp.profileFromPassport('catalog-browser',p),context=await createMobileContext(browser,profile);
  try{const page=await createMobilePage(context,profile),report=await inspectFingerprint(page,profile,undefined,browser.version());assert.equal(report.status,'passed',template.id);assert.ok(report.comparison.rows.filter(r=>r.declared!==null).every(r=>r.status==='matched'),JSON.stringify(report.comparison.rows));assert.equal(report.firstDocuments.records.length,5);assert.ok(report.observed.visualViewport.width>0);}finally{await context.close();}
 }}finally{await browser.close();}
});
test('settings changes affect new profiles and never reselect an existing passport',async()=>{
 const {poolFixture}=await import('./helpers/pool-fixture.mjs');const {ensurePassport}=await import('../worker/fingerprint-service.mjs');const f=await poolFixture();
 try{await f.db.settings.update({where:{id:1},data:{fingerprintMode:'local'}});const row=await f.db.profile.create({data:{name:'Existing'}});const first=await ensurePassport({prisma:f.db,profileId:row.id,proxy:f.proxy});
 const weights=Object.fromEntries(templates.map(t=>[t.id,t.id==='s23_android14'?1:0]));await f.db.settings.update({where:{id:1},data:{fingerprintDeviceWeights:weights,fingerprintDistributionRevision:2}});
 const same=await ensurePassport({prisma:f.db,profileId:row.id,proxy:f.proxy});assert.equal(fp.identityHash(row.id,first),fp.identityHash(row.id,same));assert.deepEqual(first.generation,same.generation);
 const next=await f.db.profile.create({data:{name:'New'}}),fresh=await ensurePassport({prisma:f.db,profileId:next.id,proxy:f.proxy});assert.equal(fresh.deviceTemplate.id,'s23_android14');assert.equal(fresh.generation.distribution.revision,2);
 }finally{await f.cleanup();}
});
