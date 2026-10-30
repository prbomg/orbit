const EVENTS = ['warmup_run_context','warmup_run_finished','warmup_scroll','warmup_link_clicked','warmup_link_skipped','warmup_storage_check','warmup_site_completed','warmup_site_partial','warmup_site_skipped','session_saved','retry_scheduled','attempt_failed','attempt_stopped','attempt_interrupted'];
const percentile = (values, p) => { const sorted = values.filter(v => Number.isFinite(v) && v >= 0).sort((a,b) => a-b); return sorted.length ? sorted[Math.ceil(p * sorted.length) - 1] : null; };
const rate = (passed, total) => total ? Math.round(1000 * passed / total) / 10 : null;
function aggregate(events) {
  const runs = new Map(), domains = new Map();
  for (const e of events) {
    if (!e.runId) continue;
    if (!runs.has(e.runId)) runs.set(e.runId, { metadata: {}, events: [] });
    const run = runs.get(e.runId); run.events.push(e);
    if (e.event === 'warmup_run_context' || e.event === 'warmup_run_finished') Object.assign(run.metadata, e.details);
    const d = e.details || {};
    if (['warmup_site_completed','warmup_site_partial','warmup_site_skipped'].includes(e.event) && d.domain) {
      if (!domains.has(d.domain)) domains.set(d.domain, []);
      domains.get(d.domain).push(e);
    }
  }
  function summarize(list) {
    let passed=0, failed=0, stopped=0, unknown=0, actions=0, noEffect=0, restored=0, storageChecks=0;
    const durations=[], preparation=[], reasons={};
    for (const run of list) {
      const finished=run.events.findLast(e=>e.event==='warmup_run_finished');
      const saved=run.events.findLast(e=>e.event==='session_saved');
      const failure=run.events.findLast(e=>['retry_scheduled','attempt_failed','attempt_interrupted'].includes(e.event));
      const outcome=finished?.details?.outcome || (saved?'passed':failure?'failed':null);
      if(outcome==='passed')passed++;else if(outcome==='failed')failed++;else if(outcome==='stopped')stopped++;else unknown++;
      if(finished && Number.isFinite(finished.details.durationMs))durations.push(finished.details.durationMs);
      if(saved && Number.isFinite(saved.details?.preparationMs))preparation.push(saved.details.preparationMs);
      const reason=finished?.details?.reason || failure?.details?.reason;
      if(reason)reasons[reason]=(reasons[reason]||0)+1;
      for(const e of run.events){const d=e.details||{};
        if(e.event==='warmup_scroll' && Number.isFinite(d.movedPixels)){actions++;if(!d.movedPixels && d.reason!=='boundary' && d.result!=='boundary')noEffect++;}
        if(e.event==='warmup_link_clicked'||e.event==='warmup_link_skipped'){actions++;if(e.event==='warmup_link_skipped')noEffect++;}
        if(e.event==='warmup_storage_check'){storageChecks++;if(d.result==='passed')restored++;}
      }
    }
    return {runs:list.length,passed,failed,stopped,unknown,successRate:rate(passed,passed+failed),actions,noEffect,noEffectRate:rate(noEffect,actions),storageChecks,restored,restoreRate:rate(restored,storageChecks),durationSamples:durations.length,p50Ms:percentile(durations,.5),p95Ms:percentile(durations,.95),preparedSamples:preparation.length,preparationP50Ms:percentile(preparation,.5),reasons:Object.entries(reasons).map(([reason,count])=>({reason,count})).sort((a,b)=>b.count-a.count)};
  }
  const list=[...runs.values()];
  const breakdown={};
  for(const key of ['release','model','storageMode','preset']){
    const groups=new Map();for(const run of list){const value=run.metadata[key]||'unknown';if(!groups.has(value))groups.set(value,[]);groups.get(value).push(run);}
    breakdown[key]=[...groups].map(([value,group])=>({value,...summarize(group)}));
  }
  return {summary:summarize(list),breakdown,domains:[...domains].map(([domain,rows])=>({domain,visits:rows.length,passed:rows.filter(e=>e.event==='warmup_site_completed').length,partial:rows.filter(e=>e.event==='warmup_site_partial').length,failed:rows.filter(e=>e.event==='warmup_site_skipped').length,p50Ms:percentile(rows.map(e=>e.details?.durationMs),.5)})).sort((a,b)=>b.visits-a.visits)};
}
module.exports={EVENTS,aggregate,percentile};
