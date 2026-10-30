const schedule = require('./projectSchedule');
function taskState(task, run, now = Date.now()) {
  const count = task.executions?.filter(e => e.status === 'running').length || 0;
  if (count && ['running','waiting','stopping'].includes(run?.state)) return {kind:'running',label:run.state==='stopping'||task.status==='paused'?'Завершает остановку':'Выполняется',count};
  if (task.status === 'failed') return {kind:'error',label:'Остановлена с ошибкой',code:task.retryState?.code};
  if (task.status === 'completed') return {kind:'completed',label:'Завершена'};
  if (task.status === 'paused') return {kind:'paused',label:'На паузе'};
  if (!['running','waiting'].includes(run?.state)) return {kind:'waiting',label:'Ожидает запуска проекта'};
  if (run.waitReason === 'schedule') return {kind:'schedule',label:'Ожидает расписания'};
  const deadline = task.retryState?.retryAfter;
  if (deadline && Date.parse(deadline) > now) return {kind:'retry',label:task.retryState?.code==='search_rate_limited'?'Пауза после HTTP 429':'Пауза после ошибки',until:deadline,code:task.retryState?.code};
  if (task.dailyWaitReason === 'daily_limit' || task.dailyWaitReason === 'daily_schedule') return {kind:'schedule',label:task.dailyWaitReason==='daily_limit'?'Дневной лимит':'По дневному плану',until:task.nextExecutionAt};
  if (run.waitReason === 'rate_limit') return {kind:'retry',label:'Пауза после HTTP 429',code:'search_rate_limited'};
  if (run.waitReason === 'profiles_or_proxies') return {kind:'resources',label:'Ожидает профиля или прокси'};
  return {kind:'waiting',label:'Ожидает следующей попытки'};
}
function nextScheduleWindow(project, now = Date.now()) {
  if (!/^[01]{168}$/.test(project.scheduleHours || '') || !project.scheduleHours.includes('1') || !schedule.validTimezone(project.scheduleTimezone)) return null;
  let at = new Date(now);
  const formatter = new Intl.DateTimeFormat('en-GB', {timeZone:project.scheduleTimezone,minute:'2-digit',second:'2-digit'});
  for (let i=0;i<170;i++) {
    if (schedule.isAllowed(project,at)) return at.toISOString();
    const parts=formatter.formatToParts(at), minute=Number(parts.find(p=>p.type==='minute').value), second=Number(parts.find(p=>p.type==='second').value);
    at=new Date(+at+(60-minute)*60000-second*1000-at.getMilliseconds());
  }
  return null;
}
function nextTaskWindow(project, task, run, now = Date.now()) {
  if (!['running','waiting'].includes(run?.state)) return null;
  const state = taskState(task, run, now);
  const dates = [state.until, task.retryState?.retryAfter, task.nextExecutionAt].filter(Boolean).map(Date.parse).filter(at=>Number.isFinite(at)&&at>now);
  if (!dates.length && (state.kind !== 'schedule' || run.waitReason !== 'schedule')) return null;
  if (state.kind === 'paused' || state.kind === 'completed' || state.kind === 'error') return null;
  return nextScheduleWindow(project, Math.max(now, ...dates));
}
module.exports = { taskState, nextScheduleWindow, nextTaskWindow };
