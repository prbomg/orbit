"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Activity, AlertTriangle, ArrowRight, CheckCheck, Clock3, FolderKanban, Network, Users, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useData } from "@/lib/data-store";
import { taskState, nextTaskWindow } from "@/utils/dashboardState";
import type { DashboardStats } from "@/utils/dashboardStats";
type Project = {id:string;name:string;targetUrl:string;scheduleTimezone:string;scheduleHours:string};
type Recent = {id:string;taskId:string;status:string;completedAt:string;errorCode:string|null;task:{url:string;project:{name:string;targetUrl:string}|null}};
type Overview = {stats:DashboardStats;outcome:string;projects:Project[];resources:{freeProfiles:number;enabledProxies:number;targetProxies:number};recent:Recent[];checkedAt:string};
const date = (at:string, zone='Europe/Moscow') => new Date(at).toLocaleString('ru-RU',{timeZone:zone,day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
const errorLabels:Record<string,string> = {search_rate_limited:'HTTP 429: ограничение частоты запросов',ERROR_CAPTCHA_UNSOLVABLE:'Сервис капчи не распознал задание',incorrect_limit:'Лимит некорректных решений капчи',solve_limit:'Лимит платных решений капчи',proxy_check_failed:'Прокси не открыл сайт',worker_interrupted:'Исполнитель прерван',ERROR_SUBMIT_TIMEOUT:'Таймаут отправки задания в сервис капчи',image_capture_failed:'Не удалось получить изображение капчи'};
export default function AnalyticsOverview() {
  const {tasks,system,loading,error:dataError,refresh:refreshTasks} = useData();
  const [historyExpanded,setHistoryExpanded]=useState(false);
  const [period,setPeriod]=useState<'today'|'week'>('today'), [outcome,setOutcome]=useState('all');
  const [data,setData]=useState<Overview|null>(null),[error,setError]=useState(''),[updating,setUpdating]=useState(true),[refresh,setRefresh]=useState(0);
  useEffect(()=>{
    const controller=new AbortController();let pending=false;
    async function load(){
      if(pending||document.visibilityState==='hidden')return;pending=true;setUpdating(true);
      try{const response=await fetch(`/api/dashboard/?period=${period}&outcome=${outcome}`,{cache:'no-store',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)])});if(!response.ok)throw Error('Не удалось обновить обзор');const body=await response.json();if(!controller.signal.aborted){setData(body);setError('');}}
      catch{if(!controller.signal.aborted)setError('Не удалось обновить обзор. Показанные данные могут быть устаревшими.');}
      finally{pending=false;if(!controller.signal.aborted)setUpdating(false);}
    }
    void load();const timer=setInterval(()=>void load(),30000);const focus=()=>void load();document.addEventListener('visibilitychange',focus);
    return()=>{controller.abort();clearInterval(timer);document.removeEventListener('visibilitychange',focus);};
  },[period,outcome,refresh]);
  const rows=tasks.map(task=>{const run=system?.projectRuns?.find(r=>r.projectId===task.projectId) || (system?.projectRun?.projectId===task.projectId?system.projectRun:undefined);return {task,run,state:taskState(task,run)};});
  const running=rows.reduce((sum,row)=>sum+(row.state.kind==='running'?(row.state.count||0):0),0);
  const waiting=rows.filter(r=>['waiting','schedule','retry','resources'].includes(r.state.kind)).length;
  const problems=rows.filter(r=>r.state.kind==='error'||r.state.kind==='retry'||r.state.kind==='resources'||r.task.status==='running'&&(r.task.retryState?.count||0)>0).sort((a,b)=>Number(b.state.kind==='error')-Number(a.state.kind==='error'));
  const projects=(data?.projects||[]).map(project=>{
    const items=rows.filter(r=>r.task.projectId===project.id),active=items.filter(r=>r.state.kind==='running'),run=system?.projectRuns?.find(r=>r.projectId===project.id);
    const failures=items.filter(r=>r.state.kind==='error').length;
    const pending=items.filter(r=>['waiting','schedule','retry','resources'].includes(r.state.kind));
    const label=active.length?(failures?'Выполняется · есть ошибки':'Выполняется'):failures?'Есть ошибки':run?.state==='stopping'?'Останавливается':pending.length?pending[0].state.label:items.length&&items.every(r=>r.state.kind==='completed')?'Завершён':items.length?'Приостановлен':'Нет задач';
    const nextDates=pending.map(r=>nextTaskWindow(project,r.task,r.run)).filter((v):v is string=>Boolean(v)).sort();
    const nextAt=nextDates[0] || null;
    return {project,items,label,active:active.length,failures,nextAt,completed:items.reduce((s,r)=>s+r.task.currentExecutions,0),target:items.reduce((s,r)=>s+r.task.targetExecutions,0),waiting:pending.length};
  }).sort((a,b)=>b.failures-a.failures||b.active-a.active||b.waiting-a.waiting);
  const workingProjects=projects.filter(p=>p.active).length, waitingProjects=projects.filter(p=>!p.active&&p.waiting).length,pausedProjects=projects.filter(p=>p.label==='Приостановлен').length;
  const ready=!loading&&!dataError;
  const statsReady=data!==null;
  const matchingHistory=data?.stats.period===period&&data?.outcome===outcome;
  const history=(filter='all')=>{setPeriod('today');setOutcome(filter);setHistoryExpanded(true);};
  const metrics=[
    {title:'Выполняется сейчас',value:ready?running:null,detail:'параллельных выполнений',icon:Activity,href:'/tasks/?view=running'},
    {title:'Ожидают запуска',value:ready?waiting:null,detail:'задач с разрешённым запуском',icon:Clock3,href:'/tasks/?view=waiting'},
    {title:'Успешно сегодня',value:statsReady?data.stats.today.completed:null,detail:'завершённых попыток · Москва',icon:CheckCheck,href:'#dashboard-attempts',filter:'completed'},
    {title:'Ошибок сегодня',value:statsReady?data.stats.today.failed:null,detail:'неуспешных попыток · Москва',icon:XCircle,href:'#dashboard-attempts',filter:'failed'},
  ];
  const max=Math.max(1,...(data?.stats.buckets.map(b=>b.completed+b.failed)||[0]));
  return <div className="analytics-overview">

    {(error||dataError)&&<div className="dashboard-error" role="alert"><p>{error||'Не удалось обновить состояния задач. Данные могут быть устаревшими.'}</p><Button variant="outline" onClick={()=>{setRefresh(n=>n+1);void refreshTasks();}}>Повторить обновление</Button></div>}
    <section className="panel dashboard-status"><Activity size={20} className={running?'text-primary':'text-muted-foreground'}/><div><h2>{error&&!data?'Данные обзора недоступны':dataError?'Состояния задач не обновлены':!ready||!data?'Проверяем состояние проектов…':system?.workerState==='unknown'?'Состояние исполнителей неизвестно':system?.workerState==='stale'?'Исполнитель завершился неожиданно':running?`Сейчас выполняется: ${running}`:workingProjects+waitingProjects?'Проекты ожидают следующего запуска':projects.length?'Проекты сейчас не выполняются':'Создайте первый проект'}</h2><p>{data&&ready?`Проекты: в работе — ${workingProjects} · ожидают — ${waitingProjects} · на паузе — ${pausedProjects} · с ошибками — ${projects.filter(p=>p.failures).length}`:'Загружаем текущие состояния'}</p></div></section>
    <div className="dashboard-metrics">{metrics.map(metric=><Link key={metric.title} href={metric.href} onClick={()=>{if(metric.filter)history(metric.filter);}} className={`stat-card ${metric.title==='Ошибок сегодня'&&metric.value?'dashboard-metric-warning':''}`}><div className="stat-top"><span>{metric.title}</span><metric.icon size={18}/></div><div className="stat-value mono">{metric.value===null?'—':metric.value.toLocaleString('ru-RU')}</div><div className="stat-bottom">{metric.detail}<ArrowRight size={13}/></div></Link>)}</div>
    <section className="panel dashboard-attention"><div className="panel-heading"><div><h2>Требует внимания <span className="count-pill">{ready?problems.length:'—'}</span></h2><p>Ошибки и причины ожидания задач</p></div><AlertTriangle size={19} className={problems.length?'text-amber-300':'text-muted-foreground'}/></div>
      {!ready?<p className="dashboard-empty">Состояния пока недоступны.</p>:problems.length?<div className="dashboard-list">{problems.slice(0,5).map(({task,state})=><div className="dashboard-row" key={task.id}><div className="min-w-0"><strong>{task.project?.name||task.url||'Задача'}</strong><p>{state.kind==='error'?'Задача остановлена с ошибкой':state.label}{(state.code||task.retryState?.code)?` · ${errorLabels[state.code||task.retryState!.code!]||state.code||task.retryState?.code}`:''}</p>{state.until&&<p>Следующая попытка не раньше {date(state.until,task.project?.scheduleTimezone)} · {task.project?.scheduleTimezone||'Europe/Moscow'}</p>}</div><Link className="dashboard-action" href={`/tasks/${task.id}/live/`}>Наблюдать<ArrowRight size={14}/></Link></div>)}</div>:<p className="dashboard-empty">У текущих задач нет ошибок или ожидания ресурсов.{projects.length?' Приостановленные проекты можно запустить в разделе «Проекты».':''}</p>}
      {problems.length>5&&<Link href="/tasks/" className="dashboard-more">Все задачи с состояниями →</Link>}
    </section>
    <section className="panel dashboard-projects"><div className="panel-heading"><div><h2>Проекты</h2><p>Состояние, прогресс и ближайшее окно запуска</p></div><Link href="/projects/" className="text-link">Все проекты<ArrowRight size={14}/></Link></div>
      {!data?<p className="dashboard-empty">{updating?'Загружаем проекты…':'Список проектов недоступен.'}</p>:projects.length?<div className="dashboard-list">{projects.slice(0,6).map(({project,label,target,completed,nextAt,failures,items})=><div key={project.id} className="dashboard-row"><div className="dashboard-project-name"><strong>{project.name}</strong><p className={failures?'text-amber-300':''}>{ready?label:'Состояние недоступно'}</p>{nextAt&&ready&&<p>Ближайшее окно: {date(nextAt,project.scheduleTimezone)} · {project.scheduleTimezone}</p>}</div><div className="dashboard-progress"><span>{ready?`${completed.toLocaleString('ru-RU')} / ${target.toLocaleString('ru-RU')}`:'—'}</span><div role="progressbar" aria-label={`Прогресс ${project.name}`} aria-valuemin={0} aria-valuemax={target||1} aria-valuenow={Math.min(completed,target)}><i style={{width:`${target?Math.min(100,completed/target*100):0}%`}}/></div><small>{items.length?'выполнений по задачам':'Добавьте задачу в проект'}</small></div><Link className="dashboard-action" href={`/projects/${project.id}/`}>Открыть<ArrowRight size={14}/></Link></div>)}</div>:<div className="dashboard-empty"><p>Проектов пока нет. Создайте проект, затем добавьте задачу.</p><Button asChild className="mt-4"><Link href="/projects/">Создать проект</Link></Button></div>}
    </section>
    <section className="panel dashboard-history" id="dashboard-history"><div className="panel-heading"><div><h2>Динамика выполнений</h2><p>Сохранённые завершённые попытки · Москва, UTC+3</p></div><div className="dashboard-switch" role="group" aria-label="Период статистики"><button aria-pressed={period==='today'} onClick={()=>setPeriod('today')}>Сегодня</button><button aria-pressed={period==='week'} onClick={()=>setPeriod('week')}>7 дней</button></div></div>
      <div className="dashboard-chart-caption"><span><i className="chart-success"/>Успешно: {matchingHistory?data.stats.totals.completed:'—'}</span><span><i className="chart-failed"/>Ошибки: {matchingHistory?data.stats.totals.failed:'—'}</span>{updating&&<span role="status">Обновляем…</span>}</div>
      {matchingHistory?<><div className={`dashboard-chart ${period==='today'?'dashboard-chart-hours':''}`} aria-label="Выполнения по времени">{data.stats.buckets.map(b=><div className="dashboard-chart-column" key={b.at} title={`${b.label}: успешно ${b.completed}, ошибки ${b.failed}`}><div className="dashboard-chart-stack" style={{height:`${(b.completed+b.failed)/max*100}%`}}><i className="chart-failed" style={{flex:b.failed}}/><i className="chart-success" style={{flex:b.completed}}/></div><span>{b.label}</span></div>)}</div>{data.stats.totals.completed+data.stats.totals.failed===0&&<p className="dashboard-empty">За этот период сохранённых завершённых попыток нет.</p>}</>:<p className="dashboard-empty">{updating?'Загружаем статистику…':'Статистика недоступна.'}</p>}
      <details className="dashboard-history-details" id="dashboard-attempts" open={historyExpanded} onToggle={event=>setHistoryExpanded(event.currentTarget.open)}><summary>Последние попытки и точные значения графика</summary><div className="dashboard-switch mt-4" role="group" aria-label="Результат попытки">{[['all','Все'],['completed','Успешные'],['failed','Ошибки']].map(([value,label])=><button key={value} aria-pressed={outcome===value} onClick={()=>setOutcome(value)}>{label}</button>)}</div>
      {matchingHistory&&<><div className="dashboard-list">{data.recent.map(r=><div className="dashboard-row" key={r.id}><div className="min-w-0"><strong>{r.task.project?.name||r.task.url||'Задача'}</strong><p>{r.status==='completed'?'Успешно':'Ошибка'} · {date(r.completedAt)}{r.errorCode?` · ${errorLabels[r.errorCode]||r.errorCode}`:''}</p></div><Link className="dashboard-action" href={`/tasks/${r.taskId}/live/`}>Задача<ArrowRight size={14}/></Link></div>)}{!data.recent.length&&<p className="dashboard-empty">Нет попыток с выбранным результатом.</p>}</div><div className="dashboard-chart-values"><table><caption>Значения графика</caption><thead><tr><th>Время</th><th>Успешно</th><th>Ошибки</th></tr></thead><tbody>{data.stats.buckets.map(b=><tr key={b.at}><td>{b.label}</td><td>{b.completed}</td><td>{b.failed}</td></tr>)}</tbody></table></div></>}
      <p className="field-help mt-4">Показаны последние 20 записей выбранного периода. Ручные остановки и записи без времени завершения не учитываются. Удалённые задачи не входят в сохранённую историю.</p></details>
    </section>
    <section className="panel dashboard-resources"><div className="panel-heading"><div><h2>Ресурсы для запуска</h2><p>Готовые профили и включённые прокси</p></div></div><div className="dashboard-resource-grid"><Link href="/profiles/"><Users size={18}/><div><strong>{data?data.resources.freeProfiles.toLocaleString('ru-RU'):'—'}</strong><span>Готовы и не заняты</span><small>Профиль может быть уже использован в конкретном проекте</small></div><ArrowRight size={15}/></Link><Link href="/proxies/"><Network size={18}/><div><strong>{data?data.resources.targetProxies.toLocaleString('ru-RU'):'—'}</strong><span>Прокси для задач включены</span><small>Всего включено: {data?.resources.enabledProxies??'—'}. Соединение проверяется перед запуском</small></div><ArrowRight size={15}/></Link></div>
      {data&&(data.resources.freeProfiles===0||data.resources.targetProxies===0)&&<p className="dashboard-resource-warning">{data.resources.freeProfiles===0?'Нет свободных готовых профилей. ':''}{data.resources.targetProxies===0?'Нет включённых прокси для задач. ':''}Новые выполнения будут ожидать ресурсы.</p>}
    </section>
  </div>;
}
