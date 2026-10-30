import test from 'node:test';
import assert from 'node:assert/strict';
import fp from '../utils/fingerprint.js';
import { formatBrandList, buildHttpClientHints, buildCdpUserAgentOverride, clientHintHeaders } from '../worker/client-hints.mjs';

test('structured brand strings escape quotes and backslashes and reject forbidden characters', () => {
  assert.equal(formatBrandList([{brand:'A"B\\C',version:'1"\\2'}]),String.raw`"A\"B\\C";v="1\"\\2"`);
  assert.equal(formatBrandList(), '');
  for (const brand of ['line\nfeed','carriage\rreturn','tab\t','\x7f','Бренд']) assert.throws(() => formatBrandList([{brand,version:'1'}]));
  assert.throws(() => formatBrandList([{brand:'missing version'}]));
});

test('HTTP opts into high entropy explicitly and preserves saved values without mutation', () => {
  const p = fp.localPassport(), before = JSON.stringify(p), h = p.fingerprint.navigator.userAgentData;
  const low = buildHttpClientHints(p);
  assert.deepEqual(Object.keys(low), ['Sec-CH-UA','Sec-CH-UA-Mobile','Sec-CH-UA-Platform']);
  assert.equal(low['Sec-CH-UA'],formatBrandList(h.brands));
  const high = buildHttpClientHints(p,true);
  assert.equal(high['Sec-CH-UA-Full-Version-List'],formatBrandList(h.fullVersionList));
  assert.equal(high['Sec-CH-UA-Bitness'],'"64"');assert.equal(high['Sec-CH-UA-WoW64'],'?0');
  assert.equal(JSON.stringify(p),before);
  h.bitness='';h.architecture='';delete h.wow64;
  assert.equal(buildHttpClientHints(p,true)['Sec-CH-UA-Bitness'],'""');
  assert.equal(clientHintHeaders(h)['sec-ch-ua-wow64'],undefined);
  assert.equal(clientHintHeaders(h)['sec-ch-ua-full-version'],JSON.stringify(h.uaFullVersion));
  assert.throws(()=>buildHttpClientHints({}),/missing/);
});

test('CDP uses saved platform, case-insensitive language headers and unescaped native arrays', () => {
  const p=fp.localPassport({fingerprintLocale:'de-DE'}),h=p.fingerprint.navigator.userAgentData;
  h.brands=[{brand:'A"B\\C',version:'1'}];h.fullVersionList=[{brand:'A"B\\C',version:'1.0.0.0'}];
  const before=JSON.stringify(p),payload=buildCdpUserAgentOverride(p);
  assert.equal(payload.platform,'Linux armv81');assert.equal(payload.acceptLanguage,'de-DE,de');
  assert.deepEqual(payload.userAgentMetadata.brands,h.brands);assert.equal(payload.userAgentMetadata.bitness,'64');
  payload.userAgentMetadata.brands[0].brand='changed';assert.equal(JSON.stringify(p),before);
  p.headers={'Accept-Language':'en-GB,en;q=0.7'};assert.equal(buildCdpUserAgentOverride(p).acceptLanguage,'en-GB,en');
  p.headers={};assert.equal(buildCdpUserAgentOverride(p).acceptLanguage,'de-DE,de');
  h.bitness='';assert.equal(buildCdpUserAgentOverride(p).userAgentMetadata.bitness,'');
  assert.throws(()=>buildCdpUserAgentOverride({}),/missing/);
});

test('native Network and Emulation CDP overrides match HTTP hints after Accept-CH without an injector', async () => {
  const {chromium}=await import('playwright');
  const browser=await chromium.launch({headless:true,executablePath:process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH});
  try {
    for(const method of ['Network.setUserAgentOverride','Emulation.setUserAgentOverride']) {
      const p=fp.localPassport({fingerprintMode:'local'},{runtimeVersion:browser.version()});
      const before=JSON.stringify(p), context=await browser.newContext(), requests=[];
      try {
        await context.route('https://hints.invalid/**',route=>{
          requests.push(route.request().headers());
          return route.fulfill({contentType:'text/html',headers:{'accept-ch':'Sec-CH-UA-Platform-Version, Sec-CH-UA-Model, Sec-CH-UA-Full-Version-List, Sec-CH-UA-Arch, Sec-CH-UA-Bitness, Sec-CH-UA-WoW64'},body:'<!doctype html><title>Hints fixture</title>'});
        });
        const page=await context.newPage(),cdp=await context.newCDPSession(page);
        await cdp.send(method,buildCdpUserAgentOverride(p));
        await page.goto('https://hints.invalid/first');
        const observed=await page.evaluate(async()=>({platform:navigator.platform,hints:await navigator.userAgentData.getHighEntropyValues(['model','platformVersion','architecture','bitness','fullVersionList','wow64'])}));
        assert.equal(observed.platform,'Linux armv81');assert.equal(observed.hints.bitness,'64');
        assert.deepEqual(observed.hints.brands,p.fingerprint.navigator.userAgentData.brands);
        assert.deepEqual(observed.hints.fullVersionList,p.fingerprint.navigator.userAgentData.fullVersionList);
        await page.goto('https://hints.invalid/second');
        for(const [key,value] of Object.entries(buildHttpClientHints(p)))assert.equal(requests[0][key.toLowerCase()],value,method+': '+key);
        assert.equal(requests[0]['sec-ch-ua-model'],undefined);
        for(const [key,value] of Object.entries(buildHttpClientHints(p,true)))assert.equal(requests[1][key.toLowerCase()],value,method+': '+key);
        assert.equal(requests[1]['accept-language'],p.headers['accept-language']);assert.equal(JSON.stringify(p),before);
        await cdp.detach();
      } finally {await context.close();}
    }
  } finally {await browser.close();}
});

test('User-Agent and all UA Client Hints are omitted from static context headers without mutating saved headers',async()=>{
 const {initialProfileHeaders}=await import('../worker/client-hints.mjs');
 const headers={'User-Agent':'saved-ua','user-agent':'legacy-ua','Sec-CH-UA-Model':'"old"','sec-ch-ua-bitness':'"64"','Sec-CH-UA':'brands','sec-ch-ua-mobile':'?1','SEC-CH-UA-PLATFORM':'"Android"','accept-language':'ru-RU','x-owned-fixture':'static'};
 const before=structuredClone(headers);
 assert.deepEqual(initialProfileHeaders(headers),{'accept-language':'ru-RU','x-owned-fixture':'static'});
 assert.deepEqual(headers,before);
});

test('full mobile context respects cold origins, Accept-CH and Critical-CH despite saved legacy high entropy',async()=>{
 const {chromium}=await import('playwright');const {createMobileContext,createMobilePage,mobileContextOptions}=await import('../worker/profiles.mjs');
 const browser=await chromium.launch({headless:true,executablePath:process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH});
 try{
  const passport=fp.localPassport({fingerprintMode:'local'},{runtimeVersion:browser.version()}),profile=fp.profileFromPassport('hints-integration',passport);
  profile.headers['sec-ch-ua-model']='"legacy-leak"';const context=await browser.newContext(mobileContextOptions(profile)),requests=[];
  await context.route('https://**.hints.invalid/**',route=>{requests.push({url:route.request().url(),headers:route.request().headers()});return route.fulfill({contentType:'text/html',headers:{'accept-ch':'Sec-CH-UA-Model','critical-ch':'Sec-CH-UA-Model'},body:'<!doctype html><title>Owned fixture</title>'});});
  await createMobileContext(browser,profile,undefined,context);
  try{const page=await createMobilePage(context,profile);await page.goto('https://one.hints.invalid/cold');await page.goto('https://one.hints.invalid/warm');await page.goto('https://two.hints.invalid/cold');
   for(const host of ['one','two']){const first=requests.find(r=>r.url===`https://${host}.hints.invalid/cold`);assert.equal(first.headers['sec-ch-ua-model'],undefined);}
   const warm=requests.find(r=>r.url==='https://one.hints.invalid/warm');assert.equal(warm.headers['sec-ch-ua-model'],JSON.stringify(passport.fingerprint.navigator.userAgentData.model));
  }finally{await context.close();}
 }finally{await browser.close();}
});
