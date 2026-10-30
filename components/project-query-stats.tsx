"use client";
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { projectRequest } from '@/lib/projects';
import type { VisitStats } from '@/utils/projectVisits';
const periods=[['today','Сегодня'],['yesterday','Вчера'],['week','7 дней'],['month','30 дней'],['all','Всё время'],['custom','Свои даты']];
const dateLabel=(value:string)=>new Date(`${value}T12:00:00Z`).toLocaleDateString('ru-RU');
export function ProjectQueryStats({projectId}:{projectId:string}){
 return <QueryStats endpoint={`/api/projects/${projectId}/visits/`} />;
}
export function TaskQueryStats({taskId}:{taskId:string}){
 return <QueryStats key={taskId} endpoint={`/api/tasks/${taskId}/visits/`} taskScope />;
}
function QueryStats({endpoint,taskScope=false}:{endpoint:string;taskScope?:boolean}){
 const today=new Date(Date.now()+3*3600000).toISOString().slice(0,10);
 const [filters,setFilters]=useState({period:taskScope?'all':'today',from:today,to:today});
 const [from,setFrom]=useState(today),[to,setTo]=useState(today);
 const [data,setData]=useState<VisitStats|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true);
 useEffect(()=>{
  const controller=new AbortController();let seq=0;
  setLoading(true);setData(null);setError('');
  const load=()=>{const current=++seq;const query=new URLSearchParams({period:filters.period,...(filters.period==='custom'?{from:filters.from,to:filters.to}:{})});
   void projectRequest<VisitStats>(`${endpoint}?${query}`,{signal:controller.signal}).then(next=>{if(!controller.signal.aborted&&seq===current){setData(next);setError('');setLoading(false);}}).catch(e=>{if(!controller.signal.aborted&&seq===current){setError(e.message||'Не удалось загрузить переходы');setLoading(false);}});
  };load();const timer=setInterval(()=>{if(document.visibilityState==='visible')load();},15000);
  return()=>{controller.abort();clearInterval(timer);};
 },[endpoint,filters]);
 return <section className="panel my-6" aria-label="Переходы по запросам">
  <div className="panel-heading"><h2>Переходы по запросам</h2><span className="muted-label">Московское время · UTC+3</span></div>
  <div className="space-y-4 p-4 sm:p-6">
   {taskScope&&<p className="text-sm text-muted-foreground">Переходы только этого задания, по всем его сеансам. Обновление каждые 15 секунд.</p>}
   <div className="flex flex-wrap gap-2" aria-label="Период переходов">{periods.map(([period,label])=><Button size="sm" type="button" aria-pressed={filters.period===period} variant={filters.period===period?'default':'outline'} key={period} onClick={()=>{if(period==='custom'&&(!from||!to||from>to)){setError('Укажите начальную и конечную даты в правильном порядке.');return;}setFilters({period,from,to});}}>{label}</Button>)}</div>
   {filters.period==='custom'&&<form className="flex flex-wrap items-end gap-3" onSubmit={e=>{e.preventDefault();if(!from||!to||from>to){setError('Начальная дата не должна быть позже конечной.');return;}setFilters({period:'custom',from,to});}}><label className="grid min-w-0 gap-1 text-sm">С даты<Input aria-label="С даты" type="date" value={from} max={to||undefined} onChange={e=>setFrom(e.target.value)} required/></label><label className="grid min-w-0 gap-1 text-sm">По дату включительно<Input aria-label="По дату включительно" type="date" value={to} min={from||undefined} onChange={e=>setTo(e.target.value)} required/></label><Button type="submit">Применить</Button></form>}
   {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
   {data&&<><p className="text-sm text-muted-foreground">{data.window.from&&data.window.to?`${dateLabel(data.window.from)} — ${dateLabel(data.window.to)}, включительно`:'За всё время'}</p><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><div className="rounded-lg border p-3"><p className="text-sm text-muted-foreground">Всего переходов</p><p className="text-2xl font-semibold">{data.total}</p></div><div className="rounded-lg border p-3"><p className="text-sm text-muted-foreground">По сохранённым запросам</p><p className="text-2xl font-semibold">{data.search}</p></div><div className="rounded-lg border p-3"><p className="text-sm text-muted-foreground">С витальной частью</p><p className="text-2xl font-semibold">{data.refined}</p><p className="text-xs text-muted-foreground">Входят в общее число переходов</p></div><div className="rounded-lg border p-3"><p className="text-sm text-muted-foreground">Запросов с переходами</p><p className="text-2xl font-semibold">{data.items.filter(r=>r.kind==='search'&&r.count>0).length}</p></div></div></>}
   <p className="text-xs text-muted-foreground">Учитывается подтверждённое открытие сайта. Повторные загрузки и внутренние страницы не увеличивают счётчик. Переход после добавления витальной части учитывается один раз, у исходного запроса.</p>
   {data?.unknown ? <p className="text-xs text-amber-300">В старой истории выбранный запрос не сохранялся: {data.unknown} переходов показаны отдельно.</p>:null}
  </div>
  {loading&&!data?<p className="p-6 text-sm text-muted-foreground" role="status">Загрузка переходов…</p>:data?.items.length?<div className="overflow-x-auto"><table className="w-full table-fixed text-left text-sm"><thead><tr className="border-y text-muted-foreground"><th className="w-[50%] p-3 sm:p-4">Запрос</th><th className="w-[20%] p-3 text-right text-xs sm:p-4 sm:text-sm"><span className="sm:hidden">Число</span><span className="hidden sm:inline">Переходы</span></th><th className="p-3 text-xs sm:p-4 sm:text-sm">Последний переход</th></tr></thead><tbody>{data.items.map(row=><tr key={`${row.kind}:${row.query}`} className="border-b last:border-0"><td className="break-words p-3 sm:p-4">{row.kind==='direct'?'Прямые переходы':row.kind==='unknown'?'Запрос не сохранён':row.query}{row.kind==='search'&&row.count>0&&<div className="mt-2 space-y-2 text-xs text-muted-foreground"><p>Без уточнения: {row.plainCount}<br/>С витальной частью: {row.refinedCount}{row.refinementUnknownCount>0&&<><br/>Уточнение не сохранено: {row.refinementUnknownCount}</>}</p>{row.variants.length>0&&<details><summary className="cursor-pointer text-primary">Уточнённые запросы ({row.variants.length})</summary><ul className="mt-2 space-y-3">{row.variants.map(variant=><li key={variant.actualQuery} className="break-words"><p className="text-foreground">{variant.actualQuery}</p><p>Переходов: {variant.count}</p><p>Последний: {variant.lastVisitAt?new Date(variant.lastVisitAt).toLocaleString('ru-RU',{timeZone:'Europe/Moscow',dateStyle:'short',timeStyle:'short'}):'—'}</p></li>)}</ul></details>}</div>}</td><td className="p-3 text-right font-mono font-semibold sm:p-4">{row.count}</td><td className="p-3 text-xs text-muted-foreground sm:p-4">{row.lastVisitAt?new Date(row.lastVisitAt).toLocaleString('ru-RU',{timeZone:'Europe/Moscow',dateStyle:'short',timeStyle:'short'}):'—'}</td></tr>)}</tbody></table></div>:!error&&<p className="p-6 text-sm text-muted-foreground">За выбранный период переходов нет. Запросы появятся после добавления поисковых задач.</p>}
 </section>;
}
