const { createHash } = require('node:crypto');
const {setTimeout:delay}=require('node:timers/promises');
class TcpError extends Error { constructor(code) { super('TCP preset operation failed'); this.code = code; } }
const cache = new Map();
const text = value => typeof value === 'string' && value.length <= 160 ? value.replace(/[\x00-\x1f]/g, '') : null;
const family = name => /android/i.test(name) ? 'android' : /ios|iphone|ipad/i.test(name) ? 'ios' : 'other';
function client(token, fetchImpl = fetch, signal) {
 if (!token) throw new TcpError('tcp_key_missing');
 const once = async (command, params = {}) => {
  const url = new URL('https://mpsapi.com/api.html'); url.searchParams.set('command', command);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  try {
   const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.any([AbortSignal.timeout(35000), ...(signal?[signal]:[])]), redirect: 'error' });
   if (!response.ok) { await response.body?.cancel(); throw new TcpError(response.status === 429 ? 'tcp_rate_limit' : 'tcp_provider_unavailable'); }
   const reader = response.body.getReader(), chunks = []; let bytes = 0;
   try { while (true) { const {done, value} = await reader.read(); if (done) break; bytes += value.length; if (bytes > 1000000) throw new TcpError('tcp_invalid_response'); chunks.push(value); } }
   finally { await reader.cancel(); }
   const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
   if (!Array.isArray(data) && data?.status !== 'ok') throw new TcpError(/too many|rate.?limit|timeout 5 second/i.test(JSON.stringify(data))?'tcp_rate_limit':'tcp_provider_rejected');
   return data;
  } catch (error) { if (error instanceof TcpError) throw error; throw new TcpError('tcp_provider_unavailable'); }
 };
 const request=async(...args)=>{try{return await once(...args);}catch(error){if(error.code!=='tcp_rate_limit')throw error;await delay(5500,null,{signal});return once(...args);}};
 const cached = async command => { const key = createHash('sha256').update(token).digest('hex') + command; const old = cache.get(key); if (old?.until > Date.now()) return old.value; let value = await request(command, command === 'tcp_fp_profiles' ? {category:'mobile'} : {}); if(command==='get_my_proxy'){const rows=Array.isArray(value)?value:value.list;if(!Array.isArray(rows))throw new TcpError('tcp_invalid_response');value=rows.map(row=>Object.fromEntries(['proxy_id','proxy_host_ip','proxy_hostname','proxy_independent_http_host_ip','proxy_independent_http_hostname','proxy_http_port','proxy_independent_port','proxy_login'].map(key=>[key,row[key]])));} if (cache.size > 20) cache.clear(); cache.set(key, {value, until: Date.now()+60000}); return value; };
 return {
  async proxies() { const result = await cached('get_my_proxy'); const rows = Array.isArray(result) ? result : result.list; if (!Array.isArray(rows)) throw new TcpError('tcp_invalid_response'); return rows; },
  async presets() { const result = await cached('tcp_fp_profiles'); if (!Array.isArray(result.profiles)) throw new TcpError('tcp_invalid_response'); return [{id:0,name:'Native OS — исходный сетевой стек',family:'any',parameters:{}}, ...result.profiles.map(p=>({id:Number(p.profile_id),name:text(p.name),family:family(p.name),parameters:networkValues(p.profile_json)})).filter(p=>Number.isSafeInteger(p.id)&&p.id>0&&p.name&&Object.keys(p.parameters).length>=3)]; },
  async current(id) { const data = await request('tcp_fp_get',{proxy_id:id}); const row = data.proxy?.find(p=>String(p.proxy_id)===String(id)); if (!row || (row.profile_id != null && !Number.isSafeInteger(Number(row.profile_id)))) throw new TcpError('tcp_invalid_response'); return {profileId:row.profile_id==null?0:Number(row.profile_id),name:text(row.name)}; },
  async apply(id, profileId) { const result = await request('tcp_fp_apply',{proxy_id:id,profile_id:profileId}); if (Number(result.applied)!==1 || Number(result.skipped||0)!==0 || Number(result.profile_id??0)!==profileId) throw new TcpError('tcp_apply_rejected'); },
  async diagnose(id) { return sanitizeDiagnostic(await request('tcp_fp_diagnose',{proxy_id:id})); },
 };
}
function resolveProviderId(proxy, rows) {
 const matched = rows.filter(row=>[row.proxy_host_ip,row.proxy_hostname,row.proxy_independent_http_host_ip,row.proxy_independent_http_hostname].some(host=>typeof host==='string'&&host.toLowerCase()===proxy.host.toLowerCase()) && [row.proxy_http_port,row.proxy_independent_port].some(port=>Number(port)===proxy.port) && row.proxy_login===proxy.username);
 if (matched.length!==1 || !/^\d{1,12}$/.test(String(matched[0].proxy_id))) throw new TcpError('tcp_proxy_not_found');
 return String(matched[0].proxy_id);
}
const fieldNames = ['ttl','win','mss','wscale','sack','ts','df','ecn','options'];
function networkValues(input) {
 if (!input || typeof input!=='object' || Array.isArray(input)) return {};
 const out = {}; for (const key of [...fieldNames,'distance']) { let value = input[key]; if(key==='win') value ??= input.window;
 if (typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean') out[key]=value;
 else if (key==='options' && typeof value==='string' && value.length<600) out[key]=value;
 else if (key==='options' && Array.isArray(value) && value.length<30 && value.every(v=>typeof v==='string'&&v.length<40)) out[key]=value;
 } return out;
}
function sanitizeDiagnostic(data) {
 if (!data || typeof data!=='object') throw new TcpError('tcp_invalid_response');
 const observed=networkValues(data.observed), expected=networkValues(data.expected);
 const comparisons=fieldNames.filter(key=>key in expected).map(key=>{
  let actual=observed[key]; const wanted=expected[key];
  if(key==='ttl' && typeof actual==='number' && Number.isFinite(observed.distance)) actual+=observed.distance;
  const match=key==='mss' && typeof actual==='number' && typeof wanted==='number' ? actual<=wanted&&actual>=wanted-100 : JSON.stringify(actual)===JSON.stringify(wanted);
  return {field:key,expected:wanted,observed:actual??null,match};
 });
 const captured=data.observed?.captured_at;const captureDate=typeof captured==='number'?new Date(captured<1e12?captured*1000:captured):typeof captured==='string'?new Date(captured):null;
 return {capturedAt:captureDate&&Number.isFinite(captureDate.getTime())?captureDate.toISOString():null,checkedAt:new Date().toISOString(),cached:data.cached===true,osGuess:text(data.os_guess),observed,expected,comparisons,matches:comparisons.filter(p=>p.match).length,total:comparisons.length,dataAvailable:Object.keys(observed).length>=3 && data.comparison?.data_available!==false,verified:comparisons.length>=3 && comparisons.every(p=>p.match)};
}
const compatible = (proxy, profile) => { const tcp=proxy.tcpChannel; if (!tcp) return true; if (tcp.status==='failed') return false; if (tcp.family==='any') return true; let passport=profile?.fingerprint; if(typeof passport==='string') {try{passport=JSON.parse(passport);}catch{passport=null;}} const ua=passport?.fingerprint?.navigator?.userAgent || passport?.navigator?.userAgent || ''; const os=/iPhone|iPad|iPod/.test(ua)?'ios':'android'; return tcp.family===os; };
function channelDiagnostic(config, diagnostic) {
 const result=config.profileId===0?diagnostic:sanitizeDiagnostic({observed:diagnostic.observed,expected:config.parameters,os_guess:diagnostic.osGuess,cached:diagnostic.cached,comparison:{data_available:diagnostic.dataAvailable}});
 result.checkedAt=diagnostic.checkedAt;result.capturedAt=diagnostic.capturedAt;
 const applied=config.appliedAt?new Date(config.appliedAt).getTime():0;
 const fresh=diagnostic.capturedAt?new Date(diagnostic.capturedAt).getTime()>=applied:config.status==='applied'||!diagnostic.cached;
 result.fresh=fresh;
 return {diagnostic:result,verified:fresh&&(config.profileId===0?result.dataAvailable:result.verified)};
}
module.exports = { channelDiagnostic, client, TcpError, resolveProviderId, sanitizeDiagnostic, compatible, family };
