"use client";
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { projectRequest as api } from '@/lib/projects';
import { sessionErrorMessage } from '@/lib/profile-readiness';
type Summary = { runs:number; passed:number; failed:number; stopped:number; unknown:number; successRate:number|null; actions:number; noEffect:number; noEffectRate:number|null; storageChecks:number; restoreRate:number|null; durationSamples:number; p50Ms:number|null; p95Ms:number|null; preparedSamples:number; preparationP50Ms:number|null; reasons:{reason:string;count:number}[] };
type Data = { summary:Summary; breakdown:Record<string,(Summary & {value:string})[]>; domains:{domain:string;visits:number;passed:number;partial:number;failed:number;p50Ms:number|null}[]; since:string;until:string;eventsCount:number;truncated:boolean;oldestEventAt:string|null };
const rate = (v:number|null) => v===null?'—':`${v}%`;
const time = (v:number|null) => v===null?'—':`${(v/60000).toLocaleString('ru-RU',{maximumFractionDigits:1})} мин`;
const valueName = (v:string) => ({unknown:'Нет данных',standard:'Стандартная подготовка',storage:'Сохранение состояния',revisit:'Повторное посещение',navigation:'Мобильная навигация',verification:'Проверка готовности',legacy:'Прежний план',snapshot:'Снимок',persistent:'Постоянный каталог'}[v]||v);
export function WarmupStatistics(){
  const [data,setData]=useState<Data|null>(null),[days,setDays]=useState('7'),[group,setGroup]=useState('release'),[version,setVersion]=useState(0),[error,setError]=useState('');
  useEffect(()=>{let active=true;setData(null);setError('');api<Data>(`/api/profiles/statistics/?days=${days}`).then(d=>{if(active)setData(d);}).catch(e=>{if(active)setError(e instanceof Error?e.message:'Ошибка загрузки');});return()=>{active=false;};},[days,version]);
  const s=data?.summary;
  return <section className="panel space-y-4 p-4 sm:p-5" aria-label="Эффективность подготовки">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-semibold">Эффективность подготовки</h2><p className="text-sm text-muted-foreground">Результаты текущего пула: этапы, восстановление и взаимодействия. Удалённые профили не учитываются.</p></div><div className="flex gap-2"><select aria-label="Период статистики" className="rounded-md border bg-background px-3" value={days} onChange={e=>setDays(e.target.value)}><option value="1">Сутки</option><option value="7">7 дней</option><option value="30">30 дней</option></select><Button variant="outline" onClick={()=>setVersion(v=>v+1)}>Обновить</Button></div></div>
    {error&&<p role="alert">{error}</p>}{!data&&!error&&<p role="status">Загрузка статистики…</p>}
    {data&&s&&<>
      <p className="text-xs text-muted-foreground">На {new Date(data.until).toLocaleString('ru-RU')} · событий: {data.eventsCount}. Старые записи без измерений показываются как «Нет данных».</p>
      {data.truncated&&<p role="status" className="text-sm text-amber-300">Показана неполная выборка: последние 20 000 событий с {data.oldestEventAt?new Date(data.oldestEventAt).toLocaleString('ru-RU'):'—'}. Для сравнения уменьшите период. Запуски на границе выборки могут быть неполными.</p>}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{[
        ['Успешные этапы',rate(s.successRate),`${s.passed} из ${s.passed+s.failed} завершённых`],
        ['Восстановление состояния',rate(s.restoreRate),`проверок после перезапуска: ${s.storageChecks}`],
        ['Без подтверждённого действия',rate(s.noEffectRate),`${s.noEffect} из ${s.actions}; граница прокрутки исключена из неудач`],
        ['Длительность запуска',time(s.p50Ms),`95-й процентиль: ${time(s.p95Ms)} · n=${s.durationSamples}`],
      ].map(([label,value,note])=><div key={label} className="rounded-lg border p-3"><p className="text-sm">{label}</p><p className="mt-2 text-2xl font-semibold">{value}</p><p className="mt-1 text-xs text-muted-foreground">{note}</p></div>)}</div>
      <p className="text-sm">Время от создания до готовности, медиана: {time(s.preparationP50Ms)} · завершённых подготовок: {s.preparedSamples}. Остановлено: {s.stopped}; без подтверждённого завершения: {s.unknown}.</p>
      <label className="flex flex-wrap items-center gap-2 text-sm">Сравнить по<select aria-label="Группировка статистики" className="rounded-md border bg-background p-2" value={group} onChange={e=>setGroup(e.target.value)}>{[['release','Релизу'],['model','Модели устройства'],['storageMode','Режиму хранения'],['preset','Плану подготовки']].map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
      <div className="max-w-full overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr>{['Группа','Запусков','Успех / завершено','Медиана','95-й процентиль'].map(t=><th key={t} className="p-2">{t}</th>)}</tr></thead><tbody>{(data.breakdown[group]||[]).map(row=><tr key={row.value} className="border-t"><td className="max-w-64 break-words p-2">{valueName(row.value)}</td><td className="p-2">{row.runs}</td><td className="p-2">{rate(row.successRate)} · {row.passed}/{row.passed+row.failed}</td><td className="p-2">{time(row.p50Ms)}</td><td className="p-2">{time(row.p95Ms)}</td></tr>)}</tbody></table></div>
      <details><summary className="cursor-pointer text-sm font-medium">Результаты по сайтам ({data.domains.length})</summary><div className="mt-3 max-h-96 overflow-auto"><table className="w-full text-left text-sm"><thead><tr>{['Сайт','Посещений','Успешно','Частично','Ошибки'].map(t=><th key={t} className="p-2">{t}</th>)}</tr></thead><tbody>{data.domains.map(row=><tr key={row.domain} className="border-t"><td className="max-w-64 break-all p-2">{row.domain}</td><td className="p-2">{row.visits}</td><td className="p-2">{row.passed}</td><td className="p-2">{row.partial}</td><td className="p-2">{row.failed}</td></tr>)}</tbody></table></div></details>
      <details><summary className="cursor-pointer text-sm font-medium">Причины неудачных запусков</summary><ul className="mt-2 space-y-2 text-sm">{s.reasons.map(r=><li key={r.reason}>{sessionErrorMessage(r.reason)} · {r.count}</li>)}{!s.reasons.length&&<li>За выбранный период причин ошибок не записано.</li>}</ul></details>
    </>}
  </section>;
}
