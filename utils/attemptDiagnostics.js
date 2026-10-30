const {networkSnapshot}=require('./proxyNetwork.js');
const services=new Set(['rucaptcha','capguru']);
const stageLabels={preparation:'Начало попытки',proxy:'Прокси и IP',navigation:'Загрузка и поиск',captcha:'Капча',scenario:'Сценарий на сайте',result:'Результат'};
const stamp=value=>value?new Date(value).getTime():NaN;
function scopedEvents(execution,events,now=Date.now()){
 const start=stamp(execution.startedAt),end=stamp(execution.completedAt);
 return events.filter(e=>Number.isFinite(stamp(e.time))&&stamp(e.time)<=now&&(!Number.isFinite(start)||stamp(e.time)>=start)&&(!Number.isFinite(end)||stamp(e.time)<=end+1000)).sort((a,b)=>stamp(a.time)-stamp(b.time)||(a._offset||0)-(b._offset||0));
}
function networkForExecution(execution,network,events,now=Date.now()){
 const start=stamp(execution.startedAt),end=stamp(execution.completedAt);
 const fresh=n=>n?.checkedAt&&stamp(n.checkedAt)<=now&&(!Number.isFinite(start)||stamp(n.checkedAt)>=start)&&(!Number.isFinite(end)||stamp(n.checkedAt)<=end+1000);
 let observed=null;
 for(const event of events){if(!['proxy_ip_observed','proxy_ip_check_failed','proxy_ip_check_skipped','proxy_ip_check_started','proxy_configured'].includes(event.event))continue;
  const previous={...(observed||{})};if(['proxy_configured','proxy_ip_check_started'].includes(event.event))for(const key of ['browserIp','workerIp','previousIp','ipComparison','routeComparison'])delete previous[key];
  observed=networkSnapshot({...previous,...event,executionId:execution.id,checkedAt:event.time,checkStatus:event.event==='proxy_ip_observed'?'observed':event.event==='proxy_ip_check_failed'?'failed':event.event==='proxy_ip_check_skipped'?'disabled':'pending'});
 }
 if(network&&(!network.executionId||network.executionId===execution.id)&&fresh(network)&&(!observed||stamp(network.checkedAt)>=stamp(observed.checkedAt)))return networkSnapshot(network);
 return observed;
}
function captchaRequests(events){
 const requests=[],switches=[];let active=null,pending=null;
 const create=(service,time)=>{const item={service:services.has(service)?service:'unknown',startedAt:time,solutionAt:null,providerError:null,submissionError:null,verified:false,httpStatus:null,http429:false};requests.push(item);active=item;pending=null;return item;};
 for(const e of events){
  if(e.event==='captcha_detected'){if(pending)create('unknown',pending);active=null;pending=null;}
  if(e.event==='captcha_requested'){if(pending)create('unknown',pending);active=null;pending=e.time;}
  if(e.event==='captcha_service_selected')create(e.service,e.time);
  if(e.event==='captcha_service_switched')switches.push({from:services.has(e.previousService)?e.previousService:'unknown',to:services.has(e.service)?e.service:'unknown',time:e.time});
  if(['captcha_coordinates_received','captcha_token_received'].includes(e.event)){
   if(!active)create(e.service,pending||e.time);active.solutionAt=e.time;
  }
  if(e.event==='captcha_service_failed'){
   if(!active)create(e.service,pending||e.time);
   if(active.solutionAt)active.submissionError||=e.code||'unknown';else active.providerError||=e.code||'unknown';
  }
  if(e.event==='captcha_failed'){
   if(!active&&pending)create(e.service,pending);
   if(active){if(active.solutionAt)active.submissionError||=e.code||'unknown';else active.providerError||=e.code||'unknown';}
  }
  if(active&&['captcha_page_loaded','captcha_document_verified'].includes(e.event)&&e.status>=200&&e.status<300)active.verified=true;
  if(active&&['captcha_page_load_failed','captcha_document_failed'].includes(e.event)&&e.status>=400){active.httpStatus=e.status;if(e.status===429)active.http429=true;}
 }
 if(pending)create('unknown',pending);
 return {requests,switches};
}
function attemptDiagnostics(execution,log,network,assignedProxy=null,now=Date.now(),options={}){
 const events=scopedEvents(execution,log.events,now),observed=networkForExecution(execution,network,events,now);
 const stages=[];const start=stamp(execution.startedAt),finish=stamp(execution.completedAt),end=Number.isFinite(finish)?Math.min(finish,now):execution.status==='running'?now:null;
 if(options.includeStages!==false){
 if(events.length&&Number.isFinite(start))stages.push({kind:'preparation',label:stageLabels.preparation,startedAt:new Date(start).toISOString(),endedAt:null,durationMs:null,state:'unconfirmed',events:[],eventCount:0,errors:0});
 let current=stages.at(-1);
 function category(e){
  if(e.event.startsWith('proxy_'))return 'proxy';
  if(e.event.startsWith('captcha_'))return 'captcha';
  if(e.event.startsWith('search_'))return 'navigation';
  if(e.event.startsWith('navigation'))return ['captcha','scenario'].includes(current?.kind)?current.kind:'navigation';
  if(/^(target_|visit_|action_)/.test(e.event))return 'scenario';
  if(['session_completed','session_failed','session_search_missed','profile_saved'].includes(e.event))return 'result';
  return null;
 }
 for(const e of events){const kind=category(e);if(!kind)continue;
  if(current?.kind!==kind){if(current){current.endedAt=e.time;current.durationMs=Math.max(0,stamp(e.time)-stamp(current.startedAt));current.state='finished';}
   current={kind,label:stageLabels[kind],startedAt:e.time,endedAt:null,durationMs:null,state:'unconfirmed',events:[],eventCount:0,errors:0};stages.push(current);}
  current.eventCount++;if(e.errorType||e.status>=400||/_failed$/.test(e.event))current.errors++;
  if(current.events.length<40)current.events.push(e);else current.events[current.events.length-1]=e;
 }
 if(current){current.endedAt=end===null?null:new Date(Math.max(stamp(current.startedAt),end)).toISOString();current.durationMs=end===null?null:Math.max(0,end-stamp(current.startedAt));current.state=execution.status==='running'?'active':execution.errorCode==='stopped'?'stopped':execution.status==='failed'?'failed':execution.status==='completed'?'finished':'unconfirmed';}
 }
 const warnings=[];
 if(!observed?.browserIp)warnings.push(observed?.checkStatus==='disabled'?'Проверка IP была отключена.':observed?.checkStatus==='failed'?'Проверка IP завершилась ошибкой.':'Измерение IP этой попытки не сохранено.');
 if(observed?.routeComparison==='matches_worker')warnings.push('IP браузера совпал с внешним IP сервера. Проверьте маршрут и настройки прокси; одно совпадение не доказывает отсутствие прокси.');
 if(execution.proxyId&&observed?.proxyId&&execution.proxyId!==observed.proxyId)warnings.push('Прокси в журнале отличается от назначенного в записи попытки.');
 if(assignedProxy&&observed?.proxyHost&&(assignedProxy.host!==observed.proxyHost||assignedProxy.port!==observed.proxyPort))warnings.push('Адрес прокси в журнале отличается от текущих настроек. Настройки могли измениться после запуска.');
 if(log.truncated)warnings.push('Журнал большой: диагностирована только последняя часть.');
 if(log.invalidLines)warnings.push('Некоторые строки журнала повреждены и пропущены.');
 const navigation=options.includeStages===false?[]:events.filter(e=>e.event==='navigation_response').slice(-30);
 return {executionId:execution.id,startedAt:execution.startedAt,profile:execution.profile||null,assignedProxy,network:observed,warnings,failureSnapshot: [...events].reverse().find(e => e.event === 'search_failure_snapshot') || null,coverage:{available:log.available,eventCount:events.length,truncated:log.truncated,invalidLines:log.invalidLines},stages:stages.slice(-100),navigation,captcha:captchaRequests(events),retryAfterMs:Math.max(0,...events.map(e=>e.retryAfterMs||0))};
}
function quantile(values,p){if(!values.length)return null;const sorted=[...values].sort((a,b)=>a-b);const index=(sorted.length-1)*p,lower=Math.floor(index),upper=Math.ceil(index);return sorted[lower]+(sorted[upper]-sorted[lower])*(index-lower);}
function aggregateDiagnostics(records){
 const providers=new Map(),ips=new Map(),errors=new Map(),projects=new Map(),proxies=new Map(),switches=new Map();let available=0,truncated=0,invalidLines=0,observed=0,matchesWorker=0,withCaptcha=0;
 const counts={completed:0,failed:0,stopped:0,running:0,other:0};
 for(const {execution:e,diagnostic:d} of records){
  const outcome=e.errorCode==='stopped'?'stopped':['completed','failed','running'].includes(e.status)?e.status:'other';counts[outcome]++;
  const project=e.task?.project,projectKey=project?.id||'none',group=projects.get(projectKey)||{id:project?.id||null,name:project?.name||'Без проекта',completed:0,failed:0,total:0};group.total++;if(outcome==='completed')group.completed++;if(outcome==='failed')group.failed++;projects.set(projectKey,group);
  if(outcome==='failed'){const code=e.errorCode||'unknown';errors.set(code,(errors.get(code)||0)+1);}
  if(d.coverage.available&&d.coverage.eventCount)available++;if(d.coverage.truncated)truncated++;invalidLines+=d.coverage.invalidLines;
  const proxyKey=e.proxyId||d.network?.proxyId||'none',proxy=proxies.get(proxyKey)||{id:proxyKey==='none'?null:proxyKey,label:d.assignedProxy?`${d.assignedProxy.host}:${d.assignedProxy.port}`:d.network?.proxyHost?`${d.network.proxyHost}:${d.network.proxyPort}`:'Не сохранён',total:0,completed:0,failed:0,observed:0,matchesWorker:0,ips:new Set()};proxy.total++;if(outcome==='completed')proxy.completed++;if(outcome==='failed')proxy.failed++;
  if(d.network?.checkStatus==='observed'&&d.network.browserIp){observed++;proxy.observed++;proxy.ips.add(d.network.browserIp);const ip=ips.get(d.network.browserIp)||{ip:d.network.browserIp,total:0,failed:0,proxies:new Set(),latestAt:null};ip.total++;if(outcome==='failed')ip.failed++;if(proxyKey!=='none')ip.proxies.add(proxyKey);if(!ip.latestAt||d.network.checkedAt>ip.latestAt)ip.latestAt=d.network.checkedAt;ips.set(ip.ip,ip);}
  if(d.network?.routeComparison==='matches_worker'){matchesWorker++;proxy.matchesWorker++;}proxies.set(proxyKey,proxy);
  if(d.captcha.requests.length)withCaptcha++;
  for(const req of d.captcha.requests){const p=providers.get(req.service)||{service:req.service,requests:0,solutions:0,providerErrors:0,submissionErrors:0,verified:0,httpFailures:0,http429:0,latencies:[],codes:new Map()};p.requests++;if(req.solutionAt){p.solutions++;const ms=stamp(req.solutionAt)-stamp(req.startedAt);if(ms>=0)p.latencies.push(ms);}if(req.providerError){p.providerErrors++;p.codes.set(req.providerError,(p.codes.get(req.providerError)||0)+1);}if(req.submissionError)p.submissionErrors++;if(req.verified)p.verified++;if(req.httpStatus>=400)p.httpFailures++;if(req.http429)p.http429++;providers.set(req.service,p);}
  for(const item of d.captcha.switches){const key=`${item.from}:${item.to}`,s=switches.get(key)||{from:item.from,to:item.to,count:0};s.count++;switches.set(key,s);}
 }
 return {counts,coverage:{selected:records.length,logs:available,truncated,invalidLines,observedIp:observed,matchesWorker,withCaptcha},errors:[...errors].map(([code,count])=>({code,count})).sort((a,b)=>b.count-a.count),projects:[...projects.values()].sort((a,b)=>b.failed-a.failed||b.total-a.total),proxies:[...proxies.values()].map(p=>({...p,ips:p.ips.size})).sort((a,b)=>b.failed-a.failed||b.total-a.total),ips:[...ips.values()].map(ip=>({...ip,proxies:ip.proxies.size})).sort((a,b)=>b.total-a.total),providers:[...providers.values()].map(({latencies,codes,...p})=>({...p,latencySamples:latencies.length,medianMs:quantile(latencies,.5),p95Ms:quantile(latencies,.95),codes:[...codes].map(([code,count])=>({code,count})).sort((a,b)=>b.count-a.count)})),switches:[...switches.values()]};
}
module.exports={scopedEvents,networkForExecution,captchaRequests,attemptDiagnostics,aggregateDiagnostics};
