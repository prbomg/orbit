"use client";
import type { DeviceTemplate } from "@/utils/deviceCatalog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
export function DeviceDistributionSettings({catalog,weights,revision,disabled,onChange}:{catalog:{version:string;templates:DeviceTemplate[]};weights:Record<string,number>;revision:number;disabled:boolean;onChange:(weights:Record<string,number>)=>void}){
 const total=Object.values(weights).reduce((sum,value)=>sum+value,0);
 return <fieldset className="min-w-0 space-y-3 rounded-lg border p-4" disabled={disabled}>
  <legend className="px-2 text-sm font-medium">Распределение новых локальных профилей</legend>
  <p className="field-help">Тестовые веса, а не статистика рынка. Ноль исключает шаблон. Доля вычисляется относительно суммы весов; фактическое число профилей может отличаться.</p>
  <p className="field-help">Каталог: {catalog.version} · версия сохранённого распределения: {revision}. Фиксированный пресет S23 имеет приоритет над весами. MobileProxy использует собственные параметры.</p>
  {catalog.templates.map(t=><div key={t.id} className="grid min-w-0 grid-cols-[minmax(0,1fr)_5rem_3.5rem] items-center gap-2 border-t pt-3">
   <div className="min-w-0"><Label htmlFor={`device-weight-${t.id}`}>{t.name} · Android {t.os}</Label><p className="field-help">{t.model} · {t.browser.width}×{t.browser.height} · DPR {t.browser.dpr}</p></div>
   <Input id={`device-weight-${t.id}`} aria-label={`Вес ${t.name} Android ${t.os}`} type="number" min={0} max={10000} step={1} required value={weights[t.id]??0} onChange={e=>onChange({...weights,[t.id]:Number(e.target.value)})}/>
   <span className="text-right text-xs tabular-nums">{total>0?((weights[t.id]||0)/total*100).toFixed(1):'0'}%</span>
  </div>)}
  {total<=0&&<p role="alert" className="text-sm text-destructive">Укажите положительный вес хотя бы для одной модели.</p>}
  <Button type="button" size="sm" variant="outline" onClick={()=>onChange(Object.fromEntries(catalog.templates.map(t=>[t.id,t.defaultWeight])))}>Вернуть исходные веса</Button>
  <details className="text-xs"><summary className="cursor-pointer">Источники и статус шаблонов</summary><div className="mt-3 space-y-4">{catalog.templates.map(t=><div key={t.id}><p className="font-medium">{t.name} · Android {t.os} · ревизия {t.revision}</p><p>{t.evidence.note}</p><p>Сведения проверены: {t.evidence.reviewedAt}. Измерение на физическом устройстве: {t.evidence.measuredAt||'не проводилось'}.</p>{t.evidence.sources.map(s=><a className="block break-words text-primary underline" key={s.url} href={s.url} target="_blank" rel="noreferrer">{s.scope}</a>)}</div>)}</div></details>
 </fieldset>;
}
