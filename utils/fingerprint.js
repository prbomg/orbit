const baseSample = require('./profile-base.json');
const catalog = require('./deviceCatalog.js');
const { formatBrandList } = require('./structuredFields.js');
const { createHash, randomBytes } = require('node:crypto');
const CURRENT_GENERATION_VERSION = '6';
const CURRENT_ADAPTER_VERSION = 'local-v7';
// Preserve Chromium's frozen navigator.platform; expose catalog ARM64 bitness.
const ANDROID_PLATFORM = 'Linux armv81';
const ANDROID_BITNESS = '64';
function deriveColorSchemeFromSeed(seedHex) {
  if(typeof seedHex!=='string'||!/^[a-f0-9]{32}$/.test(seedHex))throw Error('invalid_profile_seed');
  const ratio=createHash('sha256').update(`color-scheme:${seedHex}`).digest().readUInt32BE(0)/0x100000000;
  return ratio<0.65?'light':'dark';
}
function languagesForLocale(locale) {
  return locale==='ru-RU'?['ru-RU','ru','en-US','en']:[...new Set([locale,locale.split('-')[0]])];
}
function acceptLanguage(languages) {
  return languages.map((language,index)=>index===0?language:`${language};q=${(1-index*0.1).toFixed(1)}`).join(',');
}
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function deviceFingerprint(fingerprint) {
  const { battery: _battery, ...device } = fingerprint;
  return device;
}
function devicePassport(passport) {
  return { ...passport, fingerprint: deviceFingerprint(passport.fingerprint) };
}
// Hash only browser identity, not provider metadata, timestamps or runtime state.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const CURRENT_IDENTITY_HASH_VERSION = 4;
function legacyIdentityHash(profileId, passport) {
  return digest(canonical({ version: 3, profileId, fingerprint: deviceFingerprint(passport.fingerprint), headers: passport.headers, canvasSeed: passport.canvasSeed, timezone: passport.timezone ?? null }));
}
function supportsBrowserUpgrade(passport) {
  const n = passport?.fingerprint?.navigator, h = n?.userAgentData;
  return /Android/.test(n?.userAgent || '') && h?.platform === 'Android' &&
    typeof h.model === 'string' && h.model.length > 0 && typeof h.platformVersion === 'string' && h.platformVersion.length > 0;
}
function identityHash(profileId, passport) {
  let fingerprint = deviceFingerprint(passport.fingerprint), headers = passport.headers;
  if (supportsBrowserUpgrade(passport)) {
    const { userAgent: _ua, appVersion: _app, userAgentData, ...navigator } = fingerprint.navigator;
    const { uaFullVersion: _version, fullVersion: _full, brands: _brands, fullVersionList: _list, ...hardwareHints } = userAgentData;
    fingerprint = { ...fingerprint, navigator: { ...navigator, userAgentData: hardwareHints } };
    const dynamic = new Set(['user-agent', 'sec-ch-ua', 'sec-ch-ua-full-version', 'sec-ch-ua-full-version-list']);
    headers = Object.fromEntries(Object.entries(headers || {}).filter(([key]) => !dynamic.has(key.toLowerCase())));
  }
  return digest(canonical({ version: CURRENT_IDENTITY_HASH_VERSION, profileId, fingerprint, headers, canvasSeed: passport.canvasSeed, timezone: passport.timezone ?? null }));
}
function matchesIdentityHash(profileId, passport, value) {
  return value === identityHash(profileId, passport) || value === legacyIdentityHash(profileId, passport);
}
function getChromiumGreaseBrand(majorVersion) {
  const major=Number(majorVersion);
  if(!Number.isSafeInteger(major)||major<1)throw Error('invalid_chrome_version');
  // Chromium GetGreasedUserAgentBrandVersion: 11 separators and 3 versions.
  const separators=[' ','(',':','-','.','/',')',';','=','?','_'];
  return {brand:`Not${separators[major%11]}A${separators[(major+1)%11]}Brand`,version:['8','99','24'][major%3]};
}
function chromiumBrands(major) {
  const source=[getChromiumGreaseBrand(major),{brand:'Chromium',version:String(major)},{brand:'Google Chrome',version:String(major)}];
  const order=[[0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]][Number(major)%6];
  const result=[];source.forEach((brand,index)=>{result[order[index]]=brand;});return result;
}
function buildChromeMetadata({fullVersion,osVersion,modelCode,bitness=ANDROID_BITNESS,nativeBrands=null,nativeFullVersionList=null}) {
  if(typeof fullVersion!=='string'||!/^\d{2,3}(\.\d{1,5}){3}$/.test(fullVersion))throw Error('invalid_chrome_version');
  const major=fullVersion.split('.')[0];
  const validRows=rows=>Array.isArray(rows)&&rows.length>=2&&rows.length<=4&&new Set(rows.map(r=>r?.brand)).size===rows.length&&rows.every(r=>typeof r?.brand==='string'&&/^[\x20-\x7e]{1,100}$/.test(r.brand)&&typeof r.version==='string'&&/^\d{1,5}(\.\d{1,5}){0,3}$/.test(r.version));
  const brands=nativeBrands===null?chromiumBrands(major):structuredClone(nativeBrands);
  if(!validRows(brands)||!brands.some(b=>b.brand==='Chromium'&&b.version===major))throw Error('invalid_native_brands');
  const fullVersionList=nativeFullVersionList===null?brands.map(b=>({brand:b.brand,version:['Chromium','Google Chrome','HeadlessChrome'].includes(b.brand)?fullVersion:`${b.version}.0.0.0` })):structuredClone(nativeFullVersionList);
  if(!validRows(fullVersionList)||fullVersionList.length!==brands.length||fullVersionList.some((b,i)=>b.brand!==brands[i].brand||b.version.split('.')[0]!==brands[i].version)||fullVersionList.find(b=>b.brand==='Chromium')?.version!==fullVersion)throw Error('invalid_native_brands');
  return {userAgent:`Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`,userAgentData:{brands,mobile:true,platform:'Android',architecture:'',bitness,model:modelCode,platformVersion:osVersion,uaFullVersion:fullVersion,fullVersionList,wow64:false}};
}
// Keep the existing mutating call form for integrations; the object form is pure.
function chromeMetadata(fingerprint, headers, version, model, os, options={}) {
  if(headers===undefined)return buildChromeMetadata(fingerprint);
  const metadata=buildChromeMetadata({fullVersion:version,modelCode:model,osVersion:os,...options});
  const n = fingerprint.navigator;
  if(options.legacy){
    const major=version.split('.')[0];
    // Preserve saved GREASE and order when binding an unused legacy passport;
    // never invent a fixed brand/version for an older identity.
    const engine = b => ['Chromium','Google Chrome','HeadlessChrome'].includes(b.brand);
    metadata.userAgentData={...n.userAgentData,
      brands:n.userAgentData.brands.map(b=>({...b,version:engine(b)?major:b.version})),uaFullVersion:version,
      fullVersionList:n.userAgentData.fullVersionList.map(b=>({...b,version:engine(b)?version:b.version}))};
  }
  Object.assign(n,metadata);
  n.appVersion = n.userAgent.replace(/^Mozilla\//, ''); n.platform = options.legacy?'Linux armv81':ANDROID_PLATFORM;
  n.vendor = 'Google Inc.'; n.oscpu = null;
  headers['user-agent'] = n.userAgent;
  headers['sec-ch-ua'] = formatBrandList(n.userAgentData.brands);
  headers['sec-ch-ua-mobile'] = '?1'; headers['sec-ch-ua-platform'] = '"Android"';
  return metadata;
}
function localPassport(settings = {}, options = {}) {
  const seed = options.seed ?? randomBytes(16).toString('hex');
  if(typeof seed!=='string'||!/^[a-f0-9]{32}$/.test(seed))throw Error('invalid_profile_seed');
  // Fixed input + seed + configuration reproduce the complete device identity.
  // Previously only template selection was seeded; remaining fields were random.
  const { fingerprint, headers } = structuredClone(baseSample);
  const preset = settings.fingerprintDevicePreset || 'mixed';
  if (!['mixed', 's23_android14'].includes(preset)) throw new Error('invalid_device_preset');
  const weights=catalog.resolveWeights(settings.fingerprintDeviceWeights);
  const fixedTemplateId=options.templateId || (preset==='s23_android14'?'s23_android14':null);
  const template=fixedTemplateId?catalog.findTemplate(fixedTemplateId):catalog.selectTemplate(seed,weights);
  if(!template)throw Error('unknown_device_template');
  const d={...template.browser,model:template.model,os:template.os};
  const locale = settings.fingerprintLocale || 'ru-RU', timezone = settings.fingerprintTimezone || 'Europe/Moscow';
  new Intl.DateTimeFormat(locale, { timeZone: timezone });
  const version = options.runtimeVersion ?? fingerprint.navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] ?? '134.0.6998.45';
  chromeMetadata(fingerprint, headers, version, d.model, d.os, {bitness:template.bitness||ANDROID_BITNESS,nativeBrands:options.nativeBrands??null,nativeFullVersionList:options.nativeFullVersionList??null});
  const languages=languagesForLocale(locale);
  Object.assign(fingerprint.navigator, { language: locale, languages, hardwareConcurrency: d.cpu, deviceMemory: d.memory, maxTouchPoints: d.touch, webdriver:false });
  Object.assign(fingerprint.screen, { width: d.width, height: d.height, availWidth: d.width, availHeight: d.height, innerWidth: d.width, innerHeight: d.height, clientWidth: d.width, clientHeight: d.height, outerWidth: d.width, outerHeight: d.height, devicePixelRatio: d.dpr, colorDepth: 24, pixelDepth: 24 });
  fingerprint.videoCard = { vendor: d.vendor, renderer: d.renderer };
  if(template.webglLimits)fingerprint.webglLimits=structuredClone(template.webglLimits);
  // Public passport GPU fields mirror the existing injector representation.
  fingerprint.gpu={...fingerprint.videoCard,...structuredClone(template.webglLimits||{})};
  fingerprint.preferences={colorScheme:deriveColorSchemeFromSeed(seed),reducedMotion:'no-preference',contrast:'no-preference'};
  // A versioned part of the hashed identity. Old passports have no canvas
  // policy and continue using their original seeded readout unchanged.
  fingerprint.canvas={version:1,mode:'native'};
  // Battery belongs to session runtime state, never to the device passport.
  delete fingerprint.battery;
  fingerprint.fonts = ['Roboto', 'Noto Sans', 'Noto Serif'];
  headers['accept-language'] = acceptLanguage(languages);
  return { identityHashVersion: CURRENT_IDENTITY_HASH_VERSION, deviceTemplate: {id:template.id,revision:template.revision,catalogVersion:catalog.DEVICE_CATALOG.version}, generation: { version: CURRENT_GENERATION_VERSION, deviceSet: catalog.DEVICE_CATALOG.version, preset, adapter: CURRENT_ADAPTER_VERSION, baseSample: { version: baseSample.version, hash: digest(baseSample), generatorVersion: baseSample.generatorVersion }, distribution:{algorithm:'sha256-weighted-v1',revision:settings.fingerprintDistributionRevision||1,weights,fixedTemplateId} }, version: 1, source: 'local', runtimeVersion:options.runtimeVersion??null, requestedSource: settings.fingerprintMode || 'auto', resolved: settings.fingerprintMode === 'local', seed, createdAt: new Date().toISOString(), timezone, fingerprint, headers, canvasSeed: parseInt(seed.slice(0, 8), 16), limitations: ['Canvas использует нативное поведение установленного браузера без добавленного шума. Параметры WebGL эмулируются; дамп физического телефона не используется. Снимки сессии не зашифрованы AES-256-GCM на уровне приложения.', 'Геолокация, оператор, DNS и WebRTC не подтверждены характеристиками устройства. Параметры прокси проверяются отдельно для попытки.', 'Серверный Chromium эмулирует Android; физическое устройство не воспроизводится.', 'Аудио и шрифты измеряются в браузере. Произвольный аудио-хеш не подменяется.'] };
}
function mobileProxyPassport(base, input) {
  const p = input?.profile;
  if (input?.status !== 'ok' || !p || p.os !== 'android' || p.browser !== 'chrome') throw new Error('provider_invalid_profile');
  const n = p.navigator, s = p.screen;
  if (!n || !s || !p.webgl || !Array.isArray(p.fonts) || p.fonts.length > 100 || p.fonts.some(f => typeof f !== 'string' || f.length > 100)) throw new Error('provider_invalid_profile');
  for (const [v, min, max] of [[s.width, 200, 1000], [s.height, 300, 2000], [s.pixelRatio, 1, 5], [n.hardwareConcurrency, 1, 32], [n.deviceMemory, 1, 8], [n.maxTouchPoints, 1, 10]]) if (!Number.isFinite(v) || v < min || v > max) throw new Error('provider_invalid_profile');
  if (!/^\d{2,3}(\.\d{1,5}){3}$/.test(p.browser_version) || typeof n.language !== 'string' || typeof p.timezone?.name !== 'string' || typeof p.webgl.vendor !== 'string' || typeof p.webgl.renderer !== 'string') throw new Error('provider_invalid_profile');
  new Intl.DateTimeFormat(n.language, { timeZone: p.timezone.name });
  const result = devicePassport(structuredClone(base)), f = result.fingerprint;
  chromeMetadata(f, result.headers, p.browser_version, String(n.userAgentData?.model || '').slice(0, 100), String(n.userAgentData?.platformVersion || '13.0.0').slice(0, 40));
  Object.assign(f.navigator, { language: n.language, languages: [n.language, n.language.split('-')[0]].filter((v, i, a) => a.indexOf(v) === i), hardwareConcurrency: n.hardwareConcurrency, deviceMemory: n.deviceMemory, maxTouchPoints: n.maxTouchPoints });
  Object.assign(f.screen, { width: s.width, height: s.height, availWidth: s.width, availHeight: s.height, innerWidth: s.width, innerHeight: s.height, clientWidth: s.width, clientHeight: s.height, outerWidth: s.width, outerHeight: s.height, devicePixelRatio: s.pixelRatio });
  f.videoCard = { vendor: p.webgl.vendor.slice(0, 200), renderer: p.webgl.renderer.slice(0, 500) }; f.fonts = p.fonts;
  // Provider metadata must never inherit the randomly selected local GPU limits.
  delete f.webglLimits;
  delete f.gpu;
  result.headers['accept-language'] = `${n.language},${n.language.split('-')[0]};q=0.9`;
  result.generation = { ...(base.generation || { version: 'legacy', deviceSet: 'legacy' }), adapter: 'mobileproxy-v1' };
  delete result.deviceTemplate;
  delete result.generation.distribution;
  result.source = 'mobileproxy'; result.resolved = true; result.timezone = p.timezone.name;
  result.providerVersion = String(p._meta?.version || '').slice(0, 30);
  result.providerScore = Number.isFinite(input.score) ? input.score : null;
  result.providerAudioHash = typeof p.audio?.contextHash === 'string' ? p.audio.contextHash.slice(0, 100) : null;
  // Preserve our full-entropy per-profile seed even if the provider's numeric seed collides.
  if(catalog.providerIssues(f).length)throw Error('provider_invalid_profile');
  result.providerCanvasSeed = String(p.canvas?.noiseSeed ?? '').slice(0, 100);
  return result;
}
function profileFromPassport(id, passport) {
  return { version: 2, profileId: id, mobileOS: 'android', fingerprint: passport.fingerprint, headers: passport.headers, canvasSeed: passport.canvasSeed, createdAt: passport.createdAt, savedAt: null, cookies: [], origins: [], passport: { timezone: passport.timezone, seed: passport.seed } };
}
module.exports = { CURRENT_GENERATION_VERSION, CURRENT_ADAPTER_VERSION, CURRENT_IDENTITY_HASH_VERSION, ANDROID_PLATFORM, ANDROID_BITNESS, deriveColorSchemeFromSeed, getChromiumGreaseBrand, languagesForLocale, acceptLanguage, localPassport, mobileProxyPassport, profileFromPassport, digest, chromeMetadata, deviceFingerprint, devicePassport, identityHash, legacyIdentityHash, matchesIdentityHash, supportsBrowserUpgrade };
