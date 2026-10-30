import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { readFile } from 'node:fs/promises';
import { sqliteWrite } from './sqlite-write.mjs';

const sha256 = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const settingsNames = new Set(['HEADER_TABLE_SIZE','ENABLE_PUSH','MAX_CONCURRENT_STREAMS','INITIAL_WINDOW_SIZE','MAX_FRAME_SIZE','MAX_HEADER_LIST_SIZE','ENABLE_CONNECT_PROTOCOL','NO_RFC7540_PRIORITIES']);
const ja4Pattern = /^[tqd][a-z0-9]{9}_[a-f0-9]{12}_[a-f0-9]{12}$/;
export function networkProbeUrl(value) {
  if (!value) return null;
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw Error('invalid_network_probe_url');
  return url;
}
export function unmeasuredTransport(reason = 'not_configured') {
  return { version:1, status:'not_measured', enforcement:'diagnostic', reason,
    tls:{status:'not_measured'}, http2:{status:'not_measured'}, http3:{status:'not_measured'},
    comparison:{status:'reference_missing'}, androidDeviceConfirmed:false };
}

export async function transportReference(file, {runtimeVersion,locale,endpointHost}) {
  if(!file)return null;
  try {
    const body=await readFile(file);if(body.length>65536)return null;
    const data=JSON.parse(body.toString('utf8'));
    if(data.version!==1||!Array.isArray(data.references)||data.references.length>100)return null;
    return data.references.find(r=>r?.browserVersion===runtimeVersion&&r.locale===locale&&r.collectorHost===endpointHost)||null;
  }catch{return null;}
}

/** Shared cooldown across processes protects diagnostic collectors, not proxy leases. */
export async function reserveTransportProbe(prisma, endpoint, now=Date.now()) {
  const url=networkProbeUrl(endpoint);if(!url)return false;
  return sqliteWrite(prisma,async tx=>{
    const key=`network-probe:${url.host}`,owner=randomUUID(),expiresAt=new Date(now+60000),at=new Date(now);
    // First statement acquires the writer lock; no read-to-write upgrade race
    // between independent processes under WAL.
    const changed=await tx.$executeRaw`INSERT INTO "WorkflowLease" ("key","owner","expiresAt") VALUES (${key},${owner},${expiresAt}) ON CONFLICT("key") DO UPDATE SET "owner"=${owner},"expiresAt"=${expiresAt} WHERE "WorkflowLease"."expiresAt"<=${at}`;
    return changed===1;
  });
}

export async function observeHttp3(context, {endpoint,timeoutMs=8000,signal}={}) {
  const url=networkProbeUrl(endpoint);if(!url)return {status:'not_measured',reason:'endpoint_not_configured'};
  let page,cdp,timer,abort,finished=false;const samples=[];
  const protocols=new Map();
  const operation=(async()=>{
    page=await context.newPage();if(finished){await page.close().catch(()=>{});return;}
    cdp=await context.newCDPSession(page);await cdp.send('Network.enable');
    cdp.on('Network.responseReceived',e=>{if(e.type==='Document')protocols.set(e.response.url,e.response.protocol);});
    for(let i=0;i<2;i++){
      signal?.throwIfAborted();if(finished)throw Error('finished');
      const probe=new URL(url);probe.searchParams.set('orbit_http3_probe',randomUUID());
      const response=await page.goto(probe.href,{waitUntil:'domcontentloaded',timeout:timeoutMs});
      if(finished||!response?.ok()||response.url()!==probe.href)throw Error('probe_response');
      samples.push({protocol:protocols.get(response.url())||'unknown',http3Advertised:/\bh3(?:-\d+)?\s*=/.test(response.headers()['alt-svc']||'')});
    }
  })();
  try{
    signal?.throwIfAborted();
    await Promise.race([operation,new Promise((_,reject)=>{abort=()=>reject(Error('aborted'));signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();timer=setTimeout(()=>reject(Error('timeout')),timeoutMs);})]);
    return {status:samples.some(s=>/^h3(?:-|$)/.test(s.protocol))?'observed':'not_observed',collectorHost:url.host,samples,
      reason:samples.some(s=>s.http3Advertised)?'tcp_fallback_observed':'collector_http3_not_advertised'};
  }catch{return {status:'unavailable',reason:signal?.aborted?'cancelled':'probe_failed',collectorHost:url.host};}
  finally{finished=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);if(page){let cleanup;try{await Promise.race([page.close().catch(()=>{}),new Promise(resolve=>cleanup=setTimeout(resolve,500))]);}finally{clearTimeout(cleanup);}}void cdp?.detach().catch(()=>{});}
}

/** TrackMe / tls.peet.ws schema. Never persist cookies, header values, randoms or session IDs. */
export function parseTransportObservation(data, { userAgent, protocol }) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.user_agent !== userAgent) throw Error('network_probe_identity_mismatch');
  const actual = data.http_version === 'h2' ? 'h2' : ['h3','HTTP/3'].includes(data.http_version) ? 'h3' : data.http_version === 'HTTP/1.1' ? 'http/1.1' : null;
  if (!actual || protocol && protocol !== actual) throw Error('network_probe_protocol_mismatch');
  const ja4 = data.tls?.ja4;
  if (ja4 !== undefined && (typeof ja4 !== 'string' || !ja4Pattern.test(ja4))) throw Error('invalid_network_probe_ja4');
  if (ja4 && (ja4.startsWith('q') !== (actual === 'h3'))) throw Error('network_probe_transport_mismatch');
  const frames = data.http2?.sent_frames;
  if (frames !== undefined && (!Array.isArray(frames) || frames.length > 64)) throw Error('invalid_network_probe_frames');
  const settings = [], windowUpdates = []; let pseudoHeaderOrder = [], headerNames = [];
  for (const frame of frames || []) {
    if (frame.frame_type === 'SETTINGS') {
      if (!Array.isArray(frame.settings) || frame.settings.length > 32) throw Error('invalid_network_probe_settings');
      for (const row of frame.settings) {
        if (typeof row !== 'string' || row.length > 160) throw Error('invalid_network_probe_settings');
        const match = /^([A-Z0-9_]+)\s*=\s*(\d+)$/.exec(row);
        if (!match || !settingsNames.has(match[1])) continue; // Ignore unknown/GREASE identifiers.
        const value = Number(match[2]);
        if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) throw Error('invalid_network_probe_settings');
        settings.push({name:match[1],value});
      }
    }
    if (frame.frame_type === 'WINDOW_UPDATE' && Number.isSafeInteger(frame.increment) && frame.increment > 0 && frame.increment <= 0x7fffffff) windowUpdates.push(frame.increment);
    if (frame.frame_type === 'HEADERS' && !pseudoHeaderOrder.length) {
      if (!Array.isArray(frame.headers) || frame.headers.length > 128) throw Error('invalid_network_probe_headers');
      for (const row of frame.headers) {
        if (typeof row !== 'string' || row.length > 65536) throw Error('invalid_network_probe_headers');
        const name = /^(?:([a-z][a-z0-9-]*)|(:[a-z][a-z0-9-]*)):/i.exec(row)?.slice(1).find(Boolean)?.toLowerCase();
        if (name?.startsWith(':')) pseudoHeaderOrder.push(name);
        else if (name && !['cookie','authorization','proxy-authorization'].includes(name)) headerNames.push(name);
      }
    }
  }
  const http2 = actual === 'h2' && settings.length && pseudoHeaderOrder.length
    ? {status:'measured',fingerprintAlgorithm:'orbit-h2-v1',settings,windowUpdates,pseudoHeaderOrder,headerNames,
      fingerprint:sha256({settings,windowUpdates,pseudoHeaderOrder})}
    : {status:actual === 'h2' ? 'incomplete' : 'not_negotiated'};
  const address = typeof data.ip === 'string' ? data.ip.replace(/^\[([^\]]+)\](?::\d+)?$/, '$1').replace(/^(\d+\.\d+\.\d+\.\d+):\d+$/, '$1') : '';
  return {protocol:actual,observedIp:isIP(address)?address:null,
    tls:ja4?{status:'measured',ja4}:{status:'incomplete'}, http2,
    http3:{status:actual==='h3'?'observed':'not_observed'} };
}

export function compareTransportReference(observation, reference, { runtimeVersion, locale, endpointHost }) {
  if (!reference) return {status:'reference_missing'};
  const applicable = reference.version===1 && reference.platform==='Android' && reference.browserVersion===runtimeVersion
    && reference.locale===locale && reference.collectorHost===endpointHost && reference.requestKind==='document-navigation'
    && reference.source==='physical-device' && Number.isFinite(Date.parse(reference.measuredAt));
  if (!applicable) return {status:'reference_inapplicable'};
  if (!ja4Pattern.test(reference.ja4 || '') || !/^[a-f0-9]{64}$/.test(reference.http2Fingerprint || '')) return {status:'reference_invalid'};
  if (observation.tls.status!=='measured'||observation.http2.status!=='measured') return {status:'measurement_incomplete'};
  const checks={ja4:observation.tls.ja4===reference.ja4,http2:observation.http2.fingerprint===reference.http2Fingerprint};
  return {status:Object.values(checks).every(Boolean)?'matched':'different',checks,referenceMeasuredAt:reference.measuredAt};
}

/** Real navigation in the task BrowserContext. No Node fetch, synthetic route or direct fallback. */
export async function observeNetworkTransport(context, profile, { endpoint, timeoutMs=12000, proxyScheme='unknown', runtimeVersion, signal, reference=null } = {}) {
  const url = networkProbeUrl(endpoint);
  if (!url) return unmeasuredTransport();
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs<100 || timeoutMs>30000) throw Error('invalid_network_probe_timeout');
  const report={...unmeasuredTransport(),status:'unavailable',reason:'probe_failed',source:'browser-navigation',collectorHost:url.host,
    checkedAt:new Date().toISOString(),runtimeVersion,proxyScheme, samples:[]};
  let page,cdp,timer,abort,finished=false;
  const protocols=new Map();
  const operation=(async()=>{
    page=await context.newPage();
    if(finished||signal?.aborted){await page.close().catch(()=>{});return;}
    cdp=await context.newCDPSession(page);await cdp.send('Network.enable');
    cdp.on('Network.responseReceived',event=>{if(event.type==='Document')protocols.set(event.response.url,event.response.protocol);});
    for(let i=0;i<2;i++){
      signal?.throwIfAborted();
      if(finished)throw Error('probe_finished');
      const probe=new URL(url);probe.searchParams.set('orbit_network_probe',randomUUID());
      const response=await page.goto(probe.href,{waitUntil:'domcontentloaded',timeout:timeoutMs});
      if(response)report.collectorHttpStatus=response.status();
      if(!response?.ok()||response.url()!==probe.href)throw Error('network_probe_response');
      if(Number(response.headers()['content-length'])>262144)throw Error('network_probe_size');
      const body=await response.body();if(finished||body.length>262144)throw Error('network_probe_size');
      const observation=parseTransportObservation(JSON.parse(body.toString('utf8')),{userAgent:profile.fingerprint.navigator.userAgent,protocol:protocols.get(response.url())});
      report.samples.push({sequence:i+1,...observation});
    }
    Object.assign(report,report.samples.at(-1),{status:'measured',reason:null});
    report.comparison=compareTransportReference(report,reference,{runtimeVersion,locale:profile.fingerprint.navigator.language,endpointHost:url.host});
    report.http3={status:report.samples.some(s=>s.protocol==='h3')?'observed':'not_observed',
      limitation:['http','https','socks5'].includes(proxyScheme)?'configured_proxy_has_no_browser_udp_tunnel':'route_support_not_confirmed'};
  })();
  try {
    signal?.throwIfAborted();
    await Promise.race([operation,new Promise((_,reject)=>{
      abort=()=>reject(Error('network_probe_aborted'));signal?.addEventListener('abort',abort,{once:true});
      if(signal?.aborted)abort();timer=setTimeout(()=>reject(Error('network_probe_timeout')),timeoutMs);
    })]);
  } catch(error) {
    report.status='unavailable';report.reason=signal?.aborted?'cancelled':'probe_failed';
    const message=typeof error?.message==='string'?error.message:'';
    const code=message.match(/net::(ERR_[A-Z_]+)/)?.[1];
    if(code)report.errorCode=code;
    else if(/^(?:network_probe_|invalid_network_probe_)[a-z_]+$/.test(message))report.errorCode=message;
  }
  finally {
    finished=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);
    if(page){let cleanup;try{await Promise.race([page.close().catch(()=>{}),new Promise(resolve=>cleanup=setTimeout(resolve,500))]);}finally{clearTimeout(cleanup);}}
    void cdp?.detach().catch(()=>{});
  }
  // No sensitive browser/transport errors or collector payloads enter the report.
  return report;
}
