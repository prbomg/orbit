"use client";
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { projectRequest as api } from '@/lib/projects';
type Config = {fingerprintMode:string;fingerprintDevicePreset:string;fingerprintDeviceWeights:Record<string,number>;fingerprintLocale:string;fingerprintTimezone:string};
type Preview = {scope:string;count:number;checked:number;passed:number;catalogVersion:string;locale:string;timezone:string;models:{id:string;name:string;os:string;count:number}[];errors:{code:string;count:number}[];plan:{label:string;sitesPerSession:number;sessionMinutes:number};note:string};
export function ProfileGenerationPreview({config,disabled}:{config:Config;disabled:boolean}) {
 const [count,setCount]=useState('100'),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [result,setResult]=useState<{key:string;data:Preview}|null>(null);
 const body={count:Number(count),fingerprintMode:config.fingerprintMode,fingerprintDevicePreset:config.fingerprintDevicePreset,fingerprintDeviceWeights:config.fingerprintDeviceWeights,fingerprintLocale:config.fingerprintLocale,fingerprintTimezone:config.fingerprintTimezone};
 const key=JSON.stringify(body),visible=result?.key===key?result.data:null;
 async function check(){setBusy(true);setError('');setResult(null);try{setResult({key,data:await api<Preview>('/api/profiles/preview/',{method:'POST',body:key})});}catch(e){setError(e instanceof Error?e.message:'Не удалось проверить конфигурацию');}finally{setBusy(false);}}
 return <section aria-label="Проверка генерации профилей" className="space-y-3 rounded-lg border p-4">
  <div><h3 className="font-medium">Предварительная проверка</h3><p className="field-help">Проверяет параметры этой формы и сохранённый план подготовки. Не создаёт профили.</p></div>
  <div className="flex flex-wrap items-end gap-3"><div className="grid gap-2"><Label htmlFor="preview-count">Размер тестовой партии</Label><Input id="preview-count" type="number" min={1} max={1000} step={1} value={count} onChange={e=>setCount(e.target.value)} className="w-36" /></div><Button type="button" variant="outline" disabled={disabled||busy||!Number.isInteger(Number(count))||Number(count)<1||Number(count)>1000} onClick={()=>void check()}>{busy?'Проверка…':'Проверить конфигурацию'}</Button></div>
  {error&&<p role="alert" className="text-sm">{error}</p>}
  {visible&&<div role="status" className="space-y-2 text-sm">
   <p>{visible.scope==='provider_unavailable'?'Параметры MobileProxy доступны только после ответа провайдера. Локальная выборка не выполнялась.':visible.scope==='local_fallback'?'Проверен только резервный локальный генератор. Состав профилей MobileProxy заранее неизвестен.':'Проверен локальный генератор.'}</p>
   {visible.checked>0&&<><p>Проверено: {visible.checked} · Успешно: {visible.passed}</p><ul className="space-y-1">{visible.models.map(m=><li key={m.id}>{m.name} · Android {m.os} — {m.count}</li>)}</ul></>}
   <p className="break-words">Каталог: {visible.catalogVersion} · {visible.locale} · {visible.timezone}</p>
   <p>Сохранённый план: {visible.plan.label}. Сайтов за сессию: {visible.plan.sitesPerSession}; длительность: {visible.plan.sessionMinutes} мин.</p>
   {visible.errors.map(e=><p key={e.code}>{e.code}: {e.count}</p>)}<p className="field-help">{visible.note}</p>
  </div>}
 </section>;
}
