import catalog from '../utils/deviceCatalog.js';
import fp from '../utils/fingerprint.js';
import {formatBrandList} from './client-hints.mjs';
export function passportValidation(passport, runtimeVersion) {
 const errors=[],warnings=[],f=passport?.fingerprint,n=f?.navigator,s=f?.screen;
 const userAgent=typeof n?.userAgent==='string'?n.userAgent:'';
 const check=(ok,code)=>{if(!ok)errors.push(code);};
 check(Boolean(userAgent && passport.headers?.['user-agent']===userAgent),'passport_user_agent');
 check(Boolean(typeof n?.language==='string' && n.language && Array.isArray(n.languages) && n.languages.every(l=>typeof l==='string') && n.languages.includes(n.language)),'passport_language');
 check(Boolean(s && [s.width,s.height,s.devicePixelRatio,s.innerWidth,s.innerHeight].every(v=>Number.isFinite(v)&&v>0)),'passport_screen');
 check(Number.isFinite(n?.hardwareConcurrency)&&n.hardwareConcurrency>=1,'passport_cpu');
 check(Number.isFinite(n?.maxTouchPoints)&&n.maxTouchPoints>=1,'passport_touch');
 check(Boolean(f?.videoCard?.vendor&&f.videoCard.renderer),'passport_gpu');
 if(passport?.timezone){try{new Intl.DateTimeFormat(n?.language,{timeZone:passport.timezone});}catch{errors.push('passport_timezone');}}
 if(n?.userAgentData && /Android/.test(n.userAgent||''))check(n.userAgentData.mobile===true&&n.userAgentData.platform==='Android','passport_client_hints');
 const android = /Android/.test(n?.userAgent || '');
 const v6=passport?.generation?.version==='6';
 const v5=passport?.generation?.version==='5'||v6;
 const modern = ['3','4','5','6'].includes(passport?.generation?.version);
 const compatible = (ok,code) => { if(!ok)(modern?errors:warnings).push(code); };
 if(android||v5){
  const hints=n?.userAgentData;
  compatible((v5?/^Mozilla\/5\.0 \(Linux; Android 10; K\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\/\d+\.0\.0\.0 Mobile Safari\/537\.36$/:/Android 10; K\).*Chrome\/\d+\.0\.0\.0 Mobile/).test(n?.userAgent||''),'android_ua_reduction');
  compatible(hints?.architecture===''&&hints?.bitness===(v5?fp.ANDROID_BITNESS:''),'android_client_hint_architecture');
  if(hints){
   const uaMajor=userAgent.match(/Chrome\/(\d+)/)?.[1];
   const brands=Array.isArray(hints.brands)?hints.brands.filter(b=>/^(Chromium|Google Chrome)$/.test(b?.brand)):[];
   const full=Array.isArray(hints.fullVersionList)?hints.fullVersionList.filter(b=>/^(Chromium|Google Chrome)$/.test(b?.brand)):[];
   compatible(typeof hints.uaFullVersion==='string'&&hints.uaFullVersion.split('.')[0]===uaMajor&&brands.length>0&&brands.every(b=>b.version===uaMajor)&&full.length>0&&full.every(b=>b.version===hints.uaFullVersion),'android_browser_version');
  }
 }
 const major=userAgent.match(/(?:Chrome|CriOS)\/(\d+)/)?.[1];
 if(runtimeVersion&&major&&major!==runtimeVersion.split('.')[0])warnings.push('runtime_version_difference');
 if(['4','5','6'].includes(passport?.generation?.version)){
  errors.push(...catalog.templateIssues(passport),...catalog.providerIssues(f,passport.source==='local'?passport.deviceTemplate?.catalogVersion:undefined));
  const h=n?.userAgentData;
  check(n?.platform===(v5?fp.ANDROID_PLATFORM:'Linux armv81'),'android_platform');
  check(passport.headers?.['sec-ch-ua-mobile']==='?1'&&passport.headers?.['sec-ch-ua-platform']==='\"Android\"','android_header_platform');
  let brands;try{brands=formatBrandList(h?.brands);}catch{}
  check(typeof brands==='string' && Boolean(brands) && passport.headers?.['sec-ch-ua']===brands,'android_header_brands');
 }
 if(v5){
  // Optional for already-saved local-v6 identities, required on newly generated
  // passports by the upgrade audit. Never retrofit or rehash an old passport.
  if(f?.gpu)check(f.gpu.vendor===f.videoCard?.vendor&&f.gpu.renderer===f.videoCard?.renderer&&Object.entries(f.webglLimits||{}).every(([key,value])=>JSON.stringify(f.gpu[key])===JSON.stringify(value)),'passport_gpu_limits');
  const preferences=f?.preferences;
  check(['light','dark'].includes(preferences?.colorScheme)&&preferences.reducedMotion==='no-preference'&&preferences.contrast==='no-preference','passport_preferences');
  check(n?.userAgentData?.wow64===false,'android_wow64');
  if(passport.source==='local'){
   let expectedColor;try{expectedColor=fp.deriveColorSchemeFromSeed(passport.seed);}catch{}
   check(Boolean(expectedColor)&&preferences?.colorScheme===expectedColor,'passport_color_scheme_seed');
   check(passport.generation.adapter===(v6?'local-v7':'local-v6'),'passport_adapter');
   check(typeof n?.language==='string'&&Array.isArray(n.languages)&&n.languages.every(l=>typeof l==='string')&&JSON.stringify(n.languages)===JSON.stringify(fp.languagesForLocale(n.language))&&passport.headers?.['accept-language']===fp.acceptLanguage(n.languages),'passport_language_headers');
  }
 }
 if(v6)check(f?.canvas?.version===1&&f.canvas.mode==='native','passport_canvas_policy');
 if(!passport?.generation)warnings.push('legacy_generation');
 return {version:1,status:errors.length?'failed':'passed',checkedAt:new Date().toISOString(),errors,warnings,runtimeVersion:runtimeVersion||null};
}
export function proxyBindingKey(proxy,token=''){return fp.digest([proxy.host,proxy.port,proxy.username,proxy.tcpChannelId||null,fp.digest(token)]);}
